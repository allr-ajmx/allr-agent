/**
 * Where a surface lands from a standing start (MJXHRM-438).
 *
 * The phone's boot restore and the HUD's summon both go through this, so a
 * disagreement here is a HUD that opens on a different conversation than the app
 * it was summoned out of. Every case below seeds inputs that DISAGREE with the
 * expected answer — a remembered id is present in the route cases, and a route
 * is present in the remembered case — so none of them can pass by accident.
 */

import { describe, expect, it } from 'vitest'

import { landingSessionId, resolveSessionLanding } from './session-landing'

describe('resolveSessionLanding', () => {
  it('takes the route over a memory', () => {
    // Both are available and they disagree. The route is what the summoning
    // window explicitly asked for; a memory is only ever the fallback.
    expect(resolveSessionLanding('/abc', 'xyz')).toEqual({ id: 'abc', kind: 'route' })
  })

  it('falls back to the memory only from the new-chat route', () => {
    expect(resolveSessionLanding('/', 'xyz')).toEqual({ id: 'xyz', kind: 'remembered' })
  })

  it('is a new chat when there is nothing to come back to', () => {
    expect(resolveSessionLanding('/', null)).toEqual({ kind: 'new' })
  })

  // The regression this shape exists to prevent: a resolver handed the extracted
  // session id sees `null` for `/settings` exactly as it does for `/`, and would
  // answer `remembered` for both — pulling a user who deep-linked into Settings
  // onto a conversation the moment the gateway came up.
  it('leaves a surface that is on some other screen where it is', () => {
    expect(resolveSessionLanding('/settings', 'xyz')).toEqual({ kind: 'elsewhere' })
    expect(resolveSessionLanding('/command-center', 'xyz')).toEqual({ kind: 'elsewhere' })
    expect(resolveSessionLanding('/profiles', 'xyz')).toEqual({ kind: 'elsewhere' })
  })

  // `lastOpenedSessionId()` reads a persistentAtom out of localStorage, where a
  // truncated record deserializes to '' rather than to null — and `openSession('')`
  // is a resume for a session that cannot exist.
  it('does not treat an empty string as a remembered chat', () => {
    expect(resolveSessionLanding('/', '')).toEqual({ kind: 'new' })
  })

  it('does not treat an empty pathname as the new-chat route', () => {
    // Not `/`, so not a standing start. A caller with no pathname at all has not
    // told us it is on a blank chat, and guessing is how a memory gets spent on
    // a surface that was never showing a chat.
    expect(resolveSessionLanding('', 'xyz')).toEqual({ kind: 'elsewhere' })
  })
})

describe('landingSessionId', () => {
  it('names the session for the two landings that have one', () => {
    expect(landingSessionId({ id: 'abc', kind: 'route' })).toBe('abc')
    expect(landingSessionId({ id: 'xyz', kind: 'remembered' })).toBe('xyz')
  })

  it('names nothing for the two that do not', () => {
    expect(landingSessionId({ kind: 'new' })).toBeNull()
    expect(landingSessionId({ kind: 'elsewhere' })).toBeNull()
  })
})
