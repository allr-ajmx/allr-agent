/**
 * Test helpers for the session map.
 *
 * Since the unification (MJX-132) there is no global `$messages`/`$busy` to
 * `.set` — every session's state lives in `$sessionStates` and the chat store
 * projects the active slice. Tests therefore seed SLICES.
 */

import type { ChatMessage } from '@/lib/chat-messages'
import {
  $activeSessionKey,
  $sessionStates,
  type ClientSessionState,
  emptySessionState,
  publishSessionState
} from '@/store/session-state-types'

/** Seed one session's slice. `key` doubles as its runtime id unless overridden. */
export function seedSession(key: string, patch: Partial<ClientSessionState> = {}): ClientSessionState {
  return publishSessionState(key, {
    ...emptySessionState(patch.storedSessionId ?? key),
    runtimeSessionId: key,
    ...patch
  })
}

/** Seed a session AND make it the one on screen. */
export function seedActiveSession(key: string, patch: Partial<ClientSessionState> = {}): ClientSessionState {
  const state = seedSession(key, patch)
  $activeSessionKey.set(key)

  return state
}

/** Make an already-seeded session the one on screen. */
export function activateSession(key: string): void {
  $activeSessionKey.set(key)
}

/** One session's transcript. */
export const sessionMessages = (key: string): ChatMessage[] => $sessionStates.get()[key]?.messages ?? []

/** Wipe the map — for `beforeEach`. */
export function resetSessionStates(): void {
  $sessionStates.set({})
}
