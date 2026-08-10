import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { TerminalSocketHandlers } from './terminal-socket'

// TerminalSocket is the one seam every binary frame crosses — PTY output for the
// terminal, int16 PCM for streaming TTS. What is under test is that a frame
// arrives BYTE-IDENTICAL, because both consumers reinterpret the bytes
// (`lib/tts.ts` as int16 samples, `transport/remote-pty.ts` as terminal output)
// and neither can tell a corrupted frame from a quiet one.
//
// The Tauri surface is faked at the module boundary: a `Channel` whose
// `onmessage` the test drives, an `invoke` that records its arguments, and a
// `listen` that hands back the callback so the legacy event path is drivable too.

const { channels, FakeChannel, invokeMock, listenMock, listeners } = vi.hoisted(() => {
  const channels: { onmessage: (message: unknown) => void }[] = []
  const listeners = new Map<string, (event: { payload: unknown }) => void>()

  class FakeChannel {
    onmessage: (message: unknown) => void = () => {}

    constructor() {
      channels.push(this)
    }
  }

  return {
    channels,
    FakeChannel,
    invokeMock: vi.fn(async () => undefined),
    listenMock: vi.fn(async (name: string, cb: (event: { payload: unknown }) => void) => {
      listeners.set(name, cb)

      return () => {}
    }),
    listeners
  }
})

vi.mock('@tauri-apps/api/core', () => ({ Channel: FakeChannel, invoke: invokeMock }))

vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }))

import { TerminalSocket } from './terminal-socket'

const URL = 'ws://gw.test/api/audio/speak-stream'

function handlers(): { calls: TerminalSocketHandlers; frames: Uint8Array[] } {
  const frames: Uint8Array[] = []

  return {
    calls: {
      onBinary: bytes => void frames.push(bytes),
      onClose: () => {},
      onError: () => {},
      onOpen: () => {},
      onText: () => {}
    },
    frames
  }
}

/** Construct the socket and wait for its async `init` to reach `ws_open`. */
async function connect(): Promise<{ frames: Uint8Array[]; socket: TerminalSocket }> {
  const { calls, frames } = handlers()
  const socket = new TerminalSocket(URL, calls)

  await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith('ws_open', expect.anything()))

  return { frames, socket }
}

/** The channel this socket created — asserted to exist so a wiring regression
 *  fails here rather than as a confusing undefined further down. */
function channel(): { onmessage: (message: unknown) => void } {
  expect(channels).toHaveLength(1)

  return channels[0]
}

beforeEach(() => {
  channels.length = 0
  listeners.clear()
  invokeMock.mockClear()
  listenMock.mockClear()
})

describe('TerminalSocket binary frames', () => {
  it('passes a binary channel to ws_open so bytes never cross IPC as JSON', async () => {
    await connect()

    const [, args] = invokeMock.mock.calls[0] as unknown as [string, Record<string, unknown>]

    expect(args.binaryChannel).toBe(channel())
    expect(args.url).toBe(URL)
  })

  it('delivers an ArrayBuffer from the channel to onBinary byte-identically', async () => {
    const { frames } = await connect()

    // Every byte value: nothing that a JSON/UTF-8 round trip would mangle
    // (0x00, 0x7f–0xff) gets to survive by luck.
    const everyByte = Uint8Array.from({ length: 256 }, (_, i) => i)

    channel().onmessage(everyByte.buffer)

    expect(frames).toHaveLength(1)
    expect([...frames[0]]).toEqual([...everyByte])
  })

  it('preserves zero-length and odd-length frames exactly', async () => {
    const { frames } = await connect()

    // tts.ts carries the trailing byte of an odd-length frame into the NEXT
    // frame, so a dropped or padded byte desynchronises int16 PCM for the rest
    // of the reply — and a swallowed empty frame would break the pairing too.
    const sent = [new Uint8Array(0), Uint8Array.of(0x01), Uint8Array.of(0x00, 0xff, 0x7f), Uint8Array.of(0xde, 0xad)]

    for (const bytes of sent) {
      channel().onmessage(bytes.buffer)
    }

    expect(frames.map(f => [...f])).toEqual(sent.map(f => [...f]))
  })

  it('still accepts the legacy number-array event from an older Rust core', async () => {
    const { frames } = await connect()

    // A packaged app can outlive its bundled Rust core across a JS-only update;
    // that core ignores `binaryChannel` and emits `ws://{id}/binary` instead.
    const legacy = listeners.get([...listeners.keys()].find(k => k.endsWith('/binary')) ?? '')

    expect(legacy).toBeTypeOf('function')
    legacy?.({ payload: [0, 255, 127] })
    legacy?.({ payload: [] })

    expect(frames.map(f => [...f])).toEqual([[0, 255, 127], []])
  })
})
