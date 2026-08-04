import { describe, expect, it } from 'vitest'

import { errorText } from './error-text'

describe('errorText', () => {
  it('reads the message off a rejected Tauri command', () => {
    // The bug this exists for: SshError serialises to a plain object, so the
    // usual `String(err)` rendered every SSH failure as "[object Object]" on
    // the connecting screen.
    const sshError = { kind: 'auth-failed', message: 'Permission denied (publickey,password).' }

    expect(errorText(sshError)).toBe('Permission denied (publickey,password).')
    expect(errorText(sshError)).not.toContain('[object Object]')
  })

  it('handles the ordinary shapes', () => {
    expect(errorText(new Error('boom'))).toBe('boom')
    expect(errorText('already a string')).toBe('already a string')
  })

  it('falls back to JSON rather than [object Object]', () => {
    // Not one of ours, but a bug report can still act on the contents.
    expect(errorText({ code: 42 })).toBe('{"code":42}')
  })

  it('survives values JSON cannot encode', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic

    expect(() => errorText(cyclic)).not.toThrow()
    expect(errorText(cyclic)).toBe('[object Object]')
  })

  it('ignores a non-string or empty message', () => {
    expect(errorText({ message: 42 })).toBe('{"message":42}')
    expect(errorText({ message: '' })).toBe('{"message":""}')
  })

  it('handles null and undefined', () => {
    expect(errorText(null)).toBe('null')
    expect(errorText(undefined)).toBe('undefined')
  })
})
