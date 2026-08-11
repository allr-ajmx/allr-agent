/**
 * A live drag has to make iframe guests transparent to hit-testing.
 *
 * An iframe hit-tests on its own, so a pointer-capture drag in the embedder can
 * go quiet the moment the cursor crosses one — and a preview tile is dragged
 * over exactly the surfaces that hold frames (the artifact preview, the
 * transcript's embeds). The class the CSS rule keys on is the observable, so
 * that is what this asserts, at the two ends of a real drag session.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

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

afterEach(() => {
  document.body.className = ''
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

    move(60, 40)
    await new Promise(resolve => requestAnimationFrame(() => resolve(null)))

    expect(document.body.classList.contains('guest-pointer-lock')).toBe(true)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))

    expect(document.body.classList.contains('guest-pointer-lock')).toBe(false)
  })
})
