/**
 * The phone's viewport contract.
 *
 * WKWebView reveals a focused caret by SCROLLING the visual viewport rather than
 * resizing the layout one. Anything anchored to the layout viewport is therefore
 * carried `visualViewport.offsetTop` px off the top of the screen the moment a
 * field is tapped — which is how tapping the composer used to take the top bar
 * and the whole safe-area band with it.
 *
 * The fix is one rule (`#root` IS the visible rectangle) and one prohibition
 * (nothing may then lift itself by `--keyboard-inset` again). Neither is
 * expressible in the type system: the rule lives in a stylesheet no component
 * imports, and the prohibition is a `style` prop in a different file that would
 * simply double the lift if someone re-added it — silently, off-desktop only,
 * and only while a keyboard is up. So it is pinned here.
 *
 * Textual on purpose. A jsdom render cannot answer any of this: jsdom has no
 * visual viewport, does not resolve `env()`, and never sets `html.is-mobile`
 * (it reports `maxTouchPoints: 0`).
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const SRC = path.dirname(fileURLToPath(import.meta.url))

const read = (relative: string) => fs.readFileSync(path.join(SRC, relative), 'utf8')

/** A rule's declaration block, by a pattern matched against its selector list.
 *  Comments are stripped first — a commented-out `transform` is not a hazard,
 *  and the prose above the rule names every property this test forbids. */
function ruleBody(css: string, selector: RegExp): string | null {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '')
  let cursor = 0

  for (let i = 0; i < bare.length; i++) {
    const ch = bare[i]

    if (ch === '{') {
      const list = bare.slice(cursor, i).trim()
      const end = bare.indexOf('}', i)

      if (selector.test(list)) {
        return bare.slice(i + 1, end === -1 ? bare.length : end)
      }
    }

    if (ch === '{' || ch === '}' || ch === ';') {
      cursor = i + 1
    }
  }

  return null
}

const STYLES = read('styles.css')
const ROOT_RULE = ruleBody(STYLES, /^html\.is-mobile[^,]*#root$/)

describe('the phone app root is the visible rectangle', () => {
  it('pins #root to the visual viewport', () => {
    expect(ROOT_RULE).not.toBeNull()
    expect(ROOT_RULE).toMatch(/position:\s*fixed/)
    expect(ROOT_RULE).toMatch(/top:\s*var\(--visual-viewport-top/)
    expect(ROOT_RULE).toMatch(/height:\s*var\(--visual-viewport-height/)
  })

  it('leaves the HUD satellite out of it', () => {
    // iPadOS can open a HUD window (store/windows.ts multiWindowSupported), where
    // IS_MOBILE is true and `styles.css` has its own #root rules.
    const selector = STYLES.match(/html\.is-mobile[^,{]*#root\s*\{/)?.[0] ?? ''

    expect(selector).toContain(':not([data-hud])')
  })

  it('creates no containing block for the fixed surfaces pinned to the same rect', () => {
    // MobileSidebar, MobileWorkspace and the floating pet are all `position:
    // fixed` and already sized from --visual-viewport-*. Any of these properties
    // on #root would make it their containing block and apply the offset twice —
    // a worse bug than the one this rule fixes, and visible only mid-keyboard.
    expect(ROOT_RULE).not.toMatch(/\b(transform|contain|filter|backdrop-filter|will-change|perspective)\s*:/)
  })
})

describe('nothing inside the shells lifts itself by the keyboard again', () => {
  it.each(['app/shell/mobile-shell.tsx', 'app/shell/mobile-surface-shell.tsx'])(
    '%s has no --keyboard-inset margin',
    file => {
      // The double-lift guard. #root already ends at the top of the keyboard, so
      // a margin here leaves a keyboard-tall dead band. This is the invariant most
      // likely to be reintroduced from memory of the old contract.
      const source = read(file).replace(/\/\*[\s\S]*?\*\//g, '')

      expect(source).not.toMatch(/margin[A-Za-z-]*[^\n]*--keyboard-inset/)
    }
  )

  it('presents the mobile surface shell inside #root, not over the layout viewport', () => {
    // `fixed inset-0` here would slide off the top exactly like the home shell
    // did; `absolute inset-0` fills the visible rectangle #root now describes.
    const source = read('app/mobile-controller.tsx').replace(/\/\*[\s\S]*?\*\//g, '')

    expect(source).not.toContain('fixed inset-0 z-50')
    expect(source).toContain('absolute inset-0 z-50')
  })
})
