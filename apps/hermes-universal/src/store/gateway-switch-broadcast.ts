import { broadcastToPeers, type PeerBroadcast } from '@/lib/webview-broadcast'
import type { GatewayMode } from '@/store/gateway-config'
import type { GatewayTarget } from '@/store/gateway-restore'

// The SEND half of cross-WebView gateway switching (the listener lives in
// store/gateway-switch-sync.ts). Split out because one of the initiators is
// gateway-restore.ts (the Android OAuth resume), and having it reach into the listener
// module would close the loop `restore → sync → soft-switch → restore` — exactly the
// cycle that graph is kept free of. This module imports nothing but types and the
// broadcast leaf, so any store can depend on it.

export const SWITCH_EVENT = 'gateway://switched'

export interface GatewaySwitchedPayload extends PeerBroadcast {
  mode: GatewayMode
  /** The gateway to re-home onto. Non-secret — secrets stay in the keyring, and
   *  dialSavedTarget fetches them on the receiving side. */
  target: GatewayTarget
}

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
  broadcastToPeers<GatewaySwitchedPayload>(SWITCH_EVENT, { mode, target })
}
