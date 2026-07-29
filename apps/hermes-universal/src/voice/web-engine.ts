import { transcribeAudio } from '@/hermes'
import { ensureMicPermission } from '@/lib/mic-permission'

import type { EngineLease } from './native-engine'
import type { VoiceArmMode, VoiceEvent, VoiceEventHandler, VoiceOpenOptions, VoiceVad } from './types'

// The browser fallback engine (getUserMedia + MediaRecorder + an AnalyserNode
// VAD), reproducing the same `VoiceEvent` contract as the Rust session. Used for
// plain-browser `vite dev` and as the one-shot downgrade when the native engine
// fails to open. It transcribes from JS (`transcribeAudio`, via the $connection
// auth path) rather than in Rust, and records the whole armed period instead of a
// pre-roll ring — good enough for a fallback. The primary path on every Tauri
// target (desktop AND mobile) is the native engine.

type BrowserAudioContext = typeof AudioContext

interface Tuning {
  speechLevel: number
  silenceMs: number
  idleSilenceMs: number
}

const DEFAULT_NORMAL: Tuning = { speechLevel: 0.075, silenceMs: 1_250, idleSilenceMs: 12_000 }

function tuningFor(mode: VoiceArmMode, vad: VoiceVad | undefined): Tuning {
  const base = DEFAULT_NORMAL

  const speechLevel = mode === 'bargein' ? (vad?.bargeinSpeechLevel ?? 0.16) : (vad?.speechLevel ?? base.speechLevel)

  return {
    speechLevel,
    silenceMs: vad?.silenceMs ?? base.silenceMs,
    idleSilenceMs: vad?.idleSilenceMs ?? base.idleSilenceMs
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.onload = () => resolve(String(reader.result))
    reader.readAsDataURL(blob)
  })
}

export function createWebLease(): EngineLease {
  return new WebVoiceLease()
}

class WebVoiceLease implements EngineLease {
  private readonly handlers = new Set<VoiceEventHandler>()
  private stream: MediaStream | null = null
  private audioContext: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private raf: number | null = null

  private recorder: MediaRecorder | null = null
  private chunks: Blob[] = []
  private mimeType = ''

  private vad: VoiceVad | undefined
  private tuning: Tuning = DEFAULT_NORMAL
  private phase: 'idle' | 'armed' | 'recording' | 'finalizing' | 'closed' = 'idle'
  private heardSpeech = false
  private idleEmitted = false
  private armedAt = 0
  private recordingAt = 0
  private silenceStartedAt: number | null = null

  private _closed = false

  async init(opts: VoiceOpenOptions): Promise<void> {
    this.vad = opts.vad

    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      throw new Error('microphone_unsupported')
    }

    if (!(await ensureMicPermission())) {
      throw new Error('microphone_permission_denied')
    }

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true }
    })
    this.mimeType =
      ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg', 'audio/wav'].find(
        type => MediaRecorder.isTypeSupported(type)
      ) ?? ''

    this.emit({ type: 'state', state: 'idle' })
  }

  on(handler: VoiceEventHandler): () => void {
    this.handlers.add(handler)

    return () => this.handlers.delete(handler)
  }

  get closed(): boolean {
    return this._closed
  }

  private emit(event: VoiceEvent): void {
    for (const handler of this.handlers) {
      handler(event)
    }
  }

  async arm(mode: VoiceArmMode = 'normal'): Promise<void> {
    if (this._closed || !this.stream) {
      return
    }

    this.tuning = tuningFor(mode, this.vad)
    this.heardSpeech = false
    this.idleEmitted = false
    this.silenceStartedAt = null
    this.armedAt = Date.now()
    this.chunks = []

    this.recorder = new MediaRecorder(this.stream, this.mimeType ? { mimeType: this.mimeType } : undefined)

    this.recorder.ondataavailable = event => {
      if (event.data.size > 0) {
        this.chunks.push(event.data)
      }
    }

    this.recorder.start(250)

    this.phase = 'armed'
    this.emit({ type: 'state', state: 'armed' })
    this.startMeter()
  }

  async suspend(): Promise<void> {
    this.stopMeter()
    this.discardRecorder()

    if (this.phase !== 'idle') {
      this.phase = 'idle'
      this.emit({ type: 'state', state: 'idle' })
    }
  }

  async forceTurn(): Promise<void> {
    if (this.phase === 'armed' || this.phase === 'recording') {
      this.finalize()
    }
  }

  async close(): Promise<void> {
    if (this._closed) {
      return
    }

    this._closed = true
    this.stopMeter()
    this.discardRecorder()
    this.stream?.getTracks().forEach(track => track.stop())
    this.stream = null
    void this.audioContext?.close()
    this.audioContext = null
    this.analyser = null
    this.emit({ type: 'state', state: 'closing' })
    this.emit({ type: 'state', state: 'closed' })
    this.handlers.clear()
  }

  private startMeter(): void {
    const audioWindow = window as Window & { webkitAudioContext?: BrowserAudioContext }
    const AudioContextCtor = window.AudioContext || audioWindow.webkitAudioContext

    if (!AudioContextCtor || !this.stream) {
      return
    }

    if (!this.audioContext) {
      this.audioContext = new AudioContextCtor()
      this.analyser = this.audioContext.createAnalyser()
      this.analyser.fftSize = 256
      this.audioContext.createMediaStreamSource(this.stream).connect(this.analyser)
    }

    const analyser = this.analyser

    if (!analyser) {
      return
    }

    const data = new Uint8Array(analyser.fftSize)

    const tick = () => {
      analyser.getByteTimeDomainData(data)
      let sum = 0

      for (const value of data) {
        const centered = value - 128
        sum += centered * centered
      }

      const normalized = Math.min(1, Math.sqrt(sum / data.length) / 42)
      const now = Date.now()
      this.emit({ type: 'level', level: normalized })

      if (normalized >= this.tuning.speechLevel) {
        if (!this.heardSpeech) {
          this.heardSpeech = true
          this.recordingAt = now
          this.phase = 'recording'
          this.emit({ type: 'speechStart' })
          this.emit({ type: 'state', state: 'recording' })
        }

        this.silenceStartedAt = null
      } else if (this.heardSpeech) {
        this.silenceStartedAt ??= now

        if (now - this.silenceStartedAt >= this.tuning.silenceMs) {
          this.finalize()

          return
        }
      } else if (!this.idleEmitted && now - this.armedAt >= this.tuning.idleSilenceMs) {
        this.idleEmitted = true
        this.emit({ type: 'idleTimeout' })
      }

      this.raf = window.requestAnimationFrame(tick)
    }

    tick()
  }

  private stopMeter(): void {
    if (this.raf !== null) {
      window.cancelAnimationFrame(this.raf)
      this.raf = null
    }
  }

  private discardRecorder(): void {
    const recorder = this.recorder
    this.recorder = null
    this.chunks = []

    if (recorder && recorder.state !== 'inactive') {
      recorder.ondataavailable = null
      recorder.onstop = null
      recorder.onerror = null

      try {
        recorder.stop()
      } catch {
        // ignore
      }
    }
  }

  private finalize(): void {
    const recorder = this.recorder

    if (!recorder) {
      return
    }

    this.stopMeter()
    this.phase = 'finalizing'
    this.emit({ type: 'state', state: 'finalizing' })

    const heardSpeech = this.heardSpeech
    const durationMs = heardSpeech ? Date.now() - this.recordingAt : 0
    const type = recorder.mimeType || this.mimeType || 'audio/webm'

    recorder.onstop = () => {
      const chunks = this.chunks
      this.chunks = []
      this.recorder = null

      if (!chunks.length || !heardSpeech) {
        this.emit({ type: 'turnEmpty', reason: 'noSpeech' })
        this.toIdle()

        return
      }

      void this.transcribe(new Blob(chunks, { type }), durationMs)
    }

    recorder.onerror = () => {
      this.recorder = null
      this.emit({ type: 'error', code: 'recording_failed', message: 'MediaRecorder error' })
      this.toIdle()
    }

    if (recorder.state === 'recording') {
      recorder.requestData()
    }

    recorder.stop()
  }

  private async transcribe(blob: Blob, durationMs: number): Promise<void> {
    try {
      const dataUrl = await blobToDataUrl(blob)
      const res = await transcribeAudio(dataUrl, blob.type || undefined)
      const text = (res.transcript ?? '').trim()

      if (text) {
        this.emit({ type: 'transcript', text, provider: null, durationMs })
      } else {
        this.emit({ type: 'turnEmpty', reason: 'noTranscript' })
      }
    } catch (error) {
      this.emit({
        type: 'error',
        code: 'transcribe_failed',
        message: error instanceof Error ? error.message : String(error)
      })
    } finally {
      this.toIdle()
    }
  }

  private toIdle(): void {
    if (this._closed) {
      return
    }

    this.phase = 'idle'
    this.emit({ type: 'state', state: 'idle' })
  }
}
