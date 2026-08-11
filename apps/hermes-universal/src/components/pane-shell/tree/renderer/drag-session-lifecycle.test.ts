/**
 * THE DRAG SESSION'S LIFECYCLE — what it takes hold of, and every way it lets
 * go.
 *
 * A live drag holds four GLOBAL locks: `body`'s cursor and `user-select`, the
 * guest-pointer lock (an iframe hit-tests on its own, so a pointer-capture drag
 * in the embedder goes quiet the moment the cursor crosses one — and a tab is
 * dragged over exactly the surfaces that hold frames: the artifact preview, the
 * transcript's embeds), and the top escape layer. Every one of them is global,
 * so a session that fails to end does not degrade the drag — it degrades the
 * whole app until reload.
 *
 * Those locks are the observables, along with whether the spec ever commits.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { isTopEscapeLayer } from '@/lib/escape-layers'

import { startDragSession } from './drag-session'

const handle = () => {
  const el = document.createElement('div')

  document.body.appendChild(el)

  return el
}

/** A React-shaped pointerdown on `el`; only the fields the session reads. */
const down = (el: HTMLElement, x: number, y: number) =>
  ({
    button: 0,
    clientX: x,
    clientY: y,
    currentTarget: el,
    pointerId: 1,
    pointerType: 'mouse'
  }) as unknown as Parameters<typeof startDragSession>[0]

const move = (x: number, y: number) => window.dispatchEvent(new MouseEvent('pointermove', { clientX: x, clientY: y }))

/** Push the session past its threshold and let the rAF-coalesced move land. */
const engage = async () => {
  move(60, 40)

  await new Promise(resolve => requestAnimationFrame(() => resolve(null)))
}

afterEach(() => {
  // Safety net: the locks are MODULE-global, so a test that leaves a session
  // live would fail every test after it instead of only itself.
  window.dispatchEvent(new Event('blur'))
  document.body.className = ''
  document.body.removeAttribute('style')
  document.body.replaceChildren()
})

describe('guest pointer guard during a pane drag', () => {
  it('locks guests once the drag engages and releases them on drop', async () => {
    const el = handle()
    const spec = { onCommit: vi.fn(), onEngage: vi.fn(), resolveMove: () => null }

    startDragSession(down(el, 0, 0), spec)

    // Sub-threshold: still a click, so nothing is locked yet.
    move(1, 0)
    expect(document.body.classList.contains('guest-pointer-lock')).toBe(false)

    move(60, 40)
    // Moves are rAF-coalesced; engage lands on the next frame.
    await new Promise(resolve => requestAnimationFrame(() => resolve(null)))

    expect(spec.onEngage).toHaveBeenCalled()
    expect(document.body.classList.contains('guest-pointer-lock')).toBe(true)

    window.dispatchEvent(new MouseEvent('pointerup'))

    expect(document.body.classList.contains('guest-pointer-lock')).toBe(false)
  })

  it('releases them on an aborted drag too', async () => {
    const el = handle()

    startDragSession(down(el, 0, 0), { onCommit: vi.fn(), onEngage: vi.fn(), resolveMove: () => null })

    await engage()

    expect(document.body.classList.contains('guest-pointer-lock')).toBe(true)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))

    expect(document.body.classList.contains('guest-pointer-lock')).toBe(false)
  })
})

/**
 * A drag holds four global locks and a set of window listeners. Ending only on
 * pointerup / pointercancel / Esc left every one of them pinned whenever the
 * WINDOW lost the gesture instead — Alt-Tab mid-drag delivers no pointerup
 * here — and the next click landed as a DROP wherever the pointer happened to
 * be. These are the exits that close that; the observables are the locks
 * themselves, plus the fact that nothing commits.
 */
describe('a drag the window loses still ends', () => {
  const spec = () => ({ onCommit: vi.fn(), onEnd: vi.fn(), onEngage: vi.fn(), resolveMove: () => null })

  const stranded = () => ({
    cursor: document.body.style.cursor,
    escapeStolen: !isTopEscapeLayer(0),
    guests: document.body.classList.contains('guest-pointer-lock'),
    select: document.body.style.userSelect
  })

  it('window blur aborts it — no pinned body styles, no stolen Escape, no commit', async () => {
    const el = handle()
    const s = spec()

    startDragSession(down(el, 0, 0), s)
    await engage()

    // `no-drop` rather than `grabbing`: this spec resolves every point to a
    // deny area. Either way the cursor is PINNED, which is the point.
    expect(stranded()).toEqual({ cursor: 'no-drop', escapeStolen: true, guests: true, select: 'none' })

    window.dispatchEvent(new Event('blur'))

    expect(stranded()).toEqual({ cursor: '', escapeStolen: false, guests: false, select: '' })
    expect(s.onEnd).toHaveBeenCalledTimes(1)
    expect(s.onCommit).not.toHaveBeenCalled()
  })

  it('losing pointer capture aborts it — a source tab removed mid-drag', async () => {
    const el = handle()
    const s = spec()

    startDragSession(down(el, 0, 0), s)
    await engage()

    el.dispatchEvent(new Event('lostpointercapture'))

    expect(stranded()).toEqual({ cursor: '', escapeStolen: false, guests: false, select: '' })
    expect(s.onCommit).not.toHaveBeenCalled()
  })

  // The listeners have to come off too, or the gesture is still live: a later
  // pointerup would commit a drop at whatever the pointer had wandered onto.
  it('stops listening once it has ended, so a later release commits nothing', async () => {
    const el = handle()
    const s = spec()

    startDragSession(down(el, 0, 0), s)
    await engage()

    window.dispatchEvent(new Event('blur'))
    move(200, 200)
    await new Promise(resolve => requestAnimationFrame(() => resolve(null)))
    window.dispatchEvent(new MouseEvent('pointerup'))

    expect(s.onCommit).not.toHaveBeenCalled()
    expect(s.onEnd).toHaveBeenCalledTimes(1)
    expect(stranded().guests).toBe(false)
  })

  // `releasePointerCapture` synthesizes `lostpointercapture` from inside the
  // teardown, so the exits race each other by construction.
  it('ends exactly once however many exits fire', async () => {
    const el = handle()
    const s = spec()

    startDragSession(down(el, 0, 0), s)
    await engage()

    window.dispatchEvent(new MouseEvent('pointerup'))
    el.dispatchEvent(new Event('lostpointercapture'))
    window.dispatchEvent(new Event('blur'))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))

    expect(s.onCommit).toHaveBeenCalledTimes(1)
    expect(s.onEnd).toHaveBeenCalledTimes(1)
  })
})
