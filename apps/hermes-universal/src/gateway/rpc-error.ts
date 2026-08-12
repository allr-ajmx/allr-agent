/**
 * The rejection a gateway RPC produces, carrying the JSON-RPC `error.code` the
 * gateway actually sent.
 *
 * The client used to throw a bare `new Error(frame.error.message)`, which threw
 * the code away — so every "does this backend predate the method?" test had to
 * pattern-match English prose (`isMissingRpcMethod` in lib/gateway-rpc.ts), and
 * that match is both too narrow (a gateway that words `-32601` a fifth way
 * reads as a hard failure) and too wide (a genuine handler failure whose
 * message merely QUOTES a nested `-32601` — an MCP server behind a tool, say —
 * reads as "this backend is old" and permanently latches a degraded surface).
 * The code is on the wire in every one of those cases; keeping it is the fix.
 *
 * Lives in its own module, with no imports, so both the transport that mints it
 * and the predicates that read it can depend on it without a cycle.
 */

/** JSON-RPC 2.0 "Method not found". `tui_gateway/server.py handle_request()`
 *  answers exactly this for a method it has no handler for. */
export const JSON_RPC_METHOD_NOT_FOUND = -32601

export class GatewayRpcError extends Error {
  /** `error.code` from the JSON-RPC frame; null when the frame omitted it. */
  readonly code: null | number
  /** `error.data`, untouched. Nothing reads it yet — it is kept so a future
   *  structured refusal does not need this class changed again. */
  readonly data: unknown

  constructor(message: string, code: null | number = null, data: unknown = null) {
    super(message)
    this.name = 'GatewayRpcError'
    this.code = code
    this.data = data
  }
}

/**
 * The JSON-RPC code behind a rejection, or null when there is none.
 *
 * Null is NOT "no error": it means the rejection never came off the wire as a
 * JSON-RPC error frame (a transport failure, a timeout, a locally thrown
 * Error), so a caller that wants to know what the gateway said has to fall back
 * to the message.
 */
export function gatewayRpcErrorCode(error: unknown): null | number {
  return error instanceof GatewayRpcError && typeof error.code === 'number' ? error.code : null
}
