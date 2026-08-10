import { describe, expect, it } from 'vitest'

import { isValidProfileName, RESERVED_PROFILE_NAMES } from './profile-name'

describe('isValidProfileName', () => {
  it('accepts the shapes the backend accepts', () => {
    expect(isValidProfileName('work')).toBe(true)
    expect(isValidProfileName('work-2')).toBe(true)
    expect(isValidProfileName('a_b-9')).toBe(true)
    expect(isValidProfileName('0')).toBe(true)
    expect(isValidProfileName(`a${'b'.repeat(63)}`)).toBe(true)
  })

  it('rejects the shapes the backend rejects', () => {
    expect(isValidProfileName('')).toBe(false)
    expect(isValidProfileName('-lead')).toBe(false)
    expect(isValidProfileName('_lead')).toBe(false)
    expect(isValidProfileName('Work')).toBe(false)
    expect(isValidProfileName('has space')).toBe(false)
    expect(isValidProfileName('has/slash')).toBe(false)
    expect(isValidProfileName(`a${'b'.repeat(64)}`)).toBe(false)
  })

  // The regex alone lets these through; the backend then 4xxs with a message
  // the dialog cannot explain.
  it('rejects every reserved name', () => {
    for (const reserved of RESERVED_PROFILE_NAMES) {
      expect(isValidProfileName(reserved)).toBe(false)
    }

    expect([...RESERVED_PROFILE_NAMES].sort()).toEqual(['hermes', 'root', 'sudo', 'test', 'tmp'])
  })

  // `default` is a pass-through alias for the built-in root profile, not an
  // invalid name — the duplicate check reports it far better than "invalid".
  it('does not treat `default` as invalid', () => {
    expect(isValidProfileName('default')).toBe(true)
  })

  it('ignores surrounding whitespace', () => {
    expect(isValidProfileName('  work  ')).toBe(true)
    expect(isValidProfileName('  hermes  ')).toBe(false)
  })
})
