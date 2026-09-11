import { expect, it } from 'vitest'

import { LEGACY_SESSION_TOKEN_HEADER, SESSION_TOKEN_HEADER, sessionTokenHeaders } from '@/lib/session-token-header'

// The gateway on the other end deploys on its own schedule. One built before the
// Allr rename reads only `X-Hermes-Session-Token`; a current one reads
// `X-Allr-Session-Token`. Token mode carries no other credential, so sending the
// wrong single name is indistinguishable from having no token at all.

it('sends the token under both names', () => {
  expect(sessionTokenHeaders('TOK')).toEqual({
    [SESSION_TOKEN_HEADER]: 'TOK',
    [LEGACY_SESSION_TOKEN_HEADER]: 'TOK'
  })
})

it('never sends two different values', () => {
  const headers = sessionTokenHeaders('TOK')

  expect(new Set(Object.values(headers)).size).toBe(1)
})

it('yields nothing for a missing token so callers can spread unconditionally', () => {
  // A header present but empty reads as "authenticated with the empty string",
  // which the gateway compares against a real token and rejects — the same
  // outcome as no header, but it costs a round trip to find out.
  expect(sessionTokenHeaders(null)).toEqual({})
  expect(sessionTokenHeaders(undefined)).toEqual({})
  expect(sessionTokenHeaders('')).toEqual({})
})
