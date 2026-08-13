import { atom } from '@/store/atom'
import type { ConversationStatus } from '@/store/voice-conversation'

/**
 * The wake indicator — "the app heard you" made visible.
 *
 * A wake phrase is the one interaction with no on-screen cause: nothing was
 * clicked, the window may not even be focused, and the only feedback until now
 * was a chime that a muted machine swallows. This is the visual half.
 *
 * Three states, desktop's (apps/desktop/src/lib/wake-indicator.ts):
 *
 *  * `detected`  — the phrase fired; the conversation is being opened. Breathes.
 *  * `capturing` — the conversation is listening. Solid.
 *  * `hidden`    — nothing to say.
 *
 * WHAT DIVERGES, DELIBERATELY. Desktop pushes each state over IPC to a dedicated
 * always-on-top Electron window (`window.hermesDesktop.wakeIndicator`). Universal
 * publishes to THIS ATOM and lets presentations subscribe. That is the whole
 * point of the split: the state machine — when the indicator is live, and which
 * of the three states it is in — is decided once, here, and is the same on every
 * platform, while *where the light is drawn* is a per-platform question.
 *
 * SEAM FOR MJXHRM-228 (notch indicator / client-capture wake word). 228 owns a
 * NATIVE surface: a notch/menu-bar light that survives the main window losing
 * focus. It should subscribe to `$wakeIndicator` and mirror it — it must not
 * re-derive the states, and it must not need to touch `activateWakeIndicator` /
 * `syncWakeIndicatorWithVoice` / `clearWakeIndicator` at all. When a native
 * surface is present and 228 decides the in-window pill is redundant beside it,
 * the pill is one component (`app/wake-indicator-overlay.tsx`) reading one atom;
 * suppressing it is a condition on that component, not a change here.
 */

export const WAKE_INDICATOR_STATES = ['hidden', 'detected', 'capturing'] as const

export type WakeIndicatorState = (typeof WAKE_INDICATOR_STATES)[number]

export const $wakeIndicator = atom<WakeIndicatorState>('hidden')

/**
 * Whether the indicator belongs to a wake-started conversation.
 *
 * The indicator is deliberately NOT shown for a voice conversation the user
 * opened by hand: they pressed a button and are looking at the composer's own
 * pill. It exists for the hands-free case, where nothing else on screen changed.
 */
let wakeStartedConversation = false
/** The wake-started conversation has actually opened (so `active: false` from
 *  here on means it ENDED, rather than "has not started yet"). */
let voiceConversationStarted = false

function pushState(state: WakeIndicatorState): void {
  if (state !== $wakeIndicator.get()) {
    $wakeIndicator.set(state)
  }
}

/** `wake.detected` fired: light up while the conversation is being opened. */
export function activateWakeIndicator(): void {
  wakeStartedConversation = true
  voiceConversationStarted = false
  pushState('detected')
}

/**
 * Follow the voice conversation. Returns whether this call OWNED the indicator,
 * so the caller knows whether its unmount has to clear it.
 *
 * The `!active && !voiceConversationStarted` guard is what makes the gap between
 * `wake.detected` and the conversation actually opening survive: during it the
 * conversation reads inactive, and without the guard the first sync would hide an
 * indicator that has just been lit.
 */
export function syncWakeIndicatorWithVoice(active: boolean, status: ConversationStatus): boolean {
  if (!wakeStartedConversation) {
    return false
  }

  if (!active && !voiceConversationStarted) {
    return false
  }

  if (!active) {
    wakeStartedConversation = false
    voiceConversationStarted = false
    pushState('hidden')

    return true
  }

  voiceConversationStarted = true
  pushState(status === 'listening' ? 'capturing' : 'detected')

  return true
}

/** Force the light out — the surface that owned it is going away. */
export function clearWakeIndicator(): void {
  if (!wakeStartedConversation && $wakeIndicator.get() === 'hidden') {
    return
  }

  wakeStartedConversation = false
  voiceConversationStarted = false
  pushState('hidden')
}
