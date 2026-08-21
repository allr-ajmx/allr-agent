import { newSessionInProfile, startNewSession } from '@/store/new-session'
import { $activeGatewayProfile, normalizeProfileKey } from '@/store/profile'
import { announceProfileChatScope } from '@/store/profile-chat-scope'
import type { WakeDetection } from '@/store/wake-word'

/**
 * Where a wake phrase LANDS — the half of `wake.detected` universal used to drop
 * on the floor (MJXHRM-389).
 *
 * The gateway's detector is multi-phrase and multi-profile: `tools/wake_word.py`
 * builds a phrase→profile map from every wake-enabled profile's config, so "hey
 * scout" and "hey hermes" reach the same listener and the event says which one
 * fired and whose it was. The client received that field, passed it to the
 * conversation starter, and the starter took no arguments — so every phrase
 * opened a conversation in whatever chat happened to be on screen, under
 * whatever profile the app was already in. A second profile's wake phrase was
 * indistinguishable from the first's.
 *
 * The routing is deliberately the SAME act a human would perform — switch
 * profile, start a chat — rather than a voice-only shortcut, so a wake-started
 * conversation and a hand-started one leave the app in identical states.
 *
 * WHAT HAPPENS TO THE OPEN CHAT, SAID OUT LOUD. Desktop re-homes its gateway to
 * the profile's own backend process (`ensureGatewayProfile`, one pooled backend
 * per profile). Universal has ONE gateway socket; a NEW chat follows the profile
 * because `session.create` carries it per request, but a chat already open keeps
 * the profile it was started in, and only a backend we started can be respawned
 * to move wholesale. `announceProfileChatScope` is the app's single
 * answer to that, shared with the profile picker; routing a wake phrase without
 * it would be the silent mis-route this whole feature exists to avoid.
 */
export function routeWakeDetection(detection: WakeDetection): void {
  // A single-phrase engine reports no profile at all. Re-trimmed here rather
  // than trusted: "" and "   " both have to mean "the profile we are already
  // in", and `normalizeProfileKey` would turn either into 'default' — which on a
  // named profile reads as a crossing and would re-home the app on every wake.
  const named = detection.profile?.trim()
  const target = named ? normalizeProfileKey(named) : null
  const crossProfile = target !== null && target !== normalizeProfileKey($activeGatewayProfile.get())

  if (crossProfile) {
    // A phrase enrolled by another profile always opens a NEW chat there:
    // continuing the chat on screen would put that profile's turn inside a
    // conversation belonging to a different one. `start_new_session: false` says
    // "stay in the current chat", and the current chat is precisely what a
    // cross-profile phrase is asking to leave.
    newSessionInProfile(target)
    // `null` is how the connection layer spells "the gateway's own (primary)
    // profile" — `'default'` is the store's key for the same thing, and passing
    // the key through would try to respawn a backend as a profile named
    // "default".
    announceProfileChatScope(target === 'default' ? null : target)

    return
  }

  if (detection.startNewSession) {
    startNewSession()
  }
}
