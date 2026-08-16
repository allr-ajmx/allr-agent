/**
 * Which conversation a surface lands on from a standing start (MJXHRM-438).
 *
 * Two surfaces ask this question and they used to answer it separately. The
 * phone's shell restores the last chat at boot (`use-restore-last-session.ts`),
 * and the HUD has to resolve the same thing every time it is summoned — which,
 * since background mode, can be with no other window on screen at all. Their
 * answers must agree: they are the same user, the same profile and the same
 * remembered id, and a HUD that landed somewhere else from the app it was
 * summoned out of is the seam MJXHRM-433 Part 5 calls the most repeatedly-broken
 * one in this codebase.
 *
 * So the DECISION lives here, pure, and the two callers keep only what is
 * genuinely theirs — the phone's once-per-launch latch and navigate, the HUD's
 * resume-and-report. The HUD deliberately does not mount the hook: its
 * `done.current` latch means "once per launch", and in a window that is rebuilt
 * on every summon those same words quietly become "once per summon".
 *
 * WHICH MAPS THIS RESOLVES THROUGH: none. It is a decision over a pathname and
 * an id, and it performs no lookup at all. The single lookup happens afterwards,
 * in `openSession(id)` → `runtimeKeyForStoredSession`, whose reverse index is
 * empty in a freshly built window — so the backend's `session.resume` is the
 * sole resolver, and it is the one that knows about compaction lineage.
 * Deliberately NOT routed through `liveSessionIdFor()`: that reads `$sessions` /
 * `$pinnedSessionCache` / `$projectTree`, none of which have loaded when a
 * surface is one frame old, so it would return the id unchanged while adding a
 * second thing that could disagree about which session was meant.
 */

import { NEW_CHAT_ROUTE, routeSessionId } from '@/app/routes'

export type SessionLanding =
  /** The route NAMES a session. Explicit intent; outranks everything. */
  | { id: string; kind: 'route' }
  /** A standing start, and there is a conversation to come back to. */
  | { id: string; kind: 'remembered' }
  /** A standing start with nothing to come back to: a blank new chat. */
  | { kind: 'new' }
  /** The route is some other app screen. The caller is deliberately not on a
   *  chat, so a memory must not drag it onto one. */
  | { kind: 'elsewhere' }

/**
 * Resolve where `pathname` should land, given the profile's remembered chat.
 *
 * `pathname` rather than an already-extracted session id, and that is the whole
 * correction: `routeSessionId('/settings')` is `null`, so a resolver fed the
 * extracted id cannot tell "a blank new chat" from "the Settings screen" — and
 * would answer `remembered` for both, yanking a user who deep-linked into
 * Settings onto a conversation while the gateway was still connecting.
 *
 * An EMPTY remembered id is not an id. `lastOpenedSessionId()` reads a
 * `persistentAtom` out of `localStorage`, where a truncated or hand-edited
 * record deserializes to `''` rather than to `null`, and `openSession('')` is a
 * resume for a session that cannot exist.
 */
export function resolveSessionLanding(pathname: string, remembered: null | string): SessionLanding {
  const routed = routeSessionId(pathname)

  if (routed) {
    return { id: routed, kind: 'route' }
  }

  if (pathname !== NEW_CHAT_ROUTE) {
    return { kind: 'elsewhere' }
  }

  return remembered ? { id: remembered, kind: 'remembered' } : { kind: 'new' }
}

/** The session a landing names, or null when it names none. The shape a caller
 *  that only wants "what do I resume" needs, so each one does not re-spell the
 *  same two-arm narrowing. */
export function landingSessionId(landing: SessionLanding): null | string {
  return landing.kind === 'route' || landing.kind === 'remembered' ? landing.id : null
}
