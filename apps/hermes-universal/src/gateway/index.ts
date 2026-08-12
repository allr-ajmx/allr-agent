// VENDORED from apps/shared/src. Historical: the app used to sit outside the npm
// workspace, so a `@hermes/shared` dependency could not be resolved. It is a
// workspace member now, so this copy can be replaced with a real import.
// Until then, keep in sync with apps/shared if that gateway client changes.
export {
  type ConnectionState,
  type GatewayClientOptions,
  type GatewayEvent,
  type GatewayEventName,
  type GatewayRequestId,
  type JsonRpcFrame,
  JsonRpcGatewayClient,
  type WebSocketLike
} from './json-rpc-gateway'
export { GatewayRpcError, gatewayRpcErrorCode, JSON_RPC_METHOD_NOT_FOUND } from './rpc-error'
export {
  buildHermesWebSocketUrl,
  type GatewayAuthMode,
  GatewayReauthRequiredError,
  type GatewayWsConnection,
  type HermesWebSocketUrlOptions,
  isGatewayReauthRequired,
  resolveGatewayWsUrl,
  type ResolveGatewayWsUrlDeps,
  type WebSocketAuthParam
} from './websocket-url'
