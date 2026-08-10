/**
 * The find-in-page store: what it asks the engine for, and what it refuses to
 * ask after the bar is gone.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn(async (_command: string, _args?: unknown) => undefined)

vi.mock('@tauri-apps/api/core', () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }))

vi.mock('@tauri-apps/api/event', () => ({
  listen: async () => () => undefined
}))

// The engine binding exists only on WebKitGTK; the store gates on that.
vi.mock('@/lib/platform', async importOriginal => ({
  ...(await importOriginal<typeof Platform>()),
  PLATFORM: 'linux'
}))

import type * as Platform from '@/lib/platform'

import {
  $findInPage,
  closeFindBar,
  findNext,
  findPrevious,
  openFindBar,
  setFindQuery,
  updateFindResults
} from './find-in-page'

beforeEach(() => {
  invoke.mockClear()
  openFindBar()
})

afterEach(() => {
  closeFindBar()
})

const calls = (name: string) => invoke.mock.calls.filter(call => call[0] === name)

describe('find-in-page', () => {
  it('searches from scratch on a fresh query', () => {
    setFindQuery('hello')

    expect(calls('find_in_page')).toEqual([['find_in_page', { findNext: false, forward: true, query: 'hello' }]])
    expect($findInPage.get().query).toBe('hello')
  })

  it('steps with the previous query instead of re-searching', () => {
    setFindQuery('hello')
    invoke.mockClear()

    findNext()
    findPrevious()

    expect(calls('find_in_page')).toEqual([
      ['find_in_page', { findNext: true, forward: true, query: 'hello' }],
      ['find_in_page', { findNext: true, forward: false, query: 'hello' }]
    ])
  })

  it('counts the position itself — the engine only reports how many there are', () => {
    setFindQuery('hello')
    updateFindResults(3)

    // First result for a fresh query: the engine has selected match one.
    expect($findInPage.get()).toMatchObject({ matchCount: 3, matchOrdinal: 1 })

    findNext()
    expect($findInPage.get().matchOrdinal).toBe(2)

    findNext()
    findNext()
    // Wraps, because the engine search wraps.
    expect($findInPage.get().matchOrdinal).toBe(1)
  })

  it('clears the highlight the moment the query empties, without waiting', () => {
    setFindQuery('hello')
    invoke.mockClear()

    setFindQuery('')

    expect(calls('stop_find_in_page')).toHaveLength(1)
    expect($findInPage.get()).toMatchObject({ matchCount: 0, matchOrdinal: 0, query: '' })
  })

  it('will not search for a closed bar — a fired debounce must not re-highlight', () => {
    closeFindBar()
    invoke.mockClear()

    setFindQuery('late')
    findNext()

    expect(calls('find_in_page')).toHaveLength(0)
    expect($findInPage.get().query).toBe('')
  })

  it('closes once, not twice — Escape is a shared gesture', () => {
    setFindQuery('hello')
    invoke.mockClear()

    closeFindBar()
    closeFindBar()

    expect(calls('stop_find_in_page')).toHaveLength(1)
  })

  it('drops a result that arrives for a query the user already cleared', () => {
    setFindQuery('hello')
    setFindQuery('')

    updateFindResults(9)

    expect($findInPage.get().matchCount).toBe(0)
  })
})
