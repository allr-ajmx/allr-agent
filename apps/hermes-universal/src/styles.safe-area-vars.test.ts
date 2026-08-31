/**
 * One rule, tree-wide: read the published `--safe-area-inset-*` vars, never
 * raw `env(safe-area-inset-*)`.
 *
 * `styles.css` declares those vars on `:root` with an `env()` fallback, and
 * `lib/safe-area.ts` then overrides them inline with the resolved pixels —
 * because the mobile webviews report `env()` as 0 for the first frame(s). A
 * surface that consumes `env()` directly therefore paints at inset 0 and jumps,
 * on phones only, where nobody is looking during a `vitest` run.
 *
 * styles.connect-safe-area.test.ts asserts this for `.connect`. That guarded
 * one rule while five other surfaces quietly drifted back to `env()`, so this
 * one sweeps the whole source tree instead of naming files: a new component
 * pasting `pt-[env(safe-area-inset-top)]` fails here without anyone having to
 * remember to extend a list.
 *
 * Textual for the same reason as its sibling — jsdom does not resolve `env()`,
 * so no render can tell the two forms apart.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const SRC = path.dirname(fileURLToPath(import.meta.url))

/** The two files that are ALLOWED to name `env(safe-area-inset-*)`: the module
 *  that publishes the vars, and its own unit test. Everything else consumes. */
const PUBLISHERS = new Set(['lib/safe-area.ts', 'lib/safe-area.test.ts'])

/** `styles.css` is the third: it declares the `:root` fallback the publisher
 *  overrides. Only that declaration form is permitted there — a rule that pads
 *  with `env()` is still a bug. */
const ROOT_FALLBACK = /^\s*--safe-area-inset-(top|right|bottom|left):\s*env\(safe-area-inset-\1[^)]*\);\s*$/

const RAW_ENV = /env\(\s*safe-area-inset-/

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name)

    if (entry.isDirectory()) {
      return sourceFiles(full)
    }

    return /\.(ts|tsx|css)$/.test(entry.name) ? [full] : []
  })
}

/** Every `file:line` outside the publishers that still reads `env()` directly. */
function offenders(): string[] {
  const found: string[] = []

  for (const file of sourceFiles(SRC)) {
    const rel = path.relative(SRC, file).split(path.sep).join('/')

    if (PUBLISHERS.has(rel) || rel === 'styles.safe-area-vars.test.ts') {
      continue
    }

    fs.readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (!RAW_ENV.test(line)) {
          return
        }

        if (rel === 'styles.css' && ROOT_FALLBACK.test(line)) {
          return
        }

        found.push(`${rel}:${i + 1}`)
      })
  }

  return found
}

describe('the app reads the published safe-area vars, never raw env()', () => {
  it('has no raw env(safe-area-inset-*) outside lib/safe-area.ts', () => {
    // If this fails, swap the offending `env(safe-area-inset-x)` for
    // `var(--safe-area-inset-x)`. The :root declaration in styles.css already
    // supplies the env() fallback for desktop and web, where it resolves to 0.
    expect(offenders()).toEqual([])
  })

  it('still finds the :root declaration it is allowing through', () => {
    // Guards the allowance itself: if styles.css stopped publishing the vars,
    // every `var(--safe-area-inset-*)` above would compute to nothing and the
    // sweep would pass while the insets silently disappeared.
    const css = fs.readFileSync(path.join(SRC, 'styles.css'), 'utf8')

    for (const side of ['top', 'right', 'bottom', 'left']) {
      expect(css).toMatch(new RegExp(`--safe-area-inset-${side}:\\s*env\\(safe-area-inset-${side}`))
    }
  })

  it('names the surfaces this sweep was introduced for', () => {
    // The five sites that had drifted. Spot-checked by content rather than left
    // to the sweep alone, so a future refactor that deletes the padding
    // outright — which the sweep would happily pass — shows up here.
    const reads = (rel: string, side: string) =>
      expect(fs.readFileSync(path.join(SRC, rel), 'utf8')).toContain(`var(--safe-area-inset-${side})`)

    reads('app/onboarding/onboarding-screen.tsx', 'top')
    reads('app/shell/sidebar.tsx', 'top')
    reads('app/shell/statusbar-controls.tsx', 'bottom')
    reads('components/notifications.tsx', 'top')
    reads('app/wake-indicator-overlay.css', 'top')
  })
})
