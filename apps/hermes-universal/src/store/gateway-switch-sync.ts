import { emit, listen } from '@tauri-apps/api/event'

import { IS_TAURI } from '@/lib/platform'
import type { GatewayMode } from '@/store/gateway-config'
import { dialSavedTarget, type GatewayTarget } from '@/store/gateway-restore'
import { softSwitchGateway } from '@/store/gateway-soft-switch'

// Cross-WebView gateway switching.
//
// Every WebView the app opens — the main shell, an Android native activity screen
// (`?win=activity`), a desktop pop-out (`?win=secondary`) — boots src/main.tsx and
// builds its OWN JsonRpcGatewayClient over its own Rust-backed socket (see
// store/gateway.ts, where `client` is module-local). $gatewaySwitching is an
// in-memory atom, so it is per-WebView too. Without this module a switch driven
// from one surface leaves every other surface quietly talking to the OLD backend.
//
// So the initiator broadcasts, and every other WebView re-homes onto the same
// gateway. The event name follows the `ssh://…` convention in store/ssh-backend.ts,
// and the listener is wired by a side-effect import in main.tsx exactly like
// store/event-router.

const SWITCH_EVENT = 'gateway://switched'

interface GatewaySwitchedPayload {
  /** The sending WebView, so a receiver can drop its own echo (emit is global). */
  origin: string
  mode: GatewayMode
  /** The gateway to re-home onto. Non-secret — secrets stay in the keyring, and
   *  dialSavedTarget fetches them on the receiving side. */
  target: GatewayTarget
}

// Identifies THIS WebView. Deliberately not the Tauri window label: the mobile
// activity screens are extra webviews inside one window and can share a label,
// which would make them discard each other's events as self-echo.
const WEBVIEW_ID = (() => {
  try {
    return crypto.randomUUID()
  } catch {
    return `wv-${Date.now()}-${Math.random().toString(36).slice(2)}`
  }
})()

/**
 * Tell every other WebView that this one just moved to another gateway.
 *
 * Call AFTER the switch has succeeded — the payload describes a gateway that is
 * known to be reachable, so followers are not sent chasing a dial that just failed.
 *
 * Only the initiating surface calls this (gateway-configurator's `runConnect`).
 * Followers re-home through `softSwitchGateway` WITHOUT re-broadcasting, so the
 * "don't echo forever" guard is structural rather than a flag — a second caller of
 * softSwitchGateway would need to broadcast here too.
 */
export function broadcastGatewaySwitch(mode: GatewayMode, target: GatewayTarget): void {
  if (!IS_TAURI) {
    return
  }

  const payload: GatewaySwitchedPayload = { origin: WEBVIEW_ID, mode, target }

  // Best-effort: a failed broadcast must never fail the switch that just worked.
  void emit(SWITCH_EVENT, payload).catch(() => {})
}

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

  void listen<GatewaySwitchedPayload>(SWITCH_EVENT, event => {
    const payload = event.payload

    // Drop our own echo, and anything malformed. The shape check is not paranoia:
    // acting on a payload with no target would tear this WebView's connection down
    // and then dial nothing, which is strictly worse than ignoring the event.
    if (!payload?.origin || !payload.mode || !payload.target || payload.origin === WEBVIEW_ID) {
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
