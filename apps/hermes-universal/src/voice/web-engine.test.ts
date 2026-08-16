import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/hermes', () => ({ transcribeAudio: vi.fn(async () => ({ transcript: '' })) }))
vi.mock('@/lib/mic-permission', () => ({ ensureMicPermission: async () => true }))

import type { VoiceEvent } from './types'
import { createWebLease } from './web-engine'

// The browser fallback engine has to honour the same contract the Rust session
// does, and MJXHRM-90 added two things to that contract: a configurable input
// gain, and a `monitor` arm that is incapable of capturing a turn. Both are
// safety properties here, not conveniences — a settings meter that recorded and
// transcribed on `vite dev` would be doing the exact thing the mode exists to
// prevent.

const recorders: FakeRecorder[] = []

class FakeRecorder {
  static isTypeSupported = () => true
  state = 'inactive'
  ondataavailable: unknown = null
  onstop: unknown = null
  onerror: unknown = null
  mimeType = 'audio/webm'

  constructor() {
    recorders.push(this)
  }

  start(): void {
    this.state = 'recording'
  }

  stop(): void {
    this.state = 'inactive'
  }

  requestData(): void {}
}

/** Drives the analyser: every read returns a constant sample amplitude. */
let sampleValue = 128

class FakeAnalyser {
  fftSize = 256
  getByteTimeDomainData(target: Uint8Array): void {
    target.fill(sampleValue)
  }
}

class FakeAudioContext {
  createAnalyser() {
    return new FakeAnalyser()
  }

  createMediaStreamSource() {
    return { connect: () => undefined }
  }

  close(): Promise<void> {
    return Promise.resolve()
  }
}

const frames: (() => void)[] = []

beforeEach(() => {
  recorders.length = 0
  frames.length = 0
  sampleValue = 128
  vi.stubGlobal('MediaRecorder', FakeRecorder)
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('navigator', {
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => undefined }] }) }
  })
  // One manual step per rAF so a test controls exactly how many meter ticks run.
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => {
    frames.push(fn)

    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
})

afterEach(() => vi.unstubAllGlobals())

/** Advance the meter by one tick (the first tick runs synchronously in `arm`). */
function tick(): void {
  frames.shift()?.()
}

async function lease(vad?: Record<string, number>) {
  const engine = createWebLease()
  const events: VoiceEvent[] = []
  engine.on(event => events.push(event))
  await engine.init({ target: { baseUrl: '', headers: {} }, vad })

  return { engine, events }
}

const levels = (events: VoiceEvent[]) =>
  events.filter((event): event is Extract<VoiceEvent, { type: 'level' }> => event.type === 'level').map(e => e.level)

describe('web voice engine', () => {
  it('scales the reported level by the input gain', async () => {
    // A constant 138 against the 128 centre is an RMS of exactly 10.
    sampleValue = 138

    const quiet = await lease({ levelGain: 3 })
    await quiet.engine.arm('normal')
    expect(levels(quiet.events)[0]).toBeCloseTo((10 / 128) * 3, 6)

    const loud = await lease({ levelGain: 12 })
    await loud.engine.arm('normal')
    expect(levels(loud.events)[0]).toBeCloseTo((10 / 128) * 12, 6)
  })

  it('never records or ends a turn while monitoring', async () => {
    sampleValue = 255 // as loud as the analyser can report

    const { engine, events } = await lease({ levelGain: 3 })
    await engine.arm('monitor')
    tick()
    tick()

    // Levels flow...
    expect(levels(events).length).toBeGreaterThan(0)
    // ...but no MediaRecorder was ever constructed, so there is no clip to
    // transcribe and nothing to send anywhere.
    expect(recorders).toHaveLength(0)
    expect(events.some(event => event.type === 'speechStart')).toBe(false)
    expect(events.some(event => event.type === 'state' && event.state === 'recording')).toBe(false)
    expect(events.some(event => event.type === 'idleTimeout')).toBe(false)
  })

  it('still records normally when armed for a real turn', async () => {
    sampleValue = 255

    const { engine, events } = await lease({ levelGain: 3 })
    await engine.arm('normal')

    expect(recorders).toHaveLength(1)
    expect(events.some(event => event.type === 'speechStart')).toBe(true)
  })
})
