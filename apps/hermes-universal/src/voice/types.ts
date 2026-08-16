// The JS view of the Rust `VoiceSession` (MJX-96). One `VoiceEngine` singleton
// owns the mic; callers take a `VoiceLease` and drive it with arm/suspend/
// forceTurn/close, receiving `VoiceEvent`s that mirror the `voice://{id}/*`
// topics one-for-one. The native engine is a thin IPC client; the web engine
// reproduces the same event contract with getUserMedia for plain-browser/vitest.

/** Rust `VoiceStateKind`, serialized camelCase. */
export type VoiceStateKind =
  'opening' | 'idle' | 'wakeListening' | 'armed' | 'recording' | 'finalizing' | 'closing' | 'closed'

export type VoiceEmptyReason = 'noSpeech' | 'tooShort' | 'noTranscript'

/** `monitor` arms the mic for its LEVEL only — Rust makes the onset threshold
 *  unreachable and the idle window infinite, so no turn is ever captured or
 *  transcribed. It is what the Voice settings meter runs on. */
export type VoiceArmMode = 'normal' | 'bargein' | 'monitor'

/** One event from a session, decoded from a `voice://{id}/{topic}` payload. */
export type VoiceEvent =
  | { type: 'state'; state: VoiceStateKind }
  | { type: 'level'; level: number }
  | { type: 'speechStart' }
  | { type: 'transcript'; text: string; provider: string | null; durationMs: number }
  | { type: 'turnEmpty'; reason: VoiceEmptyReason }
  | { type: 'idleTimeout' }
  /** One batch of wake audio, base64 int16 mono LE @16 kHz, ready for `wake.feed`.
   *  Only while the session is `wakeListening`. */
  | { type: 'wakeFrame'; pcm: string }
  | { type: 'error'; code: string; message: string }

/** Optional VAD/turn overrides; omitted fields use Rust's tuned defaults. */
export interface VoiceVad {
  /** Mic gain on the level scale — scales the reported RMS only, never the PCM
   *  that gets transcribed (Rust `VoiceConfig::level_gain`). */
  levelGain?: number
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

/** Mic owners, most privileged first. `wake` is the standing background listener
 *  and yields to anything the user asked for directly — including `meter`, the
 *  Voice settings calibration meter, which only exists while the user is holding
 *  a button down on that page. */
export type VoiceOwner = 'conversation' | 'dictation' | 'meter' | 'wake'

export type VoiceEventHandler = (event: VoiceEvent) => void

/** A live hold on the mic. Commands resolve once the Rust command returns (or the
 * web engine has applied them); events arrive via `on`. */
export interface VoiceLease {
  arm(mode?: VoiceArmMode): Promise<void>
  /** Enter hands-free wake listening: emit `wakeFrame` batches instead of running
   *  a turn. Rejects where the engine cannot capture wake audio (the web engine). */
  wakeListen(): Promise<void>
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
