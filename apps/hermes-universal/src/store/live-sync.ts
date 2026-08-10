import { atom } from '@/store/atom'

/**
 * Event-driven "backend data changed" signals — the gateway-side twin of
 * `store/workspace-events`.
 *
 * The gateway runs ONE change watcher (`tui_gateway/server.py`
 * `_broadcast_watched_changes`) over a table of cheap on-disk signatures and
 * broadcasts `pet.changed` / `cron.changed` / `sessions.changed` /
 * `platforms.changed` / `pairing.changed` the moment one moves.
 * `store/event-router.ts` routes them here, and the surfaces that used to poll
 * subscribe to these ticks — so they refresh exactly when the backend acts and
 * stay idle otherwise. On mobile that is the difference between a radio waking
 * every few seconds forever and one that wakes when something happened.
 *
 * `$changeEventsAvailable` is the compat gate: `gateway.ready` advertises
 * `change_events: true` on a backend that broadcasts. Consumers keep their old
 * poll as a SLOW backstop when it is true, and at the legacy cadence when it is
 * false (an older gateway) — so nothing goes dark mid-upgrade, and a missed
 * broadcast is still eventually corrected.
 *
 * Ported from apps/desktop/src/store/live-sync.ts. Unlike desktop, no profile
 * filtering is applied: this fork's watcher broadcasts through
 * `_broadcast_global_event`, which builds its frame with an empty session id and
 * stamps no `profile`, so desktop's `!event.profile || …` guard is always true
 * on these frames anyway.
 */

export const $changeEventsAvailable = atom(false)

export const $cronChangeTick = atom(0)
export const $sessionsChangeTick = atom(0)
export const $platformsChangeTick = atom(0)
export const $pairingChangeTick = atom(0)

/** `pet.info.meta`-shaped payload carried on `pet.changed` — lets the pet skip
 *  the heavy spritesheet refetch when the broadcast already says enabled=false. */
export interface PetChangeMeta {
  displayName?: string
  enabled: boolean
  scale?: number
  slug?: string
  spritesheetRevision?: string
}

export const $petChange = atom<{ meta?: PetChangeMeta; tick: number }>({ tick: 0 })

export function setChangeEventsAvailable(available: boolean): void {
  $changeEventsAvailable.set(available)
}

export function notifyPetChanged(meta?: PetChangeMeta): void {
  $petChange.set({ meta, tick: $petChange.get().tick + 1 })
}

export function notifyCronChanged(): void {
  $cronChangeTick.set($cronChangeTick.get() + 1)
}

export function notifySessionsChanged(): void {
  $sessionsChangeTick.set($sessionsChangeTick.get() + 1)
}

export function notifyPlatformsChanged(): void {
  $platformsChangeTick.set($platformsChangeTick.get() + 1)
}

export function notifyPairingChanged(): void {
  $pairingChangeTick.set($pairingChangeTick.get() + 1)
}

/**
 * Poll cadence for a surface that also subscribes to a change tick.
 *
 * The backstop exists because a broadcast can be missed — a socket that dropped
 * between the signature moving and the frame going out never gets a replay, and
 * the watcher only re-fires on the NEXT change. Slow enough to be free, fast
 * enough that a missed event is a stale minute rather than a stale session.
 */
export function livePollIntervalMs(legacyMs: number, backstopMs: number): number {
  return $changeEventsAvailable.get() ? backstopMs : legacyMs
}

/** Reset on gateway wipe/reconnect — a new backend re-advertises capability on
 *  its own `gateway.ready`, and a stale `true` would leave every consumer on its
 *  slow backstop against a gateway that never broadcasts. */
export function resetLiveSync(): void {
  $changeEventsAvailable.set(false)
}
