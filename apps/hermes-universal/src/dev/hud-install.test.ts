/**
 * That each HUD actually installs — header AND body.
 *
 * This exists because of a real regression: extracting the shared shell made it
 * call back into the owner during construction, and the owner's callback reaches
 * for `const` bindings declared BELOW the `createHudShell(...)` call. The
 * temporal dead zone throws a `ReferenceError` mid-install, and the result is a
 * HUD showing its header with an empty body — visibly broken, but silent, and
 * invisible to every test that only checked the maths.
 *
 * So these assert the crude thing no unit test was covering: it mounts, it has
 * controls in it, and tearing it down leaves nothing behind.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }))

import { installFpsHud } from './fps-hud'
import { installTraceHud } from './trace-hud'

const teardowns: (() => void)[] = []

const install = (fn: () => () => void) => {
  const dispose = fn()
  teardowns.push(dispose)

  return dispose
}

afterEach(() => {
  while (teardowns.length > 0) {
    teardowns.pop()?.()
  }

  localStorage.clear()
  document.body.innerHTML = ''
})

/** The panel is the last element the HUD appended to <body>. */
const panels = () => [...document.body.children] as HTMLElement[]

describe.each([
  ['trace', installTraceHud],
  ['fps', installFpsHud]
])('%s HUD', (name, installHud) => {
  it('mounts a panel with a populated body', () => {
    install(installHud)

    const panel = panels().at(-1)

    expect(panel).toBeDefined()

    // Header + body. The bug this guards produced exactly one of these.
    expect(panel!.children).toHaveLength(2)

    const body = panel!.children[1] as HTMLElement

    expect(body.children.length).toBeGreaterThan(0)
    expect(body.querySelectorAll('button').length).toBeGreaterThan(0)
  })

  it('has a header with collapse and hide controls', () => {
    install(installHud)

    const header = panels().at(-1)!.children[0] as HTMLElement
    const labels = [...header.querySelectorAll('button')].map(b => b.textContent)

    expect(labels).toContain('–')
    expect(labels).toContain('×')
  })

  it('starts hidden when the persisted flag says so, and the console escape brings it back', () => {
    localStorage.setItem(`hermes.${name}-hud-hidden.v1`, 'true')

    install(installHud)

    const panel = panels().at(-1)!

    expect(panel.style.display).toBe('none')

    // The documented way back from the ×.
    const api = (window as unknown as Record<string, { hud?: (show?: boolean) => string }>)[
      name === 'trace' ? '__hermesTrace' : '__hermesFps'
    ]

    api?.hud?.(true)
    expect(panel.style.display).not.toBe('none')
  })

  it('removes itself on teardown', () => {
    const before = panels().length
    const dispose = install(installHud)

    expect(panels().length).toBe(before + 1)

    dispose()
    teardowns.pop()

    expect(panels().length).toBe(before)
  })
})
