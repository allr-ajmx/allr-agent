/**
 * MJXHRM-394. `displayPath` used to GUESS whose home a path was under — any
 * `/home/<x>` collapsed to `~`, for every `<x>`. These pin the replacement: the
 * home comes from the gateway's own reported HERMES_HOME, and when it can't be
 * derived we say so instead of inventing one.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

// Keep the real system-status store out of it: mounting it fires getStatus /
// getVersion. Only the value matters here.
vi.mock('@/store/system-status', async () => {
  const { atom } = await import('nanostores')

  return { $statusSnapshot: atom(null) }
})

import { displayPath } from '@/lib/display-path'
import { $displayHome, homeFromHermesHome } from '@/store/display-home'
import { $statusSnapshot } from '@/store/system-status'

beforeEach(() => {
  $statusSnapshot.set(null)
})

describe('homeFromHermesHome', () => {
  it('takes the parent of the POSIX default `<home>/.hermes`', () => {
    expect(homeFromHermesHome('/home/alice/.hermes')).toBe('/home/alice')
    expect(homeFromHermesHome('/Users/brooklyn/.hermes')).toBe('/Users/brooklyn')
    expect(homeFromHermesHome('/root/.hermes')).toBe('/root')
  })

  it('takes the profile root of the Windows default `<home>/AppData/Local/hermes`', () => {
    expect(homeFromHermesHome('C:\\Users\\brooklyn\\AppData\\Local\\hermes')).toBe('C:/Users/brooklyn')
    // Casing on Windows is not meaningful; the shape still is.
    expect(homeFromHermesHome('C:/Users/brooklyn/AppData/local/Hermes')).toBe('C:/Users/brooklyn')
  })

  it('tolerates a trailing slash and repeated separators', () => {
    expect(homeFromHermesHome('/home/alice//.hermes/')).toBe('/home/alice')
  })

  it('gives up on an explicit HERMES_HOME that says nothing about a home', () => {
    // `HERMES_HOME=/srv/hermes` is a real deployment; `/srv` is not anyone's home.
    expect(homeFromHermesHome('/srv/hermes')).toBe('')
    expect(homeFromHermesHome('/opt/data')).toBe('')
  })

  it('never claims the filesystem root or a drive root as a home', () => {
    expect(homeFromHermesHome('/.hermes')).toBe('')
    expect(homeFromHermesHome('C:/AppData/Local/hermes')).toBe('')
  })

  it('is empty for an absent or blank value', () => {
    expect(homeFromHermesHome(null)).toBe('')
    expect(homeFromHermesHome(undefined)).toBe('')
    expect(homeFromHermesHome('   ')).toBe('')
  })
})

describe('$displayHome', () => {
  it('is empty until the gateway has answered', () => {
    expect($displayHome.get()).toBe('')
  })

  it('follows the connected gateway', () => {
    $statusSnapshot.set({ hermes_home: '/home/deploy/.hermes' } as never)
    expect($displayHome.get()).toBe('/home/deploy')

    // Switching gateways must move `~` with it, not leave the old box's home on
    // screen.
    $statusSnapshot.set({ hermes_home: '/Users/ci/.hermes' } as never)
    expect($displayHome.get()).toBe('/Users/ci')
  })
})

// The point of the exercise: what the two produce together, on the paths that
// used to be formatted against a guess.
describe('displayPath bound to the gateway home', () => {
  const home = '/home/deploy'

  it('collapses the gateway user’s own home', () => {
    expect(displayPath('/home/deploy/src/app', { home })).toBe('~/src/app')
    expect(displayPath('/home/deploy', { home })).toBe('~')
  })

  it('leaves ANOTHER user’s home alone — the case the guess got wrong', () => {
    expect(displayPath('/home/alice/src/app', { home })).toBe('/home/alice/src/app')
    // A sibling directory whose name merely starts with the home string.
    expect(displayPath('/home/deploy2/src', { home })).toBe('/home/deploy2/src')
  })

  it('is case-sensitive on a POSIX gateway', () => {
    expect(displayPath('/home/Deploy/src', { home })).toBe('/home/Deploy/src')
  })

  it('falls back to the guess while the home is still unknown', () => {
    expect(displayPath('/home/alice/src', { home: '' })).toBe('~/src')
  })
})
