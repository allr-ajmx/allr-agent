import { emit } from '@tauri-apps/api/event'

import { IS_TAURI } from '@/lib/platform'
import type { GatewayMode } from '@/store/gateway-config'
import type { GatewayTarget } from '@/store/gateway-restore'

// The SEND half of cross-WebView gateway switching (the listener lives in
// store/gateway-switch-sync.ts). Split out because one of the initiators is
// gateway-restore.ts (the Android OAuth resume), and having it reach into the listener
// module would close the loop `restore → sync → soft-switch → restore` — exactly the
// cycle that graph is kept free of. This module imports nothing but types and the event
// API, so any store can depend on it.

export const SWITCH_EVENT = 'gateway://switched'

export interface GatewaySwitchedPayload {
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
export const WEBVIEW_ID = (() => {
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
 * Called by the initiating surface (gateway-configurator's `runConnect`) and by the
 * Android OAuth resume (`autoRestoreConnection`), which is an initiator too: the
 * sign-in navigated ONE webview away and back, so only that one came up on the new
 * gateway. Followers re-home through `softSwitchGateway` WITHOUT re-broadcasting, so
 * the "don't echo forever" guard is structural rather than a flag.
 */
export function broadcastGatewaySwitch(mode: GatewayMode, target: GatewayTarget): void {
  if (!IS_TAURI) {
    return
  }

  const payload: GatewaySwitchedPayload = { origin: WEBVIEW_ID, mode, target }

  // Best-effort: a failed broadcast must never fail the switch that just worked.
  void emit(SWITCH_EVENT, payload).catch(() => {})
}
