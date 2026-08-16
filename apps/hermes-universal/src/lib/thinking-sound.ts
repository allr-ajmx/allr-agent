// Ambient "thinking" sound for a voice conversation. While the agent works
// (status === 'thinking') no audio flows at all, which — hands-free, not looking
// at the screen — reads as "it died" through a long tool stretch. A calm, quiet,
// repeating pair of soft bubble blips fills that dead air.
//
// Ported from apps/desktop/src/lib/thinking-sound.ts. Same WebAudio oscillator
// synthesis as universal's wake-sound.ts / completion-sound.ts (no asset to
// ship), and the same two gates: the shared sound mute ($hapticsMuted) and the
// backend's own `voice.thinking_sound` config key ($thinkingSoundEnabled,
// default true — hermes_cli/config_defaults.py:1624). The pitches match the
// backend's numpy-synthesized blips in tools/voice_mode.py so the CLI, desktop
// and universal all sound alike.
//
// WHO DRIVES IT — universal's voice loop is a module-level actor, not a React
// effect (MJX-96), so the driver is `syncThinkingSound`, subscribed to
// `$voiceConversation` by the conversation controller. Desktop's equivalent is a
// `useEffect` in its composer hook; here a re-render is not a state transition
// and must not be one, or a conversation that blips forever is one missed render
// away.

import { $hapticsMuted } from '@/store/haptics'
import type { VoiceConversationState } from '@/store/voice-conversation'
import { $thinkingSoundEnabled } from '@/store/voice-prefs'

let ctx: AudioContext | null = null
let timer: null | number = null
let blipIndex = 0

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') {
    return null
  }

  try {
    if (!ctx) {
      const Ctor =
        window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext

      if (!Ctor) {
        return null
      }

      ctx = new Ctor()
    }

    // Autoplay policy can leave the context suspended until a gesture; resuming
    // here recovers it once the user has interacted with the window. (On
    // WebKitGTK this is the difference between blips and silence — the same
    // recovery wake-sound.ts relies on.)
    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => undefined)
    }

    return ctx
  } catch {
    return null
  }
}

// One soft "blub": a short sine with a gentle downward pitch glide and a smooth
// attack into an exponential decay — no clicks, deliberately quiet.
function blub(ac: AudioContext, freq: number): void {
  const t0 = ac.currentTime + 0.01
  const dur = 0.16
  const osc = ac.createOscillator()
  const env = ac.createGain()

  osc.type = 'sine'
  osc.frequency.setValueAtTime(freq, t0)
  osc.frequency.exponentialRampToValueAtTime(freq * 0.72, t0 + dur)

  env.gain.setValueAtTime(0.0001, t0)
  env.gain.exponentialRampToValueAtTime(0.08, t0 + 0.02)
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)

  osc.connect(env)
  env.connect(ac.destination)
  osc.start(t0)
  osc.stop(t0 + dur + 0.02)
}

export function isThinkingSoundActive(): boolean {
  return timer !== null
}

/** Start the repeating thinking blips (idempotent). Best-effort, never throws. */
export function startThinkingSound(): void {
  if (timer !== null || !$thinkingSoundEnabled.get()) {
    return
  }

  const tick = () => {
    // Re-read the mute on every blip rather than latching it at start: muting
    // mid-turn has to take effect on the next blip, not the next conversation.
    if (!$hapticsMuted.get()) {
      const ac = getCtx()

      if (ac) {
        try {
          // Alternate two calm pitches (G4 / E4), matching the backend blips.
          blub(ac, blipIndex % 2 === 0 ? 392 : 329.6)
        } catch {
          // Audio backend unavailable — stay silent, keep the loop harmless.
        }
      }
    }

    blipIndex += 1
    // ~0.8–1.2 s spacing with slight randomization so it reads organic.
    timer = window.setTimeout(tick, 800 + Math.random() * 400)
  }

  timer = window.setTimeout(tick, 400)
}

/** Stop the thinking blips instantly (idempotent). */
export function stopThinkingSound(): void {
  if (timer !== null) {
    window.clearTimeout(timer)
    timer = null
  }
}

/**
 * The single decision: blips play only while a conversation this app owns is
 * actually waiting on the agent.
 *
 * Every other status stops them — `speaking` (the reply itself is the audio),
 * `listening`/`transcribing` (the mic is live and blips would be captured as
 * speech), and `idle`/inactive (the conversation ended). Muting the conversation
 * stops them too: a muted conversation is one the user has stepped away from.
 *
 * Expressed as one pure-ish function of the whole state so there is no
 * transition to forget — the failure mode of a per-call-site stop is blips that
 * outlive the conversation, and nothing on screen explains them.
 */
export function syncThinkingSound(state: VoiceConversationState): void {
  if (state.active && !state.muted && state.status === 'thinking') {
    startThinkingSound()

    return
  }

  stopThinkingSound()
}
