/**
 * Telling a refused CREDENTIAL apart from a broken NETWORK, on the gateway socket.
 *
 * The reconnect supervisor gives those two completely different budgets: a
 * network fault is retried indefinitely (a closed laptop lid must recover on its
 * own), while a refused credential is terminal after a bounded number of
 * attempts, because retrying cannot change the answer. Misfiling one as the other
 * is the difference between a session that heals itself and a spinner that never
 * stops.
 *
 * Both signals below were being thrown away:
 *
 *  * The gateway closes the socket with **4401** (bad or missing credential) and
 *    **4403** (host/origin mismatch), but `transport/tauri-websocket.ts` dropped
 *    the close code, so nothing downstream could see them.
 *  * A credential refused during the *handshake* never becomes a close code at
 *    all. `/api/ws` refuses pre-accept, and uvicorn answers a pre-accept Starlette
 *    close as a bare HTTP status — so tungstenite reports `HTTP error: 403` as a
 *    connect ERROR. `isGatewayReauthRequired` is false for that, so it took the
 *    unbounded network ladder and retried a dead credential forever.
 *
 * Pure, so both rules are testable without a socket.
 */

/** Bad or missing credential (`hermes_cli/web_server.py`). */
export const WS_CLOSE_AUTH = 4401
/** Host or origin mismatch — also a credential problem from the client's side. */
export const WS_CLOSE_FORBIDDEN = 4403

/**
 * Did the gateway close this socket because it refused us?
 *
 * Deliberately narrow. Every other close code — 1006 (abnormal, the socket
 * dropped), 1011, 4410 (child exited) — is either a network fault or a
 * server-side condition that a retry can legitimately fix.
 */
export function closeCodeIsAuthFailure(code: number | undefined): boolean {
  return code === WS_CLOSE_AUTH || code === WS_CLOSE_FORBIDDEN
}

/**
 * Did the WebSocket *handshake* fail because the credential was refused?
 *
 * Matched on the tungstenite message because that is genuinely all there is: the
 * refusal happens before the socket exists, so there is no close frame and no
 * structured error to read. `transport/remote-pty.ts` already does the same for
 * the terminal socket; this is the gateway socket's copy of that rule.
 *
 * Anchored to the exact `HTTP error: <status>` shape so an unrelated message that
 * merely contains "401" — a URL, a port, a byte count — cannot be mistaken for a
 * refusal and strand a user whose connection was only ever flaky.
 */
export function handshakeErrorIsAuthFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''

  return /\bHTTP error:\s*(401|403)\b/i.test(message)
}

/**
 * The single question the reconnect loop asks: "was that the credential?"
 *
 * `closeCode` is the code from the last close on this socket, when there was one.
 */
export function isGatewayAuthFailure(error: unknown, closeCode?: number): boolean {
  return closeCodeIsAuthFailure(closeCode) || handshakeErrorIsAuthFailure(error)
}
