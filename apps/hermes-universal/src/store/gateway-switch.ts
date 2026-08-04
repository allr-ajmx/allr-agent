import { type Codec, persistentAtom } from '@/lib/persisted'
import { atom } from '@/store/atom'
import type { GatewayMode } from '@/store/gateway-config'

// Gateway-mode switching (E1). The app talks to a backend in one of four modes —
// local (spawned), remote (URL), cloud (portal-discovered), ssh (tunnelled to a
// backend on a remote host). This holds the chosen mode (persisted). Two ways to
// change it:
//   • setGatewayMode — mode-only, no teardown. Used by "Save for next restart":
//     persist the choice without dialling anything.
//   • softSwitchGateway (store/gateway-soft-switch.ts) — the real switch: re-home
//     the live app onto another gateway IN PLACE (desktop's soft switch), without
//     disconnect(). It lives in its own module because it reaches into the session /
//     chat stores, while this one is imported from the connection-restore path —
//     keeping it a leaf keeps that graph free of import cycles.

// A whitelist, so a corrupt or future value degrades to the safest mode rather
// than being trusted. Every new mode MUST be added here: a missing entry does not
// fail loudly, it silently reopens the app in 'remote'.
const modeCodec: Codec<GatewayMode> = {
  decode: raw => (raw === 'local' || raw === 'cloud' || raw === 'ssh' ? raw : 'remote'),
  encode: value => value
}

/** The last-selected gateway mode; persisted so the app reopens into it. */
export const $gatewayMode = persistentAtom<GatewayMode>('hermes.gateway.mode', 'remote', modeCodec)

/** True while a soft switch is mid-flight (wipe → re-dial). The root gates read it
 *  so the shell stays mounted instead of bouncing to the connect / connecting
 *  screen for the second the socket is down. */
export const $gatewaySwitching = atom(false)

/** Set the gateway mode WITHOUT touching the live connection (pending selection).
 *  Picking a mode card in Settings is a pending choice; connecting is a separate,
 *  explicit action. */
export function setGatewayMode(mode: GatewayMode): void {
  $gatewayMode.set(mode)
}
