import { queryClient } from '@/lib/query-client'
import { resetChat } from '@/store/chat'
import { $connection, beginGatewaySwitch, endGatewaySwitch } from '@/store/connection'
import { setCronJobs } from '@/store/cron'
import { closeGateway } from '@/store/gateway'
import type { GatewayMode } from '@/store/gateway-config'
import { $gatewayMode, $gatewaySwitching } from '@/store/gateway-switch'
import { stopLocalBackend } from '@/store/local-backend'
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
  resetSessionsPage
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
  resetSessionsPage()

  $activeStoredSessionId.set(null)
  resetChat()
  // The workspace root came from the old backend's filesystem.
  resetWorkspaceCwd()

  // Sidebar skeletons until refreshSessions lands.
  $sessionsLoading.set(true)
  // Blunt, matching the profile-swap precedent in store/profiles.ts: universal has
  // no gateway-scoped key partition, so everything cached is re-fetched.
  void queryClient.invalidateQueries()
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
 * Re-throws whatever `dial` throws so the caller still surfaces its failure toast;
 * `$connectionError` is set by the connect* helpers.
 */
export async function softSwitchGateway(mode: GatewayMode, dial: () => Promise<void>): Promise<void> {
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
    await Promise.all([refreshSessions().catch(() => {}), refreshMessagingSessions().catch(() => {})])
  } finally {
    $sessionsLoading.set(false)
    // Imperative guard down before the reactive one, so the root gates never un-gate
    // while the reconnect supervisor is still suspended.
    endGatewaySwitch()
    $gatewaySwitching.set(false)
  }
}
