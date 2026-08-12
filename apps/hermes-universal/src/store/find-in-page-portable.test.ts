/**
 * The find-in-page store on the PORTABLE path (macOS / Windows / Android).
 *
 * Sibling of `find-in-page.test.ts`, which pins the Linux/WebKitGTK branch. The
 * platform gate is a module-level mock, so the two branches cannot share a file.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn(async (_command: string, _args?: unknown) => undefined)

vi.mock('@tauri-apps/api/core', () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }))

vi.mock('@tauri-apps/api/event', () => ({
  listen: async () => () => undefined
}))

// Anything that is not Linux takes the `window.find` path.
vi.mock('@/lib/platform', async importOriginal => ({
  ...(await importOriginal<typeof Platform>()),
  PLATFORM: 'macos'
}))

import type * as Platform from '@/lib/platform'

import { $findInPage, closeFindBar, findInPageSupported, openFindBar, setFindQuery } from './find-in-page'

const find = vi.fn(() => true)
const removeAllRanges = vi.fn()

beforeEach(() => {
  invoke.mockClear()
  find.mockClear()
  find.mockReturnValue(true)
  removeAllRanges.mockClear()

  Object.defineProperty(window, 'find', { configurable: true, value: find, writable: true })
  Object.defineProperty(window, 'getSelection', {
    configurable: true,
    value: () => ({ removeAllRanges }) as unknown as Selection,
    writable: true
  })

  document.body.innerHTML = ''
  openFindBar()
})

afterEach(() => {
  closeFindBar()
  document.body.innerHTML = ''
})

/** The count is reported in a microtask, matching the native path's async event. */
const settle = () => Promise.resolve()

describe('find-in-page (portable path)', () => {
  it('opens where the engine exposes window.find, and stays shut where it does not', () => {
    expect(findInPageSupported()).toBe(true)

    Object.defineProperty(window, 'find', { configurable: true, value: undefined, writable: true })
    expect(findInPageSupported()).toBe(false)
  })

  it('never reaches for the Rust command off Linux', async () => {
    document.body.innerHTML = '<p>hermes</p>'

    setFindQuery('hermes')
    await settle()

    expect(invoke).not.toHaveBeenCalled()
    expect(find).toHaveBeenCalledWith('hermes', false, false, true, false, false, false)
  })

  it('reports the count the page actually holds', async () => {
    document.body.innerHTML = '<p>hermes</p><p>hermes and hermes</p>'

    setFindQuery('hermes')
    await settle()

    expect($findInPage.get()).toMatchObject({ matchCount: 3, matchOrdinal: 1 })
  })

  // The regression this pair exists for: Shiki emits one span per token, so the
  // old per-text-node scan counted zero and the bar read 0/0 while the engine
  // had the match selected and scrolled into view.
  it('counts a match the engine finds across element boundaries', async () => {
    document.body.innerHTML = '<pre><code><span>foo</span><span>.bar</span></code></pre>'

    setFindQuery('foo.bar')
    await settle()

    expect($findInPage.get()).toMatchObject({ matchCount: 1, matchOrdinal: 1 })
  })

  it('never shows zero for a match the engine did select', async () => {
    // Nothing in the DOM to scan, but the engine claims a hit (a frame, a shadow
    // root — somewhere the scan cannot reach).
    setFindQuery('elsewhere')
    await settle()

    expect($findInPage.get()).toMatchObject({ matchCount: 1, matchOrdinal: 1 })
  })

  it('points at no match when the engine would not move to one', async () => {
    document.body.innerHTML = '<p>hermes hermes</p>'
    find.mockReturnValue(false)

    setFindQuery('hermes')
    await settle()

    // 0/2, not 1/2: the text is in the page, but nothing is highlighted, and
    // claiming a position would point at a selection that does not exist.
    expect($findInPage.get()).toMatchObject({ matchCount: 2, matchOrdinal: 0 })
  })

  it('drops the selection on close instead of calling the engine binding', () => {
    document.body.innerHTML = '<p>hermes</p>'
    setFindQuery('hermes')
    removeAllRanges.mockClear()

    closeFindBar()

    expect(invoke).not.toHaveBeenCalled()
    expect(removeAllRanges).toHaveBeenCalled()
  })
})
