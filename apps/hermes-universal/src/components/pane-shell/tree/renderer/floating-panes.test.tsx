/**
 * Live-behaviour test for FloatingTiles: mounts the REAL component into a real
 * DOM and drives real pointer/resize events. This is the closest thing to
 * "running it" without a Tauri window — it exercises the rendered element's
 * computed geometry, not the pure geometry module (that's floating-rect.test.ts).
 *
 * The titlebar inset resolves to the 34px fallback here: jsdom reports an empty
 * `--titlebar-height`, which is exactly what a webview does before the app shell
 * has painted, so the fallback is load-bearing rather than test-only.
 *
 * Ported from desktop `floating-panes.test.tsx`.
 */

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { registry } from '@/contrib/registry'

import { FloatingTiles } from './floating-panes'

let disposers: (() => void)[] = []

const card = () => document.querySelector<HTMLElement>('[data-floating-tile="hud"]')

const grab = () => card()!.querySelector('header')!

/** jsdom has no real pointer events; PointerEvent falls back to MouseEvent. */
function pointer(target: Element, type: string, x: number, y: number) {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y })

  Object.defineProperty(event, 'pointerId', { value: 1 })

  act(() => {
    target.dispatchEvent(event)
  })
}

function resizeWindow(width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width, writable: true })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height, writable: true })

  act(() => {
    window.dispatchEvent(new Event('resize'))
  })
}

/** Registered through the FLAT payload on purpose — a floating tile is a
 *  capability nothing in the app declares today, so a plugin is its first real
 *  caller and the flat shape is what the published SDK gives it. */
function registerHud(data: Record<string, unknown>, id = 'hud') {
  disposers.push(
    registry.register({
      area: 'panes',
      data,
      id,
      render: () => <p data-testid={`${id}-body`}>live</p>,
      title: 'HUD'
    })
  )
}

describe('FloatingTiles (live DOM)', () => {
  beforeEach(() => {
    window.localStorage.clear()
    resizeWindow(1440, 900)
    // setPointerCapture / releasePointerCapture don't exist in jsdom.
    Element.prototype.setPointerCapture = vi.fn()
    Element.prototype.releasePointerCapture = vi.fn()
  })

  afterEach(() => {
    cleanup()
    disposers.forEach(dispose => dispose())
    disposers = []
  })

  it('mounts a fixed card in the anchored corner with the tile body inside', () => {
    registerHud({ anchor: 'top-right', height: '132px', placement: 'floating', width: '224px' })
    render(<FloatingTiles />)

    const el = card()!

    expect(el).toBeTruthy()
    expect(el.className).toContain('fixed')
    // 1440 - 224 - 12 margin = 1204; titlebar 34 + 12 = 46.
    expect(el.style.left).toBe('1204px')
    expect(el.style.top).toBe('46px')
    expect(el.style.width).toBe('224px')
    expect(document.querySelector('[data-testid="hud-body"]')?.textContent).toBe('live')
  })

  it('renders nothing for a non-floating placement', () => {
    registerHud({ placement: 'right', width: '224px' })
    render(<FloatingTiles />)

    expect(card()).toBeNull()
  })

  it('moves with a real pointer drag on the header', () => {
    registerHud({ anchor: 'top-left', height: '132px', placement: 'floating', width: '224px' })
    render(<FloatingTiles />)

    expect(card()!.style.left).toBe('12px')

    pointer(grab(), 'pointerdown', 100, 100)
    pointer(grab(), 'pointermove', 260, 240)
    pointer(grab(), 'pointerup', 260, 240)

    expect(card()!.style.left).toBe('172px')
    expect(card()!.style.top).toBe('186px')
  })

  it('persists the dragged position across a remount', () => {
    registerHud({ anchor: 'top-left', height: '132px', placement: 'floating', width: '224px' })
    const first = render(<FloatingTiles />)

    pointer(grab(), 'pointerdown', 100, 100)
    pointer(grab(), 'pointermove', 300, 300)
    pointer(grab(), 'pointerup', 300, 300)

    const moved = card()!.style.left

    first.unmount()
    render(<FloatingTiles />)

    expect(card()!.style.left).toBe(moved)
  })

  it('rides the right edge when the window shrinks', () => {
    registerHud({ anchor: 'top-right', height: '132px', placement: 'floating', width: '224px' })
    render(<FloatingTiles />)

    expect(card()!.style.left).toBe('1204px')

    resizeWindow(1000, 700)

    // Tracks the edge: 1000 - 224 - 12 = 764.
    expect(card()!.style.left).toBe('764px')
  })

  it('never lets a drag push the card under the titlebar', () => {
    registerHud({ anchor: 'top-left', height: '132px', placement: 'floating', width: '224px' })
    render(<FloatingTiles />)

    pointer(grab(), 'pointerdown', 100, 100)
    pointer(grab(), 'pointermove', 100, -900)
    pointer(grab(), 'pointerup', 100, -900)

    expect(Number.parseFloat(card()!.style.top)).toBeGreaterThanOrEqual(34)
  })

  it('collapses to the header and drops the body, and does not drag from the button', () => {
    registerHud({ anchor: 'top-left', height: '132px', placement: 'floating', width: '224px' })
    render(<FloatingTiles />)

    const before = card()!.style.left
    const toggle = card()!.querySelector('button')!

    // The button is inside the drag handle — [data-floating-no-drag] must stop
    // it starting a drag.
    pointer(toggle, 'pointerdown', 100, 100)
    pointer(grab(), 'pointermove', 400, 400)
    pointer(grab(), 'pointerup', 400, 400)

    expect(card()!.style.left).toBe(before)

    act(() => {
      toggle.click()
    })

    expect(document.querySelector('[data-testid="hud-body"]')).toBeNull()
    expect(card()!.style.height).toBe('')
  })

  it('renders one card per floating tile', () => {
    registerHud({ anchor: 'top-left', placement: 'floating', width: '224px' })
    registerHud({ anchor: 'bottom-right', placement: 'floating', width: '200px' }, 'hud2')

    render(<FloatingTiles />)

    expect(document.querySelectorAll('[data-floating-tile]').length).toBe(2)
  })
})
