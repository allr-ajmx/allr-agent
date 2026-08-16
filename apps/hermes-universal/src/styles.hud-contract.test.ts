/**
 * The HUD stylesheet's DOM contract (MJXHRM-438).
 *
 * **This is the test whose absence caused the bug it now guards.** The HUD's
 * entire visual identity — collapse at rest, the glance, the reveal on focus —
 * was three `html[data-hud]` rules scoped to `[data-slot='composer-bounds']`, an
 * element only `apps/desktop` has ever rendered. They matched nothing, in a
 * window nobody's tests opened, for the life of the feature. `--hud-band-max`
 * was computed in React and read by no rule; `data-hud-engaged` drove nothing.
 * Everything typechecked, every suite was green, and the shipped HUD was a
 * miniature chat window.
 *
 * A stylesheet selector is a contract between two files that never import each
 * other, so nothing in the toolchain can notice when one end moves. This closes
 * it: every `data-*` attribute, every attribute VALUE and every class the HUD
 * block selects on has to be rendered by something in `src/`, or this fails with
 * the offending selector's own text.
 *
 * Scoped to `html[data-hud]` deliberately. That is the block with no other
 * reader — every other rule in this stylesheet is exercised by the main window
 * every time anyone looks at it, while a HUD only opens on a chord, over other
 * applications, on a developer's real machine.
 *
 * Two traps this went through while being written, both worth keeping in mind
 * before "simplifying" the scan:
 *
 *  1. **A mention is not a render.** `store/composer-popout.ts` both documents
 *     and `querySelector`s `[data-slot="composer-bounds"]` — while saying in the
 *     same comment that this app has no such element. A scan that accepted a
 *     quoted string anywhere reported the dead selector as live, i.e. came back
 *     green over the very defect it exists to find.
 *  2. **A render is not always a literal.** The composer's own input is
 *     `data-slot={RICH_INPUT_SLOT}`, and that constant is declared in a
 *     different file. A scan that only accepted `data-slot="…"` reported a live
 *     element as dead — and MJXHRM-433 is explicit that a false orphan is the
 *     expensive direction of this error.
 *
 * So the scan collects RENDER SITES (a JSX prop or a `dataset` write) and
 * resolves single-identifier values through module constants.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const SRC = path.dirname(fileURLToPath(import.meta.url))

/** Every selector list in `css`, comments stripped. */
function selectorLists(css: string): string[] {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const lists: string[] = []
  let cursor = 0

  for (let i = 0; i < bare.length; i++) {
    const ch = bare[i]

    if (ch === '{' || ch === '}' || ch === ';') {
      if (ch === '{') {
        lists.push(bare.slice(cursor, i).trim())
      }

      cursor = i + 1
    }
  }

  return lists.filter(Boolean)
}

/** Every `.ts`/`.tsx` file that could RENDER something. Tests excluded: a
 *  fixture producing the attribute would let a selector outlive its element. */
function sourceFiles(dir: string): string[] {
  const out: string[] = []

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)

    if (entry.isDirectory()) {
      out.push(...sourceFiles(full))
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full)
    }
  }

  return out
}

/** Comments out — that is where a reference to a deleted element survives. */
const SOURCES = sourceFiles(SRC)
  .map(file => fs.readFileSync(file, 'utf8'))
  .map(source =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter(line => !/^\s*(\/\/|\*)/.test(line))
      .join('\n')
  )

/** `const RICH_INPUT_SLOT = 'composer-rich-input'` — how a slot name reaches a
 *  JSX prop from another module. */
const CONSTANTS = new Map<string, string>()

for (const source of SOURCES) {
  for (const [, name, , value] of source.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)(?:\s*:[^=\n]+)?\s*=\s*(['"])([^'"\n]*)\2/g
  )) {
    CONSTANTS.set(name, value)
  }
}

/** Every value an attribute expression could evaluate to: its own string
 *  literals, plus any bare identifier resolved through a module constant. */
function valuesIn(expression: string): string[] {
  const literals = [...expression.matchAll(/(['"`])([^'"`\n]*)\1/g)].map(m => m[2])

  const identifiers = [...expression.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)]
    .map(m => CONSTANTS.get(m[1]))
    .filter((value): value is string => value !== undefined)

  return [...literals, ...identifiers]
}

/**
 * Every `data-*` attribute the app RENDERS, and the values it renders it with.
 *
 * A render site is a JSX prop (preceded by whitespace or `{`) or a `dataset`
 * write. The prefix requirement is what excludes the same text sitting inside a
 * selector string, where it is preceded by `[`.
 */
const RENDERED = new Map<string, Set<string>>()

function record(attribute: string, values: string[]): void {
  const seen = RENDERED.get(attribute) ?? new Set<string>()

  for (const value of values) {
    seen.add(value)
  }

  RENDERED.set(attribute, seen)
}

for (const source of SOURCES) {
  for (const [, attribute, expression] of source.matchAll(
    /(?:^|[\s{])(data-[a-z][\w-]*)=(\{[^}]*\}|(['"])[^'"\n]*\3)/gm
  )) {
    record(attribute, valuesIn(expression))
  }

  // A valueless prop — `<div data-hud-card>` — which React renders as the empty
  // string. The selectors that matter most in the HUD block are exactly these.
  for (const [, attribute] of source.matchAll(/(?:^|[\s{])(data-[a-z][\w-]*)(?![\w=-])/gm)) {
    record(attribute, [''])
  }

  // `container.dataset.slot = RICH_INPUT_SLOT` — the same attribute, written
  // imperatively. `documentElement.dataset.hud = ''` is how `html[data-hud]`
  // itself comes to exist, so without this arm the whole block reads as dead.
  for (const [, key, expression] of source.matchAll(/\bdataset\.([A-Za-z][\w$]*)\s*=\s*([^\n;]+)/g)) {
    record(`data-${key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`, valuesIn(expression))
  }
}

/**
 * Every whitespace-separated token inside any quoted string in the app.
 *
 * Deliberately broad for CLASSES only: a class reaches the DOM through `cn()`
 * compositions and shared constants — `.thread-jump-button` is one word of a
 * nine-class Tailwind string — and there is no render-site shape to key on the
 * way there is for an attribute.
 */
const STRING_TOKENS = new Set<string>(
  SOURCES.flatMap(source =>
    [...source.matchAll(/(['"`])((?:[^\\\n]|\\.)*?)\1/g)].flatMap(match => match[2].split(/\s+/))
  ).filter(Boolean)
)

const HUD_SELECTORS = selectorLists(fs.readFileSync(path.join(SRC, 'styles.css'), 'utf8')).filter(list =>
  list.includes('html[data-hud]')
)

describe('the html[data-hud] stylesheet block', () => {
  // If this ever reads 0 the tests below pass vacuously, which is the exact
  // failure mode of a contract test nobody re-reads.
  it('is a block that actually exists', () => {
    expect(HUD_SELECTORS.length).toBeGreaterThan(4)
  })

  it('selects only data-attributes something in src/ renders', () => {
    const missing: string[] = []

    for (const list of HUD_SELECTORS) {
      for (const [, attribute, , value] of list.matchAll(/\[(data-[\w-]+)(?:\s*=\s*(['"])(.*?)\2)?\]/g)) {
        const values = RENDERED.get(attribute)

        if (!values) {
          missing.push(`${list} → [${attribute}]`)

          continue
        }

        // A value the app never writes makes the rule as dead as a missing
        // attribute: `[data-hud-band-state='shut']` would match nothing while
        // reading as entirely correct.
        if (value !== undefined && !values.has(value)) {
          missing.push(`${list} → [${attribute}='${value}']`)
        }
      }
    }

    expect(missing).toEqual([])
  })

  it('selects only classes something in src/ renders', () => {
    const missing: string[] = []

    for (const list of HUD_SELECTORS) {
      for (const [, className] of list.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) {
        if (!STRING_TOKENS.has(className)) {
          missing.push(`${list} → .${className}`)
        }
      }
    }

    expect(missing).toEqual([])
  })

  // The original defect, named. Pinned separately from the general rule so the
  // regression has a test that says what it is, rather than one that says "some
  // selector somewhere".
  it('never reaches for the composer-bounds element desktop has and this app does not', () => {
    expect(HUD_SELECTORS.filter(list => list.includes('composer-bounds'))).toEqual([])
  })
})
