import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Connection } from '@/store/connection'
import type { TerminalSocketHandlers } from '@/transport/terminal-socket'

// `vi.mock` factories run while the mocked module is being imported — i.e.
// before any top-level class declaration in this file has been evaluated — so
// the socket double has to be built inside `vi.hoisted` to exist by then.
const { connectionRef, FakeSocket, mintWsTicket, speakText } = vi.hoisted(() => {
  // The Rust-backed socket is the seam: tests drive the handlers directly
  // instead of standing up ws_open/listen over a fake Tauri IPC.
  class FakeSocketImpl {
    static last: FakeSocketImpl | null = null
    static count = 0
    readonly sent: string[] = []
    closed = 0

    constructor(
      readonly url: string,
      readonly handlers: TerminalSocketHandlers
    ) {
      FakeSocketImpl.last = this
      FakeSocketImpl.count += 1
    }

    sendText(text: string): void {
      this.sent.push(text)
    }

    close(): void {
      this.closed += 1
    }
  }

  return {
    connectionRef: { value: null as unknown },
    FakeSocket: FakeSocketImpl,
    mintWsTicket: vi.fn(async () => 'TICKET'),
    speakText: vi.fn<(text: string) => Promise<{ ok: boolean; data_url?: string }>>(async () => ({
      ok: true,
      data_url: 'data:audio/mp3;base64,AAAA'
    }))
  }
})

vi.mock('@/hermes', () => ({ speakText }))
vi.mock('@/lib/auth', () => ({ mintWsTicket }))
// Only `.get()` is used, and mocking it keeps the whole connect/ssh/oauth store
// graph out of a unit test for playback.
vi.mock('@/store/connection', () => ({ $connection: { get: () => connectionRef.value } }))
vi.mock('@/transport/terminal-socket', () => ({ TerminalSocket: FakeSocket }))

import { $ttsSpeaking, speakUntilDone, stopSpeaking } from './tts'

// jsdom's HTMLMediaElement.play throws "Not implemented"; stub Audio with a fake
// whose end/error we can trigger, and that captures the latest instance.
class FakeAudio {
  static last: FakeAudio | null = null
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  src = ''

  constructor(public readonly dataUrl?: string) {
    FakeAudio.last = this
  }

  play(): Promise<void> {
    return Promise.resolve()
  }

  pause(): void {}
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))
/** Long enough to cover the drain timer (scheduling lead + grace). */
const drain = () => new Promise(resolve => setTimeout(resolve, 250))

describe('speakUntilDone', () => {
  beforeEach(() => {
    speakText.mockClear()
    speakText.mockResolvedValue({ ok: true, data_url: 'data:audio/mp3;base64,AAAA' })
    FakeAudio.last = null
    vi.stubGlobal('Audio', FakeAudio)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("resolves 'ended' when the clip finishes", async () => {
    const promise = speakUntilDone('hello there')
    await flush()
    expect(FakeAudio.last).not.toBeNull()

    FakeAudio.last?.onended?.()
    await expect(promise).resolves.toBe('ended')
  })

  it("resolves 'stopped' when interrupted mid-playback (barge-in)", async () => {
    const promise = speakUntilDone('a long reply')
    await flush()

    stopSpeaking()
    await expect(promise).resolves.toBe('stopped')
  })

  it("resolves 'skipped' for empty text without touching the network", async () => {
    await expect(speakUntilDone('   ')).resolves.toBe('skipped')
    expect(speakText).not.toHaveBeenCalled()
  })

  it("resolves 'skipped' when the TTS backend returns no audio", async () => {
    speakText.mockResolvedValueOnce({ ok: false })
    await expect(speakUntilDone('hello')).resolves.toBe('skipped')
  })
})

// ---------------------------------------------------------------------------
// Streaming path
// ---------------------------------------------------------------------------

class FakeAudioContext {
  static last: FakeAudioContext | null = null
  /** What the next constructed context reports — the autoplay policy hands back
   *  'suspended' when playback wasn't started by a user gesture. */
  static nextState = 'running'
  /** Every chunk handed to Web Audio, in schedule order. */
  readonly rendered: Float32Array[] = []
  readonly startedAt: number[] = []
  state = FakeAudioContext.nextState
  currentTime = 0
  destination = {}
  closed = 0
  resumed = 0

  constructor() {
    FakeAudioContext.last = this
  }

  createBuffer(_channels: number, length: number, rate: number) {
    const data = new Float32Array(length)
    this.rendered.push(data)

    return { duration: length / rate, getChannelData: () => data }
  }

  createBufferSource() {
    const ctx = this

    return {
      buffer: null as unknown,
      connect() {},
      start(at: number) {
        ctx.startedAt.push(at)
      }
    }
  }

  resume(): Promise<void> {
    this.resumed += 1

    return Promise.resolve()
  }

  close(): Promise<void> {
    this.closed += 1

    return Promise.resolve()
  }
}

const START_FRAME = JSON.stringify({ channels: 1, sample_rate: 24_000, type: 'start' })

function socket(): InstanceType<typeof FakeSocket> {
  const live = FakeSocket.last

  if (!live) {
    throw new Error('no speak-stream socket was opened')
  }

  return live
}

describe('speakUntilDone over /api/audio/speak-stream', () => {
  beforeEach(() => {
    speakText.mockClear()
    speakText.mockResolvedValue({ ok: true, data_url: 'data:audio/mp3;base64,AAAA' })
    mintWsTicket.mockClear()
    FakeAudio.last = null
    FakeSocket.last = null
    FakeSocket.count = 0
    FakeAudioContext.last = null
    connectionRef.value = { authMode: 'none', baseUrl: 'http://gw.example:8080', mode: 'remote' } satisfies Connection
    vi.stubGlobal('Audio', FakeAudio)
    vi.stubGlobal('AudioContext', FakeAudioContext)
  })

  afterEach(() => {
    stopSpeaking()
    connectionRef.value = null
    vi.unstubAllGlobals()
  })

  it('buffers the text/done frames until the socket opens, then speaks the PCM', async () => {
    const promise = speakUntilDone('hello there')
    await flush()

    expect(socket().url).toBe('ws://gw.example:8080/api/audio/speak-stream')
    // Nothing may be sent while the Rust side is still dialling — TerminalSocket
    // drops pre-open writes.
    expect(socket().sent).toEqual([])

    socket().handlers.onOpen()
    expect(socket().sent).toEqual([JSON.stringify({ text: 'hello there' }), JSON.stringify({ done: true })])

    socket().handlers.onText(START_FRAME)
    socket().handlers.onBinary(new Uint8Array([0x01, 0x02, 0x03, 0x04]))
    expect($ttsSpeaking.get()).toBe(true)

    socket().handlers.onText(JSON.stringify({ type: 'end' }))
    await drain()

    await expect(promise).resolves.toBe('ended')
    expect($ttsSpeaking.get()).toBe(false)
    expect(speakText).not.toHaveBeenCalled()
    // Barge-in seam released, and the socket + context torn down exactly once.
    expect(socket().closed).toBe(1)
    expect(FakeAudioContext.last?.closed).toBe(1)
  })

  it('re-aligns an odd trailing byte across chunk boundaries', async () => {
    const promise = speakUntilDone('carry')
    await flush()
    socket().handlers.onOpen()
    socket().handlers.onText(START_FRAME)

    // 3 bytes: one whole little-endian sample (0x0201) + a trailing 0x03 that
    // only becomes a sample once the next chunk supplies its high byte.
    socket().handlers.onBinary(new Uint8Array([0x01, 0x02, 0x03]))
    socket().handlers.onBinary(new Uint8Array([0x04]))

    const rendered = FakeAudioContext.last?.rendered ?? []
    expect(rendered.map(chunk => chunk.length)).toEqual([1, 1])
    expect(rendered[0][0]).toBeCloseTo(0x0201 / 32_768, 6)
    expect(rendered[1][0]).toBeCloseTo(0x0403 / 32_768, 6)

    // A lone odd byte is held, never rendered as a (wrong) sample.
    socket().handlers.onBinary(new Uint8Array([0x05]))
    expect(FakeAudioContext.last?.rendered.length).toBe(2)

    // Chunks are scheduled back-to-back from the lead-in, never overlapping.
    const [first, second] = FakeAudioContext.last?.startedAt ?? []
    expect(first).toBeCloseTo(0.05, 6)
    expect(second).toBeCloseTo(0.05 + 1 / 24_000, 6)

    stopSpeaking()
    await expect(promise).resolves.toBe('stopped')
  })

  it("falls back to the data-URL path on a {type:'fallback'} frame", async () => {
    const promise = speakUntilDone('no chunked provider')
    await flush()
    socket().handlers.onOpen()
    socket().handlers.onText(JSON.stringify({ type: 'fallback' }))
    await flush()

    expect(speakText).toHaveBeenCalledWith('no chunked provider')
    expect(socket().closed).toBe(1)

    FakeAudio.last?.onended?.()
    await expect(promise).resolves.toBe('ended')
  })

  it('falls back when the socket drops before any audio arrived', async () => {
    const promise = speakUntilDone('old backend')
    await flush()
    socket().handlers.onClose(1006)
    await flush()

    expect(speakText).toHaveBeenCalledWith('old backend')
    FakeAudio.last?.onended?.()
    await expect(promise).resolves.toBe('ended')
  })

  it('keeps what already played when the socket drops mid-stream (no re-speak)', async () => {
    const promise = speakUntilDone('half spoken')
    await flush()
    socket().handlers.onOpen()
    socket().handlers.onText(START_FRAME)
    socket().handlers.onBinary(new Uint8Array([0x01, 0x02]))
    socket().handlers.onError('connection reset')
    await drain()

    await expect(promise).resolves.toBe('ended')
    expect(speakText).not.toHaveBeenCalled()
  })

  it('settles exactly once when stopSpeaking barges in mid-stream, and ignores late frames', async () => {
    const promise = speakUntilDone('a long streamed reply')
    await flush()
    socket().handlers.onOpen()
    socket().handlers.onText(START_FRAME)
    socket().handlers.onBinary(new Uint8Array([0x01, 0x02, 0x03, 0x04]))
    expect($ttsSpeaking.get()).toBe(true)

    const live = socket()
    stopSpeaking()

    await expect(promise).resolves.toBe('stopped')
    expect($ttsSpeaking.get()).toBe(false)
    expect(live.closed).toBe(1)
    expect(FakeAudioContext.last?.closed).toBe(1)

    // Frames racing in after the barge-in must not reopen, re-settle, or push
    // the caller onto the data-URL path.
    live.handlers.onText(JSON.stringify({ type: 'end' }))
    live.handlers.onClose(1000)
    live.handlers.onBinary(new Uint8Array([0x09, 0x09]))
    stopSpeaking()
    await drain()

    expect(live.closed).toBe(1)
    expect(FakeAudioContext.last?.rendered.length).toBe(1)
    expect(speakText).not.toHaveBeenCalled()
  })

  it('resumes a context the autoplay policy handed back suspended', async () => {
    const promise = speakUntilDone('wake word turn')
    await flush()
    socket().handlers.onOpen()
    FakeAudioContext.nextState = 'suspended'
    socket().handlers.onText(START_FRAME)
    FakeAudioContext.nextState = 'running'

    expect(FakeAudioContext.last?.resumed).toBe(1)

    stopSpeaking()
    await expect(promise).resolves.toBe('stopped')
  })

  it('carries token auth and the profile scope into the URL', async () => {
    connectionRef.value = {
      authMode: 'token',
      baseUrl: 'https://gw.example',
      mode: 'local',
      profile: 'work',
      token: 'sekrit'
    } satisfies Connection

    const promise = speakUntilDone('scoped')
    await flush()

    expect(socket().url).toBe('wss://gw.example/api/audio/speak-stream?profile=work&token=sekrit')

    stopSpeaking()
    await promise
  })

  it('mints a fresh ws ticket for a gated backend', async () => {
    connectionRef.value = { authMode: 'ticket', baseUrl: 'https://gw.example', mode: 'remote' } satisfies Connection

    const promise = speakUntilDone('gated')
    await flush()

    expect(mintWsTicket).toHaveBeenCalledWith('https://gw.example')
    expect(socket().url).toBe('wss://gw.example/api/audio/speak-stream?ticket=TICKET')

    stopSpeaking()
    await promise
  })

  it('takes the data-URL path when a ticket mint fails', async () => {
    connectionRef.value = { authMode: 'ticket', baseUrl: 'https://gw.example', mode: 'remote' } satisfies Connection
    mintWsTicket.mockRejectedValueOnce(new Error('session expired'))

    const promise = speakUntilDone('expired')
    await flush()

    expect(FakeSocket.count).toBe(0)
    expect(speakText).toHaveBeenCalledWith('expired')
    FakeAudio.last?.onended?.()
    await expect(promise).resolves.toBe('ended')
  })

  it('takes the data-URL path with no connection or no Web Audio', async () => {
    connectionRef.value = null
    const offline = speakUntilDone('offline')
    await flush()
    expect(FakeSocket.count).toBe(0)
    expect(speakText).toHaveBeenCalledWith('offline')
    FakeAudio.last?.onended?.()
    await expect(offline).resolves.toBe('ended')

    connectionRef.value = { authMode: 'none', baseUrl: 'http://gw.example:8080' } satisfies Connection
    vi.stubGlobal('AudioContext', undefined)
    const silent = speakUntilDone('no web audio')
    await flush()
    expect(FakeSocket.count).toBe(0)
    expect(speakText).toHaveBeenCalledWith('no web audio')
    FakeAudio.last?.onended?.()
    await expect(silent).resolves.toBe('ended')
  })
})
