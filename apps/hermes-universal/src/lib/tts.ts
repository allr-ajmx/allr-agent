import { buildHermesWebSocketUrl, type GatewayWsConnection, resolveGatewayWsUrl } from '@/gateway'
import { speakText } from '@/hermes'
import { mintWsTicket } from '@/lib/auth'
import { atom } from '@/store/atom'
import type { Connection } from '@/store/connection'
import { $voiceOutputVolume } from '@/store/voice-prefs'
import { TerminalSocket } from '@/transport/terminal-socket'

// Text-to-speech playback. Two paths, in preference order:
//
//  1. STREAMING — `WS /api/audio/speak-stream`. Text frames go up as the reply
//     is produced, raw int16 PCM comes back down, and each chunk is scheduled
//     back-to-back through one AudioContext. Speech begins on the provider's
//     first chunk instead of after full synthesis + base64 transfer.
//  2. DATA URL — `speakText` returns a whole clip as a base64 data-URL the
//     webview plays through an <audio> element. Used when the stream is
//     unavailable (no connection, no Web Audio, old backend) or when the server
//     answers `{"type":"fallback"}` because the configured provider has no
//     chunked API.
//
// One utterance plays at a time; a new speak (or stopSpeaking) interrupts the
// previous one on BOTH paths.
//
// The user's output volume (`$voiceOutputVolume`, Settings → Voice) has to be
// applied on BOTH of them or it is a slider that does nothing for the consumer
// that matters: the voice-conversation loop goes through `speakUntilDone`, which
// tries the STREAMING path first and only falls back to `<audio>`. On the stream
// there is no media element to set `.volume` on, so a master GainNode sits
// between every scheduled chunk and the destination.
export const $ttsSpeaking = atom(false)

/** How a `speakUntilDone` playback ended. */
export type SpeechEnd = 'ended' | 'stopped' | 'error' | 'skipped'

let current: HTMLAudioElement | null = null
// The resolver for the in-flight `speakUntilDone`, settled exactly once when the
// clip ends, errors, or is interrupted by stopSpeaking / a new clip. Kept beside
// `current` so an interruption never leaves a caller awaiting forever — which is
// exactly the "loop goes deaf" failure mode barge-in would otherwise reintroduce.
let pendingEnd: ((result: SpeechEnd) => void) | null = null
// The streaming path's kill switch, registered by the live session. Same role as
// `current` for the <audio> path: stopSpeaking has to reach both.
let currentStreamStop: (() => void) | null = null

function settleEnd(result: SpeechEnd): void {
  const resolve = pendingEnd
  pendingEnd = null
  resolve?.(result)
}

export function stopSpeaking(): void {
  // Kill the socket first (the server aborts synthesis on disconnect) and the
  // AudioContext with it, so barge-in cuts sound immediately rather than after
  // the already-scheduled chunks drain.
  const stopStream = currentStreamStop
  currentStreamStop = null
  stopStream?.()

  if (current) {
    current.pause()
    current.src = ''
    current = null
  }

  $ttsSpeaking.set(false)
  settleEnd('stopped')
}

// ---------------------------------------------------------------------------
// Streaming path — /api/audio/speak-stream
// ---------------------------------------------------------------------------

const SPEAK_STREAM_PATH = '/api/audio/speak-stream'
/** What the backend synthesises at unless its `start` frame says otherwise. */
const DEFAULT_SAMPLE_RATE = 24_000
/** Lead-in on the very first chunk, absorbing decode/scheduling jitter so the
 *  opening syllable isn't clipped. */
const SCHEDULE_LEAD_S = 0.05
/** Slack after the last scheduled sample before declaring the reply spoken. */
const DRAIN_GRACE_MS = 100

type AudioContextCtor = new () => AudioContext

/** Web Audio, or null where there is none — vitest/jsdom, or any webview that
 *  doesn't expose it. WebKitGTK (Tauri's Linux webview) has the unprefixed
 *  constructor; the prefixed one is kept for older WebKit surfaces. */
function audioContextCtor(): AudioContextCtor | null {
  const scope = globalThis as unknown as {
    AudioContext?: AudioContextCtor
    webkitAudioContext?: AudioContextCtor
  }

  return scope.AudioContext ?? scope.webkitAudioContext ?? null
}

/** Build the WS URL for `/api/audio/speak-stream`, reusing the gateway's
 *  none/token/ticket/oauth auth exactly. Mirrors `resolveTerminalWsUrl`
 *  (store/gateway-config.ts) — only the path and the `profile` param differ.
 *  The backend resolves the TTS provider chain from that profile's config. */
async function resolveSpeakStreamUrl(conn: Connection): Promise<string> {
  const u = new URL(conn.baseUrl)
  const params: Record<string, string> = conn.profile ? { profile: conn.profile } : {}

  const build = (authParam?: readonly [string, string]): string =>
    buildHermesWebSocketUrl({ protocol: u.protocol, host: u.host, path: SPEAK_STREAM_PATH, authParam, params })

  switch (conn.authMode) {
    case 'none':
      return build()

    case 'token':
      return conn.token ? build(['token', conn.token]) : build()
    case 'oauth': {
      const mint = { getGatewayWsUrl: async () => build(['ticket', await mintWsTicket(conn.baseUrl)]) }
      const wsConn: GatewayWsConnection = { authMode: 'oauth', profile: conn.profile ?? null, wsUrl: build() }

      return resolveGatewayWsUrl(mint, wsConn)
    }

    case 'ticket':

    default:
      return build(['ticket', await mintWsTicket(conn.baseUrl)])
  }
}

export interface SpeechStreamSession {
  /** Feed more reply text as it streams in. Safe after `finish` (no-op). */
  append: (text: string) => void
  /** No more text coming — resolves `done` once the audio drains. */
  finish: () => void
  /**
   * 'done'     — audio played to the end (or was barged by stopSpeaking).
   * 'fallback' — no audio was ever produced; the caller should speak the text
   *              through the data-URL path instead.
   */
  done: Promise<'done' | 'fallback'>
}

/**
 * Open a live speech session: one WebSocket + one AudioContext for a whole
 * reply. Text is appended as it arrives; the server cuts sentences and streams
 * PCM back while generation continues, so speech overlaps the text stream with
 * no per-sentence connection or synthesis gap.
 *
 * The socket is the Rust-backed `TerminalSocket`, not a browser `WebSocket`:
 * the packaged webview's CSP allows `connect-src 'self' ipc:` only, so every
 * socket in this app is dialled from Rust. It is also the one transport here
 * that surfaces binary frames.
 */
function openSpeechStream(wsUrl: string, AudioCtor: AudioContextCtor): SpeechStreamSession {
  let socket: TerminalSocket | null = null
  let context: AudioContext | null = null
  // One master gain for the whole reply, built with the context on the `start`
  // frame and reused by every chunk — the streaming equivalent of `<audio>.volume`.
  let master: GainNode | null = null
  let streamRate = DEFAULT_SAMPLE_RATE
  let nextStartAt = 0
  let carry: Uint8Array | null = null
  let open = false
  let started = false
  let settled = false
  let finished = false
  // TerminalSocket drops anything sent before its Rust side reports open, so
  // outbound frames wait here rather than being lost.
  const pendingSends: string[] = []

  let settle: (value: 'done' | 'fallback') => void = () => undefined

  const done = new Promise<'done' | 'fallback'>(resolve => {
    settle = value => {
      if (settled) {
        return
      }

      settled = true

      if (currentStreamStop === stop) {
        currentStreamStop = null
      }

      try {
        socket?.close()
      } catch {
        // already closed
      }

      socket = null
      void context?.close().catch(() => undefined)
      context = null
      master = null
      resolve(value)
    }
  })

  // stopSpeaking() → immediate barge-in. Whatever played counts as played, so
  // the caller never re-speaks it through the data-URL path.
  const stop = () => settle('done')
  currentStreamStop = stop

  const send = (frame: object) => {
    const data = JSON.stringify(frame)

    if (open && socket) {
      socket.sendText(data)
    } else if (!settled) {
      pendingSends.push(data)
    }
  }

  // Resolve only once the audio already handed to the device has actually been
  // heard. With nothing ever scheduled there is no playback to preserve, so the
  // caller is sent to the data-URL path instead of being told it spoke.
  const finishWhenDrained = () => {
    if (!started) {
      settle('fallback')

      return
    }

    const remainingMs = context ? Math.max(0, nextStartAt - context.currentTime) * 1_000 : 0

    setTimeout(() => settle('done'), remainingMs + DRAIN_GRACE_MS)
  }

  const schedule = (chunk: Uint8Array) => {
    if (!context || settled) {
      return
    }

    // Provider chunks are not sample-aligned — carry any odd trailing byte over
    // to the head of the next one, or the whole stream shifts by a byte and
    // turns into noise.
    let bytes = chunk

    if (carry) {
      const joined = new Uint8Array(carry.length + bytes.length)
      joined.set(carry)
      joined.set(bytes, carry.length)
      bytes = joined
      carry = null
    }

    const usable = bytes.length - (bytes.length % 2)

    if (bytes.length !== usable) {
      carry = bytes.slice(usable)
    }

    if (!usable) {
      return
    }

    const samples = usable / 2
    // DataView, not Int16Array: the wire format is explicitly little-endian, and
    // a view needs no 2-byte alignment of the incoming buffer's byteOffset.
    const view = new DataView(bytes.buffer, bytes.byteOffset, usable)
    const buffer = context.createBuffer(1, samples, streamRate)
    const channel = buffer.getChannelData(0)

    for (let index = 0; index < samples; index += 1) {
      channel[index] = view.getInt16(index * 2, true) / 32_768
    }

    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(master ?? context.destination)

    const startAt = Math.max(context.currentTime + SCHEDULE_LEAD_S, nextStartAt)
    source.start(startAt)
    nextStartAt = startAt + buffer.duration

    if (!started) {
      started = true
      $ttsSpeaking.set(true)
    }
  }

  const handleFrame = (text: string) => {
    let frame: { sample_rate?: number; type?: string }

    try {
      frame = JSON.parse(text) as typeof frame
    } catch {
      return
    }

    if (frame.type === 'start') {
      streamRate = frame.sample_rate || DEFAULT_SAMPLE_RATE
      context = new AudioCtor()
      master = context.createGain()
      master.gain.value = $voiceOutputVolume.get()
      master.connect(context.destination)

      // A voice turn started by the wake word has no preceding user gesture, so
      // the autoplay policy can hand back a suspended context. Resume it or the
      // reply buffers silently.
      if (context.state === 'suspended') {
        void context.resume().catch(() => undefined)
      }

      carry = null
      nextStartAt = 0
    } else if (frame.type === 'end') {
      finishWhenDrained()
    } else if (frame.type === 'fallback') {
      // The provider has no chunked API. Anything already scheduled still plays.
      settle(started ? 'done' : 'fallback')
    }
  }

  socket = new TerminalSocket(wsUrl, {
    onBinary: bytes => schedule(bytes),
    // A drop before any audio means the endpoint is unavailable (old backend,
    // auth, network) → fall back. After audio started, re-speaking the whole
    // message over POST would stutter — treat what played as the playback.
    onClose: () => (started ? finishWhenDrained() : settle('fallback')),
    onError: () => settle(started ? 'done' : 'fallback'),
    onOpen: () => {
      open = true
      pendingSends.splice(0).forEach(data => socket?.sendText(data))
    },
    onText: handleFrame
  })

  return {
    // Raw text — the server strips markdown/emoji per *sentence*, the only safe
    // granularity when a construct spans two appends.
    append: text => {
      if (text && !finished && !settled) {
        send({ text })
      }
    },
    finish: () => {
      if (!finished && !settled) {
        finished = true
        send({ done: true })
      }
    },
    done
  }
}

/**
 * Open a live speech session for an in-progress reply: `append` text as it
 * arrives, `finish` when it's complete, await `done`. Resolves null when
 * streaming is unavailable (not connected, no Web Audio, unresolvable URL) —
 * the caller falls back to the whole-text data-URL path.
 */
export async function startSpeechStream(): Promise<SpeechStreamSession | null> {
  // `store/connection` is imported LAZILY, and only here. It is a heavy module —
  // importing it eagerly wires its reconnect loop into the graph of every file
  // that speaks (the event router, the chat store), which broke suites that mock
  // `@/store/gateway` without `$gatewayState` and puts `lib/tts` one hop from a
  // cycle. Nothing else in this file needs a connection.
  const { $connection } = await import('@/store/connection')
  const conn = $connection.get()
  const AudioCtor = audioContextCtor()

  if (!conn || !AudioCtor) {
    return null
  }

  let wsUrl: string

  try {
    wsUrl = await resolveSpeakStreamUrl(conn)
  } catch {
    // A ticket mint failing means the session expired; speaking is not the place
    // to raise that, so degrade to the POST path (which re-auths on its own).
    return null
  }

  stopSpeaking()

  return openSpeechStream(wsUrl, AudioCtor)
}

/**
 * Speak complete text over the stream. Resolves the SpeechEnd once the audio
 * has drained or been interrupted, or null when the stream produced no audio at
 * all and the caller should take the data-URL path.
 */
async function speakStreamed(text: string): Promise<SpeechEnd | null> {
  const session = await startSpeechStream()

  if (!session) {
    return null
  }

  const end = new Promise<SpeechEnd>(resolve => {
    pendingEnd = resolve
  })

  const resolver = pendingEnd

  session.append(text)
  session.finish()

  const outcome = await session.done

  if (outcome === 'fallback') {
    // Nothing played. `end` is dropped unobserved; the data-URL path's own
    // stopSpeaking settles this stale resolver on its way in.
    return null
  }

  // Only touch shared state if we're still the current utterance: a stop or a
  // newer speak already settled `end` (with 'stopped') and owns the flag now.
  if (pendingEnd === resolver) {
    $ttsSpeaking.set(false)
    settleEnd('ended')
  }

  return end
}

/**
 * Begin data-URL playback and return a promise that resolves the moment the clip
 * *starts* (or bails on empty/error), alongside a `done` promise that resolves
 * when it *finishes*. Splitting the two is the whole point: callers that must
 * wait for the clip to end (the voice-conversation loop) await `done`; callers
 * that only need playback to have begun (`speakNow`) drop it.
 */
async function startPlayback(text: string): Promise<{ done: Promise<SpeechEnd>; failure: unknown }> {
  const trimmed = text.trim()

  if (!trimmed || typeof Audio === 'undefined') {
    return { done: Promise.resolve('skipped'), failure: null }
  }

  stopSpeaking()

  try {
    const res = await speakText(trimmed)

    if (!res.ok || !res.data_url) {
      // Reached the backend and came back with no audio — an unconfigured or
      // failing TTS provider. NOT 'skipped': see the `failure` note below.
      return { done: Promise.resolve('error'), failure: new Error('speech synthesis returned no audio') }
    }

    const audio = new Audio(res.data_url)
    audio.volume = $voiceOutputVolume.get()
    current = audio
    $ttsSpeaking.set(true)

    const done = new Promise<SpeechEnd>(resolve => {
      pendingEnd = resolve
    })

    const finish = (result: SpeechEnd) => {
      if (current === audio) {
        current = null
        $ttsSpeaking.set(false)
      }

      settleEnd(result)
    }

    audio.onended = () => finish('ended')
    audio.onerror = () => finish('error')
    await audio.play().catch(() => finish('error'))

    return { done, failure: null }
  } catch (error) {
    stopSpeaking()

    return { done: Promise.resolve('error'), failure: error }
  }
}

/** Resolves once playback has begun. Unchanged timing — three other consumers
 * (read-aloud, auto-speak, the store's message.complete) depend on it, so this
 * deliberately stays on the whole-clip path: "begun" on the streaming path would
 * mean awaiting the first PCM chunk.
 *
 * THROWS when synthesis failed (MJXHRM-369). It used to swallow every failure
 * and resolve exactly as it does on success, which made the read-aloud button
 * flash "Preparing…" and go quietly idle when the gateway had no TTS provider
 * configured — and made the `catch → notifyError` its two callers already had
 * unreachable. Empty text and a webview with no `Audio` still resolve silently:
 * those are "nothing to play", not a failure. */
export async function speakNow(text: string): Promise<void> {
  const { failure } = await startPlayback(text)

  if (failure) {
    throw failure
  }
}

/** Resolves when the clip finishes, is interrupted (`stopSpeaking` / a newer
 * clip), errors, or never started. Never rejects. Streams when it can. */
export async function speakUntilDone(text: string): Promise<SpeechEnd> {
  const trimmed = text.trim()

  if (!trimmed) {
    return 'skipped'
  }

  const streamed = await speakStreamed(trimmed)

  if (streamed) {
    return streamed
  }

  const { done } = await startPlayback(trimmed)

  return done
}
