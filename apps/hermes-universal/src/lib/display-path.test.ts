import { describe, expect, it } from 'vitest'

import { displayPath, normalizeDisplayPath, pathLeaf } from './display-path'

describe('displayPath', () => {
  it('collapses a macOS home prefix to ~', () => {
    expect(displayPath('/Users/brooklyn/www/hermes-agent')).toBe('~/www/hermes-agent')
    expect(displayPath('/Users/brooklyn')).toBe('~')
  })

  it('collapses a Linux home prefix to ~', () => {
    expect(displayPath('/home/alice/src/app')).toBe('~/src/app')
  })

  it('collapses a Windows user profile to ~', () => {
    expect(displayPath('C:\\Users\\brooklyn\\src')).toBe('~/src')
    expect(displayPath('C:/Users/brooklyn')).toBe('~')
  })

  it('honours an explicit home override', () => {
    expect(displayPath('/opt/work/repo', { home: '/opt/work' })).toBe('~/repo')
    expect(displayPath('/elsewhere/repo', { home: '/opt/work' })).toBe('/elsewhere/repo')
  })

  it('leaves non-home absolute paths alone', () => {
    expect(displayPath('/var/log/system.log')).toBe('/var/log/system.log')
    expect(displayPath('/Users')).toBe('/Users')
  })

  it('normalizes separators and trailing slashes', () => {
    expect(normalizeDisplayPath('C:\\Users\\me\\src\\')).toBe('C:/Users/me/src')
    expect(displayPath('/Users/me/src/')).toBe('~/src')
  })

  it('keeps an already-tildified path', () => {
    expect(displayPath('~/www/app')).toBe('~/www/app')
    expect(displayPath('~')).toBe('~')
  })

  // MJXHRM-394. The guess used to fire on ANY `<users-dir>/<name>`, including the
  // shared folders that ship on every machine and belong to nobody.
  it('does not claim a shared system folder as somebody’s home', () => {
    expect(displayPath('/Users/Shared/build')).toBe('/Users/Shared/build')
    expect(displayPath('C:/Users/Public/Documents')).toBe('C:/Users/Public/Documents')
    expect(displayPath('C:\\Users\\Default\\ntuser.dat')).toBe('C:/Users/Default/ntuser.dat')
    expect(displayPath('C:/Users/All Users/app')).toBe('C:/Users/All Users/app')
  })

  it('still collapses a user who merely resembles one of those names', () => {
    expect(displayPath('/home/publisher/src')).toBe('~/src')
    expect(displayPath('/Users/sharedev')).toBe('~')
  })

  // An explicit home is a fact, so it wins even over the shared-folder rule —
  // a gateway CAN be configured to run out of `/Users/Shared`.
  it('honours an explicit home that is itself a shared folder', () => {
    expect(displayPath('/Users/Shared/build', { home: '/Users/Shared' })).toBe('~/build')
  })

  it('leaves a relative path and an empty path alone', () => {
    expect(displayPath('already/relative')).toBe('already/relative')
    expect(displayPath('')).toBe('')
    expect(displayPath(null)).toBe('')
  })
})

describe('pathLeaf', () => {
  it('returns the last segment', () => {
    expect(pathLeaf('/Users/me/www/hermes-agent')).toBe('hermes-agent')
    expect(pathLeaf('~/www/hermes-agent')).toBe('hermes-agent')
    expect(pathLeaf('/')).toBe('/')
  })
})
