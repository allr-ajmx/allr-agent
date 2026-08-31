import { describe, expect, it } from 'vitest'

import {
  closeCodeIsAuthFailure,
  handshakeErrorIsAuthFailure,
  isGatewayAuthFailure,
  WS_CLOSE_AUTH,
  WS_CLOSE_FORBIDDEN
} from './gateway-auth-failure'

// Everything here decides ONE thing: does the reconnect supervisor spend its
// bounded auth budget, or its unbounded network ladder? Filing a refused
// credential as a network fault is what made a failed login retry forever.

describe('closeCodeIsAuthFailure', () => {
  it.each([WS_CLOSE_AUTH, WS_CLOSE_FORBIDDEN])('treats close code %i as a refusal', code => {
    expect(closeCodeIsAuthFailure(code)).toBe(true)
  })

  // A dropped socket, a crashed child, a gateway with no PTY — none of these say
  // anything about the credential, and stopping on them would strand a user whose
  // connection was only ever flaky.
  it.each([1000, 1006, 1011, 4404, 4408, 4409, 4410])('treats close code %i as retryable', code => {
    expect(closeCodeIsAuthFailure(code)).toBe(false)
  })

  it('treats a missing close code as retryable', () => {
    expect(closeCodeIsAuthFailure(undefined)).toBe(false)
  })
})

describe('handshakeErrorIsAuthFailure', () => {
  // `/api/ws` refuses PRE-ACCEPT, so uvicorn answers with a bare HTTP status and
  // tungstenite reports a connect error. There is no close frame to read at all —
  // this string is the only evidence that the credential was refused.
  it.each(['HTTP error: 401 Unauthorized', 'HTTP error: 403', 'http error: 403 Forbidden'])(
    'recognises %j as a refusal',
    message => {
      expect(handshakeErrorIsAuthFailure(new Error(message))).toBe(true)
    }
  )

  it.each([
    'HTTP error: 500 Internal Server Error',
    'HTTP error: 502',
    'error sending request: dns error',
    'connection refused',
    'WebSocket closed'
  ])('does not mistake %j for a refusal', message => {
    expect(handshakeErrorIsAuthFailure(new Error(message))).toBe(false)
  })

  // The anchor earns its keep here: a port, a byte count or a URL containing 401
  // must not read as a refusal and end the user's session.
  it.each([
    'connect ECONNREFUSED 10.0.0.5:4013',
    'read 401 bytes before EOF',
    'could not reach https://gw.example.com:8403/api/ws'
  ])('does not match an incidental %j', message => {
    expect(handshakeErrorIsAuthFailure(new Error(message))).toBe(false)
  })

  it('tolerates a non-Error', () => {
    expect(handshakeErrorIsAuthFailure('HTTP error: 401')).toBe(true)
    expect(handshakeErrorIsAuthFailure(null)).toBe(false)
    expect(handshakeErrorIsAuthFailure(undefined)).toBe(false)
  })
})

describe('isGatewayAuthFailure', () => {
  it('accepts either signal on its own', () => {
    expect(isGatewayAuthFailure(new Error('WebSocket closed'), WS_CLOSE_AUTH)).toBe(true)
    expect(isGatewayAuthFailure(new Error('HTTP error: 403'), undefined)).toBe(true)
  })

  it('is false when neither signal is present', () => {
    expect(isGatewayAuthFailure(new Error('WebSocket closed'), 1006)).toBe(false)
  })
})
