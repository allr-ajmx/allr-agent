/**
 * LIVE-SESSION REHYDRATION + the coalesced session-list refresh — the half of
 * MJXHRM-43 that PR #92 deferred to "SE-D scope".
 *
 * `store/live-sync.ts` turns the gateway's change broadcasts into ticks. This
 * module is the consumer that makes `sessions.changed` mean something: without
 * it the event was recognised, demuxed onto `$sessionsChangeTick`, and read by
 * exactly one surface (the sidebar's messaging list) — which is a smaller
 * version of the bug the ticket was filed about.
 *
 * Two jobs, both keyed off the same tick:
 *
 * 1. **Liveness rehydration** (`session.active_list`). Renderer-only busy /
 *    needs-input state is lost on a reconnect while the backend keeps the turns
 *    running, and events emitted while the socket was down are never replayed —
 *    `_broadcast_watched_changes` only re-fires on the NEXT change. The
 *    gateway's in-memory registry is the authoritative snapshot and does not
 *    resume, focus or otherwise mutate a chat. It is authoritative about
 *    ABSENCE too: a turn that ends while the socket is degraded drops out of
 *    `_sessions` without this client seeing the `running: false` edge, so the
 *    row spins forever and the busy→idle transition that paints the "your turn"
 *    dot never fires. Reaping runtimes that vanish between snapshots restores
 *    both.
 *
 * 2. **The stored list.** `sessions.changed` also means the LIST may have new
 *    rows — a cron run's session, an inbound messaging turn creating a thread.
 *    Universal never polled that list at all, so those rows simply did not
 *    appear until the user did something. The refresh is heavier than the
 *    snapshot and the broadcast is only floored to 2s server-side, so it trails
 *    on a gap instead of firing per tick. The same call is the ON-CONNECT
 *    reseed universal lacked: a soft gateway switch refreshes the lists itself,
 *    but an AUTO-reconnect (sleep/wake, a blip, an expired ticket) went through
 *    nothing, and the broadcasts missed while the socket was down are never
 *    replayed.
 *
 * Ported from desktop's `app/contrib/hooks/use-background-sync.ts`, but as a
 * STORE rather than a React hook, and with three deliberate divergences the
 * universal architecture forces:
 *
 * - **Slices are keyed by session KEY, not by runtime id** (see
 *   `store/session-state-types.ts`). A conversation already open under a
 *   `hydrating:` / `draft:` placeholder must not get a second slice from the
 *   snapshot, so every row resolves through `runtimeKeyForStoredSession` first.
 * - **A slice is only CREATED for a session that is actually live** (working or
 *   waiting). Desktop creates one per snapshot row; universal caps the map at
 *   `MAX_CACHED_SESSIONS` and prunes idle slices on every growth, so seeding
 *   idle strangers would churn create→prune→republish on every poll and
 *   re-render the sidebar for nothing.
 * - **The reap is identity-guarded.** Desktop can look a vanished runtime up
 *   directly because its keys ARE runtime ids; here the lookup goes through the
 *   stored id, so it must confirm the slice it lands on is the same runtime
 *   before clearing someone else's live turn.
 */

import { $gatewayState, requestGateway } from '@/store/gateway'
import { $changeEventsAvailable, $sessionsChangeTick } from '@/store/live-sync'
import { $activeGatewayProfile, normalizeProfileKey } from '@/store/profile'
import { refreshMessagingSessions, refreshSessions } from '@/store/session'
import { emptySessionState } from '@/store/session-state-types'
import {
  $sessionStates,
  publishSessionState,
  runtimeKeyForStoredSession,
  SESSION_WATCHDOG_TIMEOUT_MS,
  setSessionStalled
} from '@/store/session-states'

/**
 * Backstop cadence for the snapshot when the gateway broadcasts: the tick
 * already re-pulls it, so this only covers the degraded-socket edge the stream
 * cannot replay.
 */
const LIVE_STATUS_BACKSTOP_MS = 30_000

/**
 * Cadence against a gateway with no change watcher.
 *
 * Deliberately slower than desktop's 1_500 ms. That number exists because
 * desktop ALWAYS polled this and needed a compaction id rotation to look
 * instantaneous; universal learns about rotations from the event stream
 * (`setActiveSessionStoredIdRotation`), so here the snapshot is purely a
 * safety net for turns started somewhere else — and a 1.5s radio wake on a
 * phone is exactly the cost this ticket exists to remove.
 */
const LIVE_STATUS_POLL_MS = 5_000

/** Trailing gap for the stored-list refresh. `sessions.changed` fires (floored
 *  to 2s server-side) on every state.db write during a streaming turn, and
 *  `refreshMessagingSessions` alone asks for 100 rows. */
export const SESSIONS_LIST_TICK_GAP_MS = 10_000

export interface LiveSessionStatusItem {
  id?: string
  last_active?: number
  session_key?: string
  status?: 'idle' | 'starting' | 'waiting' | 'working'
}

export interface LiveSessionStatusResponse {
  sessions?: LiveSessionStatusItem[]
}

/**
 * Runtime ids this snapshot has seen live, per gateway profile, mapped to the
 * stored session they belong to.
 *
 * The stored id is kept (desktop keeps only the runtime id) because the reap
 * has to find the slice through `runtimeKeyForStoredSession` — a session that
 * was rekeyed from `hydrating:<stored>` onto its runtime id in the meantime is
 * no longer reachable under whatever key it had when the snapshot saw it.
 *
 * Profile-scoped: a profile only ever reaps what its OWN snapshot previously
 * reported, so a second gateway's live rows can never be darkened by this one.
 */
const liveRuntimesByProfile = new Map<string, Map<string, string>>()

/** Forget every profile's live-runtime bookkeeping. A gateway wipe already drops
 *  the slices these ids point at, so a carried-over set could only reap
 *  runtimes that no longer exist. */
export function resetLiveRuntimeTracking(): void {
  liveRuntimesByProfile.clear()
}

/**
 * Apply one `session.active_list` snapshot to `$sessionStates`.
 *
 * Exported for the tests and for the puller below; never call it with a
 * response from a DIFFERENT profile than `profileKey`, or the reap set will
 * mix two gateways' registries.
 */
export function rehydrateLiveSessionStatuses(
  response: LiveSessionStatusResponse,
  nowMs = Date.now(),
  profileKey = 'default'
): void {
  const seen = new Map<string, string>()

  for (const session of response.sessions ?? []) {
    const runtimeSessionId = session.id?.trim()
    const storedSessionId = session.session_key?.trim()

    if (!runtimeSessionId || !storedSessionId) {
      continue
    }

    seen.set(runtimeSessionId, storedSessionId)

    const needsInput = session.status === 'waiting'
    const working = session.status === 'working' || needsInput

    // The slice this conversation already lives in, whatever key it is under
    // (a runtime id, or a `hydrating:` placeholder mid-resume). Falling back to
    // the runtime id is what lets a session running somewhere else — a cron
    // tick, an inbound messaging turn, the TUI — light up the sidebar row at
    // all: `$workingSessionIds` reads the whole map, keyed by stored id.
    const key = runtimeKeyForStoredSession(storedSessionId) ?? runtimeSessionId
    const existing = $sessionStates.get()[key]

    // A turn we just submitted is not yet running as far as the backend is
    // concerned, so the snapshot honestly reports it idle — but the local
    // stream is already waiting on its first token, and it is the newer
    // information. The stream path refuses to clear busy in exactly this window
    // (`awaitingResponse && !sawAssistantPayload`); without the same refusal
    // here a poll lands between submit and first token and darkens the row.
    const busy = working || Boolean(existing?.awaitingResponse && !existing.sawAssistantPayload)

    if (!existing) {
      // Nothing to restore for an idle stranger, and creating a slice for one
      // would only feed the LRU: `pruneSessionStates` evicts idle unpinned
      // slices on every map growth, so the next snapshot would recreate it and
      // republish `$sessionStates` on a loop.
      if (!busy && !needsInput) {
        setSessionStalled(storedSessionId, false)

        continue
      }

      publishSessionState(key, {
        ...emptySessionState(storedSessionId),
        busy,
        needsInput,
        runtimeSessionId
      })
    } else if (
      existing.storedSessionId !== storedSessionId ||
      existing.busy !== busy ||
      existing.needsInput !== needsInput
    ) {
      // Avoid re-arming the watchdog on every poll: publish only when the
      // authoritative snapshot differs from the renderer mirror. Normal gateway
      // events continue to own subsequent transitions.
      publishSessionState(key, { ...existing, busy, needsInput, storedSessionId })
    }

    if (!working) {
      setSessionStalled(storedSessionId, false)

      continue
    }

    const lastActiveMs = Number(session.last_active) * 1000

    const isQuiet =
      session.status === 'working' &&
      Number.isFinite(lastActiveMs) &&
      lastActiveMs > 0 &&
      nowMs - lastActiveMs >= SESSION_WATCHDOG_TIMEOUT_MS

    setSessionStalled(storedSessionId, isQuiet)
  }

  reapVanishedRuntimes(seen, profileKey)
  liveRuntimesByProfile.set(profileKey, seen)
}

/**
 * A runtime this profile's snapshot reported live LAST time but not this time
 * has ended: the gateway reaps a session out of `_sessions` when its turn
 * completes and its transport goes away. Settle it through the normal publish
 * path so the busy→idle transition fires — that edge is what clears the spinner
 * AND marks the row unread ("your turn").
 */
function reapVanishedRuntimes(seen: Map<string, string>, profileKey: string): void {
  const previouslyLive = liveRuntimesByProfile.get(profileKey)

  if (!previouslyLive) {
    return
  }

  for (const [runtimeSessionId, storedSessionId] of previouslyLive) {
    if (seen.has(runtimeSessionId)) {
      continue
    }

    const key = runtimeKeyForStoredSession(storedSessionId)
    const existing = key ? $sessionStates.get()[key] : undefined

    if (!existing?.busy && !existing?.needsInput) {
      continue
    }

    // The slice found through the stored id is only the same SESSION, not
    // necessarily the same RUN: a resume mints a fresh runtime id for the same
    // conversation, so an unguarded settle here would clear a turn this client
    // started moments ago because the run it replaced disappeared.
    if (key !== runtimeSessionId && existing.runtimeSessionId !== runtimeSessionId) {
      continue
    }

    publishSessionState(key as string, {
      ...existing,
      awaitingResponse: false,
      busy: false,
      needsInput: false,
      streamId: null,
      turnStartedAt: null
    })
  }
}

// ---------------------------------------------------------------------------
// The puller. Started once by the primary window's shell (app/mobile-controller);
// satellite windows share the same backend and must not multiply the traffic.
// ---------------------------------------------------------------------------

let inFlight = false

/** Pull `session.active_list` and apply it. Never overlaps itself — the tick and
 *  the interval can both land inside one slow round trip. */
export async function pullLiveSessionStatuses(): Promise<void> {
  if (inFlight || $gatewayState.get() !== 'open') {
    return
  }

  inFlight = true

  // Read the profile BEFORE the await: a switch mid-flight would otherwise file
  // this gateway's registry under the profile the user moved to.
  const profileKey = normalizeProfileKey($activeGatewayProfile.get())

  try {
    const response = await requestGateway<LiveSessionStatusResponse>('session.active_list', {})

    rehydrateLiveSessionStatuses(response, Date.now(), profileKey)
  } catch {
    // Older gateways may not expose session.active_list at all. Live stream
    // events still work as before; leave the current sidebar state untouched.
  } finally {
    inFlight = false
  }
}

const isVisible = (): boolean => typeof document === 'undefined' || document.visibilityState === 'visible'

let running = false

/**
 * Wire the snapshot pull and the coalesced list refresh to the gateway.
 *
 * Returns a teardown. Idempotent: a second call while running is a no-op, so a
 * shell that re-mounts under StrictMode cannot end up with two pollers.
 */
export function startLiveSessionSync(): () => void {
  if (running) {
    return () => {}
  }

  running = true

  let intervalId: null | number = null
  let listRefreshTimer: null | number = null
  let listRefreshedAt = 0

  const armInterval = () => {
    if (intervalId !== null) {
      window.clearInterval(intervalId)
    }

    const period = $changeEventsAvailable.get() ? LIVE_STATUS_BACKSTOP_MS : LIVE_STATUS_POLL_MS

    intervalId = window.setInterval(() => {
      // Hidden means backgrounded — on a phone that is a radio wake for a
      // sidebar nobody is looking at. `visibilitychange` re-pulls on return.
      if (isVisible()) {
        void pullLiveSessionStatuses()
      }
    }, period)
  }

  const refreshStoredLists = () => {
    listRefreshedAt = Date.now()
    void refreshSessions()
    void refreshMessagingSessions()
  }

  /** Trailing-edge, so the burst's LAST write always lands. */
  const scheduleStoredListRefresh = () => {
    // Against a gateway with no change watcher the surfaces keep their own
    // legacy polls; firing here too would only double them.
    if (!$changeEventsAvailable.get() || $gatewayState.get() !== 'open') {
      return
    }

    const since = Date.now() - listRefreshedAt

    if (since >= SESSIONS_LIST_TICK_GAP_MS) {
      refreshStoredLists()

      return
    }

    if (listRefreshTimer === null) {
      listRefreshTimer = window.setTimeout(() => {
        listRefreshTimer = null
        refreshStoredLists()
      }, SESSIONS_LIST_TICK_GAP_MS - since)
    }
  }

  const onVisibility = () => {
    if (isVisible()) {
      void pullLiveSessionStatuses()
    }
  }

  const unsubscribeGateway = $gatewayState.listen(state => {
    if (state !== 'open') {
      return
    }

    // The ids from the previous episode named runs on a socket that is gone;
    // `invalidateRuntimeBindings` (app/contrib/controller) has already cleared
    // the busy flags they pointed at, so keeping them could only mis-reap.
    resetLiveRuntimeTracking()
    void pullLiveSessionStatuses()

    // The on-connect reseed universal never had. `wipeSessionListsForGatewaySwitch`
    // covers a DELIBERATE switch and says so ("universal doesn't refresh session
    // lists on gateway open, so the switch does it"), but an auto-reconnect —
    // sleep/wake, a network blip, an expired ticket — goes through neither, and
    // no broadcast that landed while the socket was down is ever replayed. The
    // list stayed on whatever it held when the connection dropped, indefinitely,
    // unless the sidebar happened to re-run its own effect.
    refreshStoredLists()
  })

  // A `sessions.changed` broadcast is the cheap, immediate signal; the snapshot
  // is an in-memory read and the event is already floored to 2s server-side.
  const unsubscribeTick = $sessionsChangeTick.listen(() => {
    void pullLiveSessionStatuses()
    scheduleStoredListRefresh()
  })

  // The compat gate arms from `gateway.ready`, i.e. AFTER the socket opens —
  // re-arm the interval so a broadcasting backend drops to the backstop.
  const unsubscribeGate = $changeEventsAvailable.listen(() => armInterval())

  document.addEventListener('visibilitychange', onVisibility)
  armInterval()
  void pullLiveSessionStatuses()

  return () => {
    running = false
    unsubscribeGateway()
    unsubscribeTick()
    unsubscribeGate()
    document.removeEventListener('visibilitychange', onVisibility)

    if (intervalId !== null) {
      window.clearInterval(intervalId)
    }

    if (listRefreshTimer !== null) {
      window.clearTimeout(listRefreshTimer)
    }
  }
}
