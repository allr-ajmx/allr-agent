/**
 * The soft-keyboard geometry the phone's layout is built on.
 *
 * `styles.css` pins `html.is-mobile #root` to `--visual-viewport-top` /
 * `--visual-viewport-height`, so the arithmetic below is not a detail of one
 * component any more — it decides where the whole app is drawn. The case that
 * matters most is `offsetTop > 0`: WKWebView reveals a focused caret by
 * SCROLLING the visual viewport rather than resizing the layout one, and a
 * shell anchored to the layout viewport is then carried `offsetTop` px off the
 * top of the screen. That was the bug; these are its numbers.
 */

import { renderHook } from '@testing-library/react'
import { act } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { useKeyboardInset } from './use-keyboard-inset'

const root = document.documentElement

interface Viewport {
  height: number
  offsetTop: number
}

/** A `window.visualViewport` stand-in: jsdom ships none. */
class FakeVisualViewport extends EventTarget {
  height = 0
  offsetTop = 0
}

const originalInnerHeight = window.innerHeight
let fake: FakeVisualViewport | null = null

/** Install the geometry the webview would be reporting. */
function setViewport(innerHeight: number, vv: Viewport | null): void {
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: innerHeight, writable: true })

  if (!vv) {
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: undefined, writable: true })
    fake = null

    return
  }

  fake ??= new FakeVisualViewport()
  fake.height = vv.height
  fake.offsetTop = vv.offsetTop

  Object.defineProperty(window, 'visualViewport', { configurable: true, value: fake, writable: true })
}

/** Move the geometry and fire the event the webview would fire. */
function moveViewport(vv: Viewport): void {
  if (!fake) {
    throw new Error('no visual viewport installed')
  }

  fake.height = vv.height
  fake.offsetTop = vv.offsetTop

  act(() => {
    fake?.dispatchEvent(new Event('resize'))
  })
}

const readVar = (name: string) => root.style.getPropertyValue(name)

afterEach(() => {
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalInnerHeight, writable: true })
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: undefined, writable: true })
  fake = null
})

describe('useKeyboardInset', () => {
  it('publishes the visible rectangle when iOS SCROLLS the visual viewport', () => {
    // The caret-reveal case. The keyboard occludes 340px, but the webview has
    // also scrolled the visible band 60px down the layout viewport — so a
    // layout-viewport-anchored element only needs lifting by the remaining 280,
    // while anything sized from the rectangle takes 460 tall at y=60.
    setViewport(800, { height: 460, offsetTop: 60 })

    const { unmount } = renderHook(() => useKeyboardInset())

    expect(readVar('--visual-viewport-top')).toBe('60px')
    expect(readVar('--visual-viewport-height')).toBe('460px')
    expect(readVar('--keyboard-inset')).toBe('280px')
    expect(root.hasAttribute('data-keyboard-open')).toBe(true)

    unmount()
  })

  // The composer case, and the one the open/closed test was getting wrong. The
  // composer is docked at the very BOTTOM of the layout viewport, so WKWebView
  // scrolls the visible band down by nearly the whole keyboard to reveal the
  // caret — and `occlusion - offsetTop` then reads ~0 while the keyboard is
  // plainly up. Deriving open/closed from that residue reported CLOSED, which
  // kept the home-indicator safe area padded under a composer sitting on the
  // keyboard: the phantom gap.
  it('still reports OPEN when the scroll has swallowed the whole lift', () => {
    setViewport(800, { height: 460, offsetTop: 340 })

    const { result, unmount } = renderHook(() => useKeyboardInset())

    expect(root.hasAttribute('data-keyboard-open')).toBe(true)
    expect(result.current.open).toBe(true)
    // Nothing anchored to the layout viewport has to lift: the webview's own
    // scroll already did all of it.
    expect(readVar('--keyboard-inset')).toBe('0px')
    expect(readVar('--visual-viewport-height')).toBe('460px')
    expect(readVar('--visual-viewport-top')).toBe('340px')

    unmount()
  })

  it('publishes the same rectangle with no scroll (the Android case)', () => {
    setViewport(800, { height: 460, offsetTop: 0 })

    const { result, unmount } = renderHook(() => useKeyboardInset())

    expect(readVar('--visual-viewport-top')).toBe('0px')
    expect(readVar('--visual-viewport-height')).toBe('460px')
    expect(readVar('--keyboard-inset')).toBe('340px')
    expect(result.current.open).toBe(true)

    unmount()
  })

  it('reports closed when the visible region is the whole layout viewport', () => {
    setViewport(800, { height: 800, offsetTop: 0 })

    const { result, unmount } = renderHook(() => useKeyboardInset())

    expect(readVar('--keyboard-inset')).toBe('0px')
    expect(root.hasAttribute('data-keyboard-open')).toBe(false)
    expect(result.current.open).toBe(false)

    unmount()
  })

  it('keeps tracking the rectangle when the occlusion is below the open threshold', () => {
    // 40px is an accessory bar or safe-area jitter, not a keyboard: the inset
    // publishes 0 so nothing lifts by it. The rectangle still has to be honest
    // — #root is sized from it whether or not a keyboard is up.
    setViewport(800, { height: 760, offsetTop: 0 })

    const { unmount } = renderHook(() => useKeyboardInset())

    expect(readVar('--keyboard-inset')).toBe('0px')
    expect(readVar('--visual-viewport-height')).toBe('760px')
    expect(root.hasAttribute('data-keyboard-open')).toBe(false)

    unmount()
  })

  it('falls back to the layout viewport rather than zero without a visual viewport', () => {
    // The `#root` collapse guard: `height: var(--visual-viewport-height)` must
    // never resolve to 0px on a webview that has no Visual Viewport API.
    setViewport(800, null)

    const { unmount } = renderHook(() => useKeyboardInset())

    expect(readVar('--visual-viewport-height')).toBe('800px')
    expect(readVar('--visual-viewport-top')).toBe('0px')
    expect(readVar('--keyboard-inset')).toBe('0px')

    unmount()
  })

  it('republishes as the keyboard opens and closes', () => {
    setViewport(800, { height: 800, offsetTop: 0 })

    const { unmount } = renderHook(() => useKeyboardInset())

    moveViewport({ height: 460, offsetTop: 60 })
    expect(readVar('--visual-viewport-height')).toBe('460px')
    expect(root.hasAttribute('data-keyboard-open')).toBe(true)

    moveViewport({ height: 800, offsetTop: 0 })
    expect(readVar('--visual-viewport-height')).toBe('800px')
    expect(readVar('--keyboard-inset')).toBe('0px')
    expect(root.hasAttribute('data-keyboard-open')).toBe(false)

    unmount()
  })

  it('keeps the vars alive until the LAST subscriber unmounts', () => {
    // MobileController measures for the whole app and the two shells measure
    // again at the point of use. A per-caller teardown would delete the vars
    // out from under #root the moment either of them unmounted.
    setViewport(800, { height: 460, offsetTop: 60 })

    const first = renderHook(() => useKeyboardInset())
    const second = renderHook(() => useKeyboardInset())

    first.unmount()

    expect(readVar('--visual-viewport-height')).toBe('460px')
    expect(root.hasAttribute('data-keyboard-open')).toBe(true)

    second.unmount()

    expect(readVar('--visual-viewport-height')).toBe('')
    expect(root.hasAttribute('data-keyboard-open')).toBe(false)
  })
})
