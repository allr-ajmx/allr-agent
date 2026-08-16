/**
 * Consent for CLIENT CAPTURE — this device's microphone streaming continuously
 * to the backend (MJXHRM-228).
 *
 * # Why the wake toggle is not enough on its own
 *
 * `wake_word.enabled` is opt-in and only a deliberate click writes it, so no
 * microphone opens because a window did. But that toggle is consent to a
 * FEATURE, and the feature has two completely different mechanisms behind it:
 *
 *  * `capture: "local"` — the gateway host holds its own microphone and runs the
 *    detector on it. This device sends no audio at all.
 *  * `capture: "client"` — the backend is headless, so this device opens its
 *    microphone and pushes 16 kHz PCM at `wake.feed` several times a second, for
 *    as long as the wake word is on.
 *
 * The backend chooses which, at arm time, and it can change: a user who enabled
 * the wake word against a gateway with a microphone gets silently upgraded to
 * continuous upload the day they point Hermes at a headless one. The upload is
 * then re-established on every app start with no press at all, because the
 * config still says enabled. That is the case this exists for.
 *
 * # The shape
 *
 * One deliberate press of the ear button, made while the backend says it needs
 * client capture, is the consent — there is no second dialog, because a
 * confirmation attached to nothing the user can see is not informed consent
 * either. What makes it informed is that the ear button SAYS which mechanism it
 * is about to use before it is pressed (`composer.wakeWordClientCapture`).
 * Until then a passive re-arm stops rather than opening the microphone.
 *
 * # Scope, and what it deliberately is not
 *
 * Per DEVICE, in this webview's storage, not per gateway. The thing being
 * consented to is this machine's microphone being opened and streamed at all;
 * the destination is whichever backend the user has pointed Hermes at, which is
 * itself their choice. The honest limit: switching to a DIFFERENT headless
 * gateway later does not ask again. Making the record per gateway needs the
 * connection store in this graph, which is a cycle away from the voice loop —
 * so it is stated here rather than half-built.
 */

import { loadString, saveString } from '@/lib/persist'

const KEY = 'hermes:wake-client-capture'
const GRANTED = 'granted'

/** Has this device been told to stream its microphone for wake detection? */
export function hasClientCaptureConsent(): boolean {
  return loadString(KEY) === GRANTED
}

/** Record the press. Idempotent, and deliberately sticky: turning the ear off
 *  already stops the streaming, and it is the only control that needs to. */
export function grantClientCaptureConsent(): void {
  saveString(KEY, GRANTED)
}
