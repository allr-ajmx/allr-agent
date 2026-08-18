/**
 * The connect screen's safe-area contract.
 *
 * Every other mobile surface inherits its insets from chrome above it. This one
 * cannot: `app/mobile-controller.tsx` swaps the WHOLE shell out for
 * ConnectScreen, so it renders in normal flow with nothing above it (the
 * reasoning is spelled out beside the z-index rungs in styles.css). If `.connect`
 * does not apply the insets itself, nothing does — the card runs under the status
 * bar and the home indicator, and under the notch in landscape.
 *
 * Textual on purpose, for the same reason as styles.mobile-viewport.test.ts: a
 * jsdom render cannot answer any of this. jsdom does not resolve `env()`, has no
 * visual viewport, and never sets `html.is-mobile` (it reports maxTouchPoints
 * 0). The contract also lives in a stylesheet no component imports, so nothing
 * in the type system points at it — it would regress silently, on phones only.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const SRC = path.dirname(fileURLToPath(import.meta.url))

/** The `.connect` declaration block, comments stripped — the prose above the
 *  rule names the very properties this test forbids. */
function connectRule(): string {
  const css = fs.readFileSync(path.join(SRC, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const start = css.search(/(^|[};])\s*\.connect\s*\{/)

  expect(start).toBeGreaterThanOrEqual(0)

  const open = css.indexOf('{', start)
  const end = css.indexOf('}', open)

  return css.slice(open + 1, end === -1 ? css.length : end)
}

const RULE = connectRule()

describe('the connect screen owns its safe-area insets', () => {
  it('pads every side by at least the device inset', () => {
    expect(RULE).toMatch(/padding-top:\s*max\([^)]*var\(--safe-area-inset-top\)/)
    expect(RULE).toMatch(/padding-bottom:\s*max\([^)]*var\(--safe-area-inset-bottom\)/)
    // Landscape: on a notched phone rotated either way the notch eats one side.
    expect(RULE).toMatch(/padding-left:\s*max\([^)]*var\(--safe-area-inset-left\)/)
    expect(RULE).toMatch(/padding-right:\s*max\([^)]*var\(--safe-area-inset-right\)/)
  })

  it('does not leave a shorthand `padding` behind to override them', () => {
    // A later `padding: 24px 18px` would silently win and reinstate the bug.
    expect(RULE).not.toMatch(/(^|[;\s])padding:/)
  })

  it('reads the published vars, never raw env()', () => {
    // lib/safe-area.ts exists precisely because the mobile webviews report env()
    // as 0 for the first frame(s); consuming env() directly is what makes chrome
    // paint at 0 and then jump.
    expect(RULE).not.toMatch(/env\(\s*safe-area-inset-/)
  })

  it('does not lift itself by the keyboard inset', () => {
    // #root is already pinned to the visible rectangle on mobile, so this screen
    // gets keyboard avoidance for free. A second lift double-counts it — and the
    // configure step is all text fields, so it would be immediately visible.
    expect(RULE).not.toMatch(/--keyboard-inset/)
  })

  it('stays the scroll container the insets are applied to', () => {
    // The bottom inset only clears the home indicator if it pads the scroller.
    expect(RULE).toMatch(/overflow-y:\s*auto/)
  })
})
