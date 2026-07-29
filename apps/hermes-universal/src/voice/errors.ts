import type { VoiceOwner } from './types'

// Thrown by `VoiceEngine.open` when another, higher-priority owner already holds
// the mic (a live conversation blocks the momentary dictation button). Typed so
// callers can distinguish contention from a real device failure.
export class VoiceBusyError extends Error {
  constructor(public readonly heldBy: VoiceOwner) {
    super(`voice mic busy (held by ${heldBy})`)
    this.name = 'VoiceBusyError'
  }
}

// Copy needed to describe a voice error to the user. Satisfied structurally by the
// i18n `notifications.voice` block.
export interface VoiceErrorCopy {
  microphoneAccessDenied: string
  microphoneConstraintsUnsupported: string
  microphoneInUse: string
  microphonePermissionDenied: string
  microphoneStartFailed: string
  microphoneUnsupported: string
  noMicrophone: string
  /** Device dropped mid-session (unplugged / default switched). */
  microphoneDisconnected: string
  /** Transcription request failed. */
  transcriptionFailed: string
}

/**
 * Map a Rust voice error `code` (from a `voice://{id}/error` event or a rejected
 * command) onto localized copy. Inherits the `nativeError` mapping from the old
 * `use-native-mic-recorder.ts`, extended with the persistent-session codes.
 */
export function voiceErrorMessage(code: string, copy: VoiceErrorCopy): string {
  if (code.includes('no_input_device') || code.includes('no_input_config')) {
    return copy.noMicrophone
  }

  if (code.includes('unsupported_platform') || code.includes('unsupported_sample_format')) {
    return copy.microphoneUnsupported
  }

  if (code.includes('already_open') || code.includes('already_recording')) {
    return copy.microphoneInUse
  }

  if (code.includes('stream_build') || code.includes('stream_play')) {
    return copy.microphoneStartFailed
  }

  if (code.includes('device_lost') || code.includes('no_audio_frames')) {
    return copy.microphoneDisconnected
  }

  if (code.startsWith('transcribe_') || code.includes('encode_')) {
    return copy.transcriptionFailed
  }

  return copy.microphoneStartFailed
}
