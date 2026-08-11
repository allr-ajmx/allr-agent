import { translateNow } from '@/i18n'
import { queryClient } from '@/lib/query-client'
import { clearArtifactRegistry } from '@/store/artifacts'
import { resetChat } from '@/store/chat'
import { $connection, beginGatewaySwitch, disconnect, endGatewaySwitch } from '@/store/connection'
import { setCronJobs } from '@/store/cron'
import { closeGateway } from '@/store/gateway'
import type { Connection, GatewayMode } from '@/store/gateway-config'
import { dialSavedTarget, type GatewayTarget, loadGatewayTarget } from '@/store/gateway-restore'
import { $gatewayMode, $gatewaySwitching } from '@/store/gateway-switch'
import { resetLiveRuntimeTracking } from '@/store/live-session-status'
import { resetLiveSync } from '@/store/live-sync'
import { stopLocalBackend } from '@/store/local-backend'
import { notify, notifyError } from '@/store/notifications'
import { closeAllPreviewTabs } from '@/store/preview'
import {
  $activeStoredSessionId,
  $messagingSessions,
  $sessions,
  $sessionSearch,
  $sessionsLoading,
  $sessionsTotal,
  $unreadFinishedSessionIds,
  refreshMessagingSessions,
  refreshSessions,
  resetSessionsPaging,
  sessionMatchesStoredId
} from '@/store/session'
import { clearAllSessionStates, resetTileRuntimeBindings } from '@/store/session-states'
import { resetWorkspaceCwd } from '@/store/workspace-events'

// The soft gateway switch: re-home the running app onto another gateway in place.
// Split out of store/gateway-switch.ts (which only holds the persisted mode) because
// it reaches into the whole session/chat surface, while the mode store is imported
// from the boot-restore path — keeping this module out of that graph avoids a cycle.

/**
 * Clear gateway-bound UI state so a soft switch doesn't keep painting the previous
 * backend's rows.
 *
 * Sessions live in nanostores (not React Query) and `refreshSessions` only replaces
 * the list once it lands, so without an explicit wipe the sidebar shows the old
 * gateway's sessions until then. React Query caches go with them.
 *
 * Deliberately does NOT navigate or open a fresh chat: that would close route
 * overlays (Settings, the gateway popover) the user is standing in. Chat state is
 * cleared in place and the URL is left alone.
 */
export function wipeSessionListsForGatewaySwitch(): void {
  $sessions.set([])
  $sessionsTotal.set(0)
  $sessionSearch.set([])
  $messagingSessions.set([])
  $unreadFinishedSessionIds.set([])
  setCronJobs([])
  // Clearing $sessionStates also clears $workingSessionIds / $attentionSessionIds
  // (computed off it) and the stalled ids it owns.
  clearAllSessionStates()
  // Runtime ids belong to the old backend — tiles must re-bind against the new one.
  resetTileRuntimeBindings()
  // The new gateway re-advertises `change_events` on its own gateway.ready. A
  // stale `true` would leave every consumer on its slow backstop against a
  // backend that never broadcasts (store/live-sync.ts).
  resetLiveSync()
  // The live-runtime ids the rehydrate snapshot remembers belong to the old
  // backend's registry, and `clearAllSessionStates()` just dropped the slices
  // they point at — keeping them could only reap sessions that no longer exist.
  resetLiveRuntimeTracking()
  resetSessionsPaging()
  // Artifacts are keyed by sessions on the PREVIOUS backend, so both the
  // registry and any preview tab pointing into it go with them. Without this an
  // artifact tab survives the switch naming an id the new gateway has never
  // heard of, and re-opens as "artifact unavailable" — or worse, silently
  // collides with a same-shaped id over there.
  clearArtifactRegistry()

  $activeStoredSessionId.set(null)
  resetChat()
  // The workspace root came from the old backend's filesystem.
  resetWorkspaceCwd()
  // …and so did every open preview tab. A preview reads and WRITES through
  // `/api/fs/*` on whichever gateway is current, so a surviving tab shows the
  // old backend's bytes over the new backend's path: hitting save either
  // recreates a file that only existed over there or overwrites a same-named
  // one here. The artifact half of this was already handled above
  // (`clearArtifactRegistry`); file tabs were the half that wasn't.
  closeAllPreviewTabs()

  // Sidebar skeletons until refreshSessions lands.
  $sessionsLoading.set(true)
  // Blunt, matching the profile-swap precedent in store/profiles.ts: universal has
  // no gateway-scoped key partition, so everything cached is re-fetched.
  void queryClient.invalidateQueries()
}

/**
 * True when `storedSessionId` is absent from the session list currently loaded.
 *
 * Call only once the new gateway's list has landed — an empty list mid-refresh
 * would read as "everything is missing".
 */
export function sessionMissingFromCurrentGateway(storedSessionId: string): boolean {
  return !$sessions.get().some(session => sessionMatchesStoredId(session, storedSessionId))
}

/**
 * Tell the user their chat did not come across, once the new gateway's list is in.
 *
 * The wipe has already reset the chat and cleared the active id, so every surface
 * is sitting on a fresh session by this point — what is missing is the reason why,
 * which otherwise reads as the app having silently dropped their conversation.
 * Sessions are per-backend, so a chat existing on both gateways is the exception.
 */
function warnIfSessionMissingAfterSwitch(previousSessionId: null | string): void {
  if (!previousSessionId || !sessionMissingFromCurrentGateway(previousSessionId)) {
    return
  }

  notify({
    kind: 'warning',
    title: translateNow('settings.gateway.sessionMissingTitle'),
    message: translateNow('settings.gateway.sessionMissingMessage')
  })
}

/**
 * Recover from a switch whose dial failed.
 *
 * Rolls back onto the gateway we came from when there is one, leaving the user where
 * they started with an error rather than nowhere. Otherwise — a first-ever connect,
 * or a rollback that fails in turn — `disconnect()` clears `$hasConnected`, which is
 * what drops the root gate to the connect screen (see mobile-controller).
 *
 * Runs INSIDE the switch, before `$gatewaySwitching` is released, so the shell holds
 * its mounted state across the recovery instead of flashing the connecting screen.
 */
async function rollbackFailedSwitch(
  cause: unknown,
  previous: Connection | null,
  previousTarget: GatewayTarget | null
): Promise<void> {
  if (!previous || !previousTarget) {
    disconnect()

    return
  }

  try {
    // Non-interactive: the user is already looking at one failure; a rollback must
    // not raise a fresh SSH passphrase / host-key prompt on top of it.
    await dialSavedTarget(previousTarget)
    // The lists were wiped for a switch that never happened — refill them.
    await Promise.all([refreshSessions().catch(() => {}), refreshMessagingSessions().catch(() => {})])
    // Titled for what the user attempted; the body carries why it failed.
    notifyError(cause, translateNow('settings.gateway.switchFailed'))
  } catch {
    // Nothing left to stand on: the old gateway is gone too.
    disconnect()
  }
}

/**
 * Soft gateway switch: wipe → drop the socket → re-dial IN PLACE.
 *
 * Never calls `disconnect()`: that clears `$hasConnected` and drops the root gate to
 * the connect picker. Here `$hasConnected` stays latched and `$gatewaySwitching`
 * gates the root gates, while begin/endGatewaySwitch stands the reconnect supervisor
 * down — so the shell, Settings and the gateway popover all stay mounted across the
 * swap.
 *
 * A FAILED dial does not leave the app stranded. The wipe and `closeGateway()` both
 * happen before the dial, so without recovery a failure means an emptied list and a
 * dead socket — easy to hit, since an SSH dial runs 45-90s and can fail on host key,
 * passphrase or timeout. So on failure we roll back onto the gateway we came from
 * (`dialSavedTarget`, which also restores `$gatewayMode`), and fall back to
 * `disconnect()` — the home / connect-picker path — when there is nothing to roll
 * back to, or when the rollback dial fails too.
 *
 * Re-throws whatever `dial` threw either way, so the caller still surfaces its
 * failure toast; `$connectionError` is set by the connect* helpers.
 */
export async function softSwitchGateway(mode: GatewayMode, dial: () => Promise<void>): Promise<void> {
  // Snapshot the gateway we are leaving BEFORE anything tears it down: `dial` writes
  // $connection itself, and a connect* only persists its target once it has succeeded,
  // so after this point neither is still the old one.
  const previous = $connection.get()
  const previousTarget = loadGatewayTarget()
  // The wipe nulls this, so grab it first: it is what tells us, once the new
  // gateway's list has landed, whether the chat the user was on came across.
  const previousSessionId = $activeStoredSessionId.get()

  $gatewaySwitching.set(true)
  beginGatewaySwitch()
  wipeSessionListsForGatewaySwitch()

  try {
    // Leaving a local-spawned backend: stop the child, or it outlives the switch.
    if ($connection.get()?.mode === 'local') {
      await stopLocalBackend().catch(() => {})
    }

    closeGateway()
    $gatewayMode.set(mode)
    await dial()
    // Universal doesn't refresh session lists on gateway open, so the switch does it.
    let listed = true
    await Promise.all([
      refreshSessions().catch(() => {
        listed = false
      }),
      refreshMessagingSessions().catch(() => {})
    ])

    // Only when the list actually landed: a failed refresh leaves it empty, which
    // is indistinguishable from "the new gateway has none" and would make us claim
    // the user's session is gone on nothing more than a dropped request.
    if (listed) {
      warnIfSessionMissingAfterSwitch(previousSessionId)
    }
  } catch (err) {
    await rollbackFailedSwitch(err, previous, previousTarget)

    throw err
  } finally {
    $sessionsLoading.set(false)
    // Imperative guard down before the reactive one, so the root gates never un-gate
    // while the reconnect supervisor is still suspended.
    endGatewaySwitch()
    $gatewaySwitching.set(false)
  }
}
