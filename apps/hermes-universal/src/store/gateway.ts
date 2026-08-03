import { type ConnectionState, type GatewayEvent, JsonRpcGatewayClient, type WebSocketLike } from '@/gateway'
import type { HermesGateway } from '@/hermes'
import { atom } from '@/store/atom'
import { type Connection, resolveWsUrl } from '@/store/gateway-config'
import { TauriWebSocket } from '@/transport/tauri-websocket'

// Whole-stream event listeners. THE session event router registers here (see
// store/event-router.ts, wired from app/contrib/controller.tsx) rather than
// being imported directly, so gateway.ts never statically imports the
// session-states/profile graph — a static import reorders module init and trips
// the `@/hermes` `_apiProfile` TDZ cycle in tests.
const extraEventListeners = new Set<(event: GatewayEvent) => void>()

/** Add a whole-stream gateway event listener. Returns a disposer. */
export function addGatewayEventListener(listener: (event: GatewayEvent) => void): () => void {
  extraEventListeners.add(listener)

  return () => {
    extraEventListeners.delete(listener)
  }
}

// Holds the single live gateway client. The client itself is the reused
// JsonRpcGatewayClient (vendored from apps/shared) — the ONLY change vs the
// desktop is the socketFactory: the socket is an IPC-backed TauriWebSocket whose
// real connection lives in Rust (CORS-free). Correlation/timeout/reconnect logic
// is unchanged.

let client: JsonRpcGatewayClient | null = null

export const $gatewayState = atom<ConnectionState>('idle')

// Compat shim for ported desktop code that reads the live client reactively via
// `useStore($gateway)` (e.g. the Capabilities/MCP tab). Desktop's `$gateway` is
// an atom<HermesGateway | null>; universal keeps the client module-local, so we
// mirror it into this atom on connect/close. The concrete instance is the base
// JsonRpcGatewayClient (HermesGateway adds no members), so the cast is sound.
export const $gateway = atom<HermesGateway | null>(null)

export async function connectGateway(conn: Connection): Promise<void> {
  client?.close()

  // Mint the ticket BEFORE constructing the socket so a stale one is never used.
  // resolveWsUrl (store/gateway-config) handles none/token/ticket/oauth; oauth
  // raises GatewayReauthRequiredError when the session is dead.
  const wsUrl = await resolveWsUrl(conn)

  const next = new JsonRpcGatewayClient({
    socketFactory: (url: string) => new TauriWebSocket(url) as unknown as WebSocketLike
  })

  next.onState(state => $gatewayState.set(state))
  next.onAny(event => {
    // One stream, one set of listeners. The session event router is registered
    // via addGatewayEventListener rather than imported, keeping gateway.ts free
    // of the heavy session-states/profile graph that would reorder module init.
    for (const listener of extraEventListeners) {
      listener(event)
    }
  })
  client = next
  $gateway.set(next as HermesGateway)

  await next.connect(wsUrl)
}

export function closeGateway(): void {
  client?.close()
  client = null
  $gateway.set(null)
  $gatewayState.set('closed')
}

export function requestGateway<T = unknown>(
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs?: number
): Promise<T> {
  if (!client) {
    return Promise.reject(new Error('Hermes gateway is not connected'))
  }

  return client.request<T>(method, params, timeoutMs)
}

// The live gateway client, typed as HermesGateway for the ported composer
// completion hooks (use-at-completions / use-slash-completions) which take a
// `gateway` prop and only ever call `gateway.request(method, params)`. The
// concrete instance is a base JsonRpcGatewayClient (HermesGateway adds no
// members), so the cast is sound; the socket underneath is the Tauri IPC one.
// Returns null until connected.
export function getGatewayClient(): HermesGateway | null {
  return client as HermesGateway | null
}

// Subscribe to a single server-push event type (e.g. streaming progress events
// that don't flow through the chat reducer). Returns an unsubscribe fn; a no-op
// when no client is live. Used by the pet-generate flow (pet.*.progress).
export function subscribeGateway<P = unknown>(type: string, handler: (payload: P) => void): () => void {
  if (!client) {
    return () => {}
  }

  return client.on<P>(type, event => handler(event.payload as P))
}
