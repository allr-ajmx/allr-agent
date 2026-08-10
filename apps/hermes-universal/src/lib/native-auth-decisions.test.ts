import { expect, test } from 'vitest'

import {
  authHeaders,
  oauthGuardMayHardFail,
  oauthSessionIsLive,
  resolveOauthRestAuth,
  statusSupportsNativeFlow
} from './native-auth-decisions'

// ── capability detection ─────────────────────────────────────────────────────

test('the native flow is offered only when /api/status names it', () => {
  expect(statusSupportsNativeFlow({ auth_flows: ['cookie', 'native_pkce'] })).toBe(true)
  expect(statusSupportsNativeFlow({ auth_flows: ['cookie'] })).toBe(false)
})

test('a gateway that predates the native routes falls back rather than erroring', () => {
  // The absence of auth_flows IS the compatibility mechanism — no version compare.
  expect(statusSupportsNativeFlow({})).toBe(false)
  expect(statusSupportsNativeFlow(null)).toBe(false)
  expect(statusSupportsNativeFlow(undefined)).toBe(false)
  expect(statusSupportsNativeFlow({ auth_flows: 'native_pkce' } as never)).toBe(false)
})

// ── liveness: bearer OR cookie ───────────────────────────────────────────────

test('either credential counts as a live session', () => {
  expect(oauthSessionIsLive(true, false)).toBe(true)
  expect(oauthSessionIsLive(false, true)).toBe(true)
  expect(oauthSessionIsLive(true, true)).toBe(true)
  expect(oauthSessionIsLive(false, false)).toBe(false)
})

test('a completed native login is live even though it left no cookie', () => {
  // Desktop's bug: gating on the cookie alone reported "signed out" right after
  // a successful native sign-in and looped the user back to the browser.
  expect(oauthSessionIsLive(true, false)).toBe(true)
})

// ── bearer-vs-cookie routing ─────────────────────────────────────────────────

test('a present bearer wins; anything falsy falls back to the cookie jar', () => {
  expect(resolveOauthRestAuth('at')).toEqual({ kind: 'bearer', token: 'at' })
  expect(resolveOauthRestAuth(null)).toEqual({ kind: 'cookie' })
  expect(resolveOauthRestAuth(undefined)).toEqual({ kind: 'cookie' })
  // An empty string is "no session", not a bearer of length zero.
  expect(resolveOauthRestAuth('')).toEqual({ kind: 'cookie' })
})

test('only the bearer choice contributes a header — the cookie rides in Rust', () => {
  expect(authHeaders({ kind: 'bearer', token: 'at' })).toEqual({ Authorization: 'Bearer at' })
  expect(authHeaders({ kind: 'cookie' })).toEqual({})
})

// ── the hard-fail guard ──────────────────────────────────────────────────────

test('an all-password gateway must never be hard-failed for "not signed in"', () => {
  expect(oauthGuardMayHardFail([{ name: 'basic', supports_password: true }])).toBe(false)
  expect(
    oauthGuardMayHardFail([
      { name: 'basic', supports_password: true },
      { name: 'ldap', supports_password: true }
    ])
  ).toBe(false)
})

test('a gateway advertising any redirect provider keeps the strict guard', () => {
  expect(
    oauthGuardMayHardFail([
      { name: 'basic', supports_password: true },
      { name: 'nous', supports_password: false }
    ])
  ).toBe(true)
  expect(oauthGuardMayHardFail([{ name: 'nous' }])).toBe(true)
})

test('an unknown provider list stays strict so older backends are unaffected', () => {
  expect(oauthGuardMayHardFail(null)).toBe(true)
  expect(oauthGuardMayHardFail(undefined)).toBe(true)
  expect(oauthGuardMayHardFail([])).toBe(true)
  // Entries with no name carry no information either way.
  expect(oauthGuardMayHardFail([{ supports_password: true }])).toBe(true)
})
