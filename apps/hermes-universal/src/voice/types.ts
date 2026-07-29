// The JS view of the Rust `VoiceSession` (MJX-96). One `VoiceEngine` singleton
// owns the mic; callers take a `VoiceLease` and drive it with arm/suspend/
// forceTurn/close, receiving `VoiceEvent`s that mirror the `voice://{id}/*`
// topics one-for-one. The native engine is a thin IPC client; the web engine
// reproduces the same event contract with getUserMedia for plain-browser/vitest.

/** Rust `VoiceStateKind`, serialized camelCase. */
export type VoiceStateKind = 'opening' | 'idle' | 'armed' | 'recording' | 'finalizing' | 'closing' | 'closed'

export type VoiceEmptyReason = 'noSpeech' | 'tooShort' | 'noTranscript'

export type VoiceArmMode = 'normal' | 'bargein'

/** One event from a session, decoded from a `voice://{id}/{topic}` payload. */
export type VoiceEvent =
  | { type: 'state'; state: VoiceStateKind }
  | { type: 'level'; level: number }
  | { type: 'speechStart' }
  | { type: 'transcript'; text: string; provider: string | null; durationMs: number }
  | { type: 'turnEmpty'; reason: VoiceEmptyReason }
  | { type: 'idleTimeout' }
  | { type: 'error'; code: string; message: string }

/** Optional VAD/turn overrides; omitted fields use Rust's tuned defaults. */
export interface VoiceVad {
  speechLevel?: number
  bargeinSpeechLevel?: number
  onsetMs?: number
  bargeinOnsetMs?: number
  silenceMs?: number
  idleSilenceMs?: number
  maxTurnMs?: number
  minTurnMs?: number
  prerollMs?: number
}

/** Where transcription POSTs go; mirrors Rust `TranscribeTarget`. */
export interface VoiceTarget {
  baseUrl: string
  headers: Record<string, string>
}

export interface VoiceOpenOptions {
  target: VoiceTarget
  vad?: VoiceVad
  format?: 'wav' | 'flac'
}

export type VoiceOwner = 'conversation' | 'dictation'

export type VoiceEventHandler = (event: VoiceEvent) => void

/** A live hold on the mic. Commands resolve once the Rust command returns (or the
 * web engine has applied them); events arrive via `on`. */
export interface VoiceLease {
  arm(mode?: VoiceArmMode): Promise<void>
  suspend(): Promise<void>
  forceTurn(): Promise<void>
  close(): Promise<void>
  /** Subscribe to session events; returns an unsubscribe fn. */
  on(handler: VoiceEventHandler): () => void
  readonly closed: boolean
}

export interface VoiceEngine {
  /** Acquire the mic for `owner`. Rejects with `VoiceBusyError` if a
   * higher-priority owner holds it. */
  open(owner: VoiceOwner, opts: VoiceOpenOptions): Promise<VoiceLease>
  /** Update the transcription auth target on the live session (token refresh). */
  updateAuth(target: VoiceTarget): Promise<void>
  readonly owner: VoiceOwner | null
}
