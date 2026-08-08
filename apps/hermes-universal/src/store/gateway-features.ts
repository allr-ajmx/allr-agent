import { type Connection, connectionCacheKey } from '@/store/gateway-config'
import { httpRequest } from '@/transport/http'

// What the backend can do, read once from `/api/health`.
//
// This exists because a missing WebSocket route is invisible on the wire. Starlette
// closes an unmatched upgrade pre-accept and uvicorn renders EVERY pre-accept close
// as a bare `403 Forbidden` — so "this gateway has no `/api/shell-pty`" arrives
// looking exactly like "your session expired". Asking `/api/health` first is the only
// way to tell them apart, which is why the terminal probes before it dials.
//
// `/api/health` is on the public allowlist (hermes_cli/dashboard_auth/public_paths.py),
// so this works before sign-in, gated or not.

export interface GatewayFeatures {
  /** `/api/shell-pty` — the gateway-hosted shell behind the right-pane terminal. */
  shellPty: boolean
  /** `/api/shell-pty?attach=` keeps the shell alive across WS drops and replays a
   *  ring buffer on reattach. Absent on older gateways that only do the ephemeral
   *  shell — so we only send an attach token when this is advertised. */
  shellPtyReattach: boolean
}

const NONE: GatewayFeatures = { shellPty: false, shellPtyReattach: false }

/** Successful probes only. A gateway is asked once per app run, not once per terminal. */
const cache = new Map<string, Promise<GatewayFeatures>>()

async function probe(baseUrl: string): Promise<GatewayFeatures> {
  const res = await httpRequest('GET', `${baseUrl}/api/health`, { timeoutMs: 8000 })

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`GET /api/health → HTTP ${res.status}`)
  }

  const body = JSON.parse(res.body) as { features?: Record<string, unknown> }

  // An older gateway answers 200 with no `features` at all. Absence is the answer:
  // it predates the endpoint, so the capability is off.
  return {
    shellPty: body.features?.shell_pty === true,
    shellPtyReattach: body.features?.shell_pty_reattach === true
  }
}

/**
 * The gateway's advertised capabilities, cached per backend identity.
 *
 * Never rejects — a gateway we cannot reach or cannot parse is treated as having
 * nothing, which is the safe read for "should I dial this endpoint". Failures are
 * NOT cached, so Restart re-probes a gateway that has since been upgraded.
 */
export function gatewayFeatures(conn: Connection): Promise<GatewayFeatures> {
  const key = connectionCacheKey(conn)
  const hit = cache.get(key)

  if (hit) {
    return hit
  }

  const pending = probe(conn.baseUrl).catch(() => {
    cache.delete(key)

    return NONE
  })

  cache.set(key, pending)

  return pending
}

/** Drop the cached probe for one backend — the Restart path, so a gateway upgraded
 *  mid-session is re-read instead of staying "no terminal API" until relaunch. */
export function forgetGatewayFeatures(conn: Connection | null): void {
  if (conn) {
    cache.delete(connectionCacheKey(conn))
  }
}
