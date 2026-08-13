import { IS_TAURI } from '@/lib/platform'
import { onPeerBroadcast } from '@/lib/webview-broadcast'
import { dialSavedTarget } from '@/store/gateway-restore'
import { softSwitchGateway } from '@/store/gateway-soft-switch'
import { type GatewaySwitchedPayload, SWITCH_EVENT } from '@/store/gateway-switch-broadcast'

// Cross-WebView gateway switching.
//
// Every WebView the app opens — the main shell, an Android native activity screen
// (`?win=activity`), a desktop pop-out (`?win=secondary`) — boots src/main.tsx and
// builds its OWN JsonRpcGatewayClient over its own Rust-backed socket (see
// store/gateway.ts, where `client` is module-local). $gatewaySwitching is an
// in-memory atom, so it is per-WebView too. Without this module a switch driven
// from one surface leaves every other surface quietly talking to the OLD backend.
//
// So the initiator broadcasts (store/gateway-switch-broadcast.ts — the send half lives
// in its own leaf module so gateway-restore can broadcast without an import cycle), and
// every other WebView re-homes onto the same gateway here. The event name follows the
// `ssh://…` convention in store/ssh-backend.ts, and the listener is wired by a
// side-effect import in main.tsx exactly like store/event-router.

let started = false

/**
 * Listen for another WebView's switch and re-home this one onto the same gateway.
 *
 * Idempotent — main.tsx imports this for its side effect, and a re-import (HMR,
 * a test) must not stack listeners.
 *
 * The re-home runs through `softSwitchGateway`, so it inherits the whole
 * machinery: the session/chat/cron/tile wipe, the $gatewaySwitching gate that keeps
 * this WebView's shell mounted instead of bouncing to the picker, the reconnect
 * supervisor stand-down, and the rollback if the follower's own dial fails.
 */
export function initGatewaySwitchSync(): void {
  if (started || !IS_TAURI) {
    return
  }

  started = true

  // `onPeerBroadcast` has already dropped our own echo (`emit` is global).
  onPeerBroadcast<GatewaySwitchedPayload>(SWITCH_EVENT, payload => {
    // Anything malformed goes too. The shape check is not paranoia: acting on a
    // payload with no target would tear this WebView's connection down and then
    // dial nothing, which is strictly worse than ignoring the event.
    if (!payload.mode || !payload.target) {
      return
    }

    // Non-interactive by construction (dialSavedTarget's default): the user answered
    // any SSH prompt on the initiating surface; a follower must not raise its own.
    void softSwitchGateway(payload.mode, () => dialSavedTarget(payload.target)).catch(() => {
      // softSwitchGateway has already rolled this WebView back or dropped it to the
      // connect screen, and the initiator owns the user-facing error.
    })
  })
}

initGatewaySwitchSync()
