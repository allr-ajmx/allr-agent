/**
 * MJXHRM-381 — the thread's scroll mirror is PER SESSION.
 *
 * Universal mounts a whole ChatScreen (thread + composer + status stack + jump
 * button) per open tile. While these were two global booleans and one global
 * handler set, scrolling up in one tile dimmed and re-rendered every other
 * tile's composer and status stack, closing a tile reset the flag out from under
 * a tile that was still scrolled up, and one tile's jump button pinned every
 * mounted transcript.
 */

import { describe, expect, it, vi } from 'vitest'

import {
  onScrollToBottomRequest,
  requestScrollToBottom,
  resetThreadScroll,
  sessionThreadJumpVisible,
  sessionThreadScrolledUp,
  setThreadAtBottom
} from './thread-scroll'

describe('thread scroll mirror', () => {
  it('keeps one session scrolled up without touching another', () => {
    setThreadAtBottom('a', false)

    expect(sessionThreadScrolledUp('a').get()).toBe(true)
    expect(sessionThreadJumpVisible('a').get()).toBe(true)
    expect(sessionThreadScrolledUp('b').get()).toBe(false)
    expect(sessionThreadJumpVisible('b').get()).toBe(false)

    resetThreadScroll('a')

    expect(sessionThreadScrolledUp('a').get()).toBe(false)
  })

  it('releasing one session leaves another scrolled up', () => {
    setThreadAtBottom('a', false)
    setThreadAtBottom('b', false)

    // A tile closing (its list unmounts and resets its own key).
    resetThreadScroll('b')

    expect(sessionThreadScrolledUp('a').get()).toBe(true)
    expect(sessionThreadScrolledUp('b').get()).toBe(false)
    resetThreadScroll('a')
  })

  it('does not notify a session whose flag did not move', () => {
    const other = vi.fn()
    const unsubscribe = sessionThreadScrolledUp('quiet').listen(other)

    setThreadAtBottom('noisy', false)
    setThreadAtBottom('noisy', true)

    expect(other).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('skips no-op writes so a scroll tick at the bottom does not churn', () => {
    const seen = vi.fn()
    setThreadAtBottom('c', false)
    const unsubscribe = sessionThreadScrolledUp('c').listen(seen)

    setThreadAtBottom('c', false)
    setThreadAtBottom('c', false)

    expect(seen).not.toHaveBeenCalled()

    setThreadAtBottom('c', true)

    expect(seen).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it("fires only the requested session's scroll handler", () => {
    const mine = vi.fn()
    const theirs = vi.fn()
    const stopMine = onScrollToBottomRequest('a', mine)
    const stopTheirs = onScrollToBottomRequest('b', theirs)

    requestScrollToBottom('a')

    expect(mine).toHaveBeenCalledTimes(1)
    expect(theirs).not.toHaveBeenCalled()

    stopMine()
    requestScrollToBottom('a')

    expect(mine).toHaveBeenCalledTimes(1)
    stopTheirs()
  })

  it('treats a session with no runtime key as its own slot', () => {
    setThreadAtBottom(null, false)

    expect(sessionThreadScrolledUp(null).get()).toBe(true)
    expect(sessionThreadScrolledUp(undefined).get()).toBe(true)
    expect(sessionThreadScrolledUp('a').get()).toBe(false)
    resetThreadScroll(null)
  })
})
