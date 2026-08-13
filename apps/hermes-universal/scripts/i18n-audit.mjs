#!/usr/bin/env node
/**
 * i18n catalog audit — the guard for the two drift directions nothing else sees.
 *
 * `Translations` (types.ts) is a compiler-enforced contract for ONE direction
 * only: `en` must be total, and a static `t.a.b.c` that names a deleted key
 * fails typecheck. Everything else about the catalog is invisible to tsc:
 *
 *   - A key nothing consumes still typechecks, still ships. `catalog.ts`
 *     imports all five locales eagerly, so a dead key costs every user bytes in
 *     the main chunk, times five.
 *   - `defineLocale` takes a DEEP PARTIAL and merges it over `en`, so a locale
 *     that never translates a key is indistinguishable from one that does —
 *     the UI just silently renders English. That is how MJXHRM-422's own first
 *     pass regressed ja/zh-hant: it deleted the rails' hand-rolled labels (which
 *     both locales HAD translated) and pointed the UI at `zones.*` (which
 *     neither locale translated at all), turning two localised menus English.
 *   - `translateNow('a.b.c')` resolves a dot-path at RUNTIME. tsc types the
 *     argument as `string`, so those call sites survive any deletion and fail
 *     by rendering the raw key to the user.
 *
 * Three rules, all baselined against `i18n-audit-baseline.json`. The baseline
 * records today's debt so the check can be green on landing; it may only ever
 * SHRINK — an entry that no longer applies is an error, which is what makes it
 * a ratchet rather than a suppression file.
 *
 *   R1 orphans        — an `en` leaf key no code path can reach.
 *   R2 over-specified — a locale key `en` does not declare. Never baselined:
 *                       it merges into the tree and is unreachable by anything.
 *   R3 untranslated   — a key code DOES reach that a locale leaves to English.
 *
 * Reachability is deliberately over-approximate (it errs toward "referenced"):
 * a false "orphan" would delete a live string, which is user-visible breakage,
 * where a missed orphan only wastes bytes. See `isReferenced`.
 *
 *   node scripts/i18n-audit.mjs            # check (exit 1 on any violation)
 *   node scripts/i18n-audit.mjs --write    # regenerate the baseline
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

const APP = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const SRC = path.join(APP, 'src')
const I18N = path.join(SRC, 'i18n')
const BASELINE = path.join(APP, 'scripts', 'i18n-audit-baseline.json')

const DEFAULT_LOCALE = 'en'
const LOCALES = ['en', 'ar', 'ja', 'zh', 'zh-hant']
/** The catalog itself is not a consumer — every key "appears" in it by definition. */
const CATALOG_FILES = new Set(LOCALES.concat('types').map(n => path.join(I18N, `${n}.ts`)))

const write = process.argv.includes('--write')

// ---------------------------------------------------------------- parsing --

function sourceFile(file) {
  const text = fs.readFileSync(file, 'utf8')

  // A literal NUL makes grep/ripgrep/`git diff` skip a file SILENTLY, which is
  // how three earlier audits "found zero references" in files they never read.
  // This audit reads bytes, so it is immune — but a NUL in a source file is a
  // corruption worth failing on rather than tolerating.
  if (text.includes('\u0000')) {
    throw new Error(`${path.relative(APP, file)} contains a literal NUL byte — refusing to audit a corrupt tree`)
  }

  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
}

function tsFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)

    if (entry.isDirectory()) {
      tsFiles(p, out)
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(p)
    }
  }

  return out
}

function propertyName(node) {
  return ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : null
}

/**
 * Leaf key paths of a message-tree object literal.
 *
 * An EMPTY object literal is emitted as a leaf itself: `messaging.platformIntro`
 * is `{}` in `en` and typed `Record<string, string>`, so it is a dynamic group,
 * not a group with no keys. Emitting it lets the prefix rule below treat every
 * locale's entries under it as dynamic rather than as over-specification.
 */
function leafPaths(obj, prefix, out) {
  if (obj.properties.length === 0) {
    out.push(prefix.join('.'))
    return out
  }

  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) {
      continue
    }

    const name = propertyName(prop)

    if (name === null) {
      continue
    }

    const next = [...prefix, name]

    if (ts.isObjectLiteralExpression(prop.initializer)) {
      leafPaths(prop.initializer, next, out)
    } else {
      out.push(next.join('.'))
    }
  }

  return out
}

/** The object literal a locale module declares — `en = {...}` or `defineLocale({...})`. */
function localeKeys(locale) {
  const file = path.join(I18N, `${locale}.ts`)
  const sf = sourceFile(file)
  let literal = null

  const visit = node => {
    if (literal !== null) {
      return
    }

    if (ts.isCallExpression(node) && node.expression.getText() === 'defineLocale' && node.arguments.length > 0) {
      const arg = node.arguments[0]

      if (ts.isObjectLiteralExpression(arg)) {
        literal = arg
        return
      }
    }

    if (ts.isVariableDeclaration(node) && node.initializer) {
      let init = node.initializer

      while (ts.isAsExpression(init) || ts.isSatisfiesExpression(init)) {
        init = init.expression
      }

      if (ts.isObjectLiteralExpression(init)) {
        literal = init
        return
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sf)

  if (literal === null) {
    throw new Error(`no message-tree object literal found in ${path.relative(APP, file)}`)
  }

  return leafPaths(literal, [], [])
}

// ------------------------------------------------------------ consumer scan --

/**
 * Everything a key could be named by, harvested from every non-catalog source
 * file. Three shapes, because the app reaches keys three ways:
 *
 *   `t.zones.closeAll`            → property name  → `tokens`
 *   `translateNow('zones.close')` → string literal → `literals` (and `tokens`,
 *                                    split on dots, for destructured access)
 *   `t.keybinds.actions[id]`      → computed       → `computedTails`
 */
function scanConsumers() {
  const files = tsFiles(SRC).filter(f => !CATALOG_FILES.has(f))
  const tokens = new Set()
  const literals = new Set()
  const computedTails = new Set()

  const addSegments = text => {
    for (const segment of text.split('.')) {
      if (segment !== '') {
        tokens.add(segment)
      }
    }
  }

  for (const file of files) {
    const visit = node => {
      if (ts.isIdentifier(node)) {
        tokens.add(node.text)
      } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        literals.add(node.text)
        addSegments(node.text)
      } else if (ts.isTemplateExpression(node)) {
        // A key assembled from a template literal: keep every static segment,
        // so `` `zones.${verb}` `` still marks `zones` as reachable.
        addSegments(node.head.text)

        for (const span of node.templateSpans) {
          addSegments(span.literal.text)
        }
      } else if (ts.isPropertyAccessExpression(node)) {
        tokens.add(node.name.text)
      } else if (ts.isElementAccessExpression(node)) {
        const chain = []
        let current = node.expression

        while (ts.isPropertyAccessExpression(current)) {
          chain.unshift(current.name.text)
          current = current.expression
        }

        if (chain.length > 0) {
          computedTails.add(chain.join('.'))
        }
      }

      ts.forEachChild(node, visit)
    }

    visit(sourceFile(file))
  }

  return { computedTails, files, literals, tokens }
}

/**
 * Whether any code path could reach `key`. Over-approximate on purpose: the
 * cost of a false negative (a live key called dead, then deleted) is a broken
 * screen, the cost of a false positive is a few dead bytes.
 */
function isReferenced(key, scan) {
  if (scan.literals.has(key)) {
    return true
  }

  const parts = key.split('.')

  if (scan.tokens.has(parts[parts.length - 1])) {
    return true
  }

  // Any ANCESTOR group read with a computed index makes the whole subtree
  // reachable — `t.keybinds.actions[action.id]` can name every leaf under it.
  for (let i = 1; i < parts.length; i++) {
    const tail = parts.slice(0, i).join('.')

    for (const candidate of scan.computedTails) {
      if (candidate === tail || candidate.endsWith(`.${tail}`)) {
        return true
      }
    }
  }

  return false
}

// -------------------------------------------------------------------- run --

function audit() {
  const scan = scanConsumers()
  const keys = Object.fromEntries(LOCALES.map(l => [l, localeKeys(l)]))
  const enKeys = keys[DEFAULT_LOCALE]
  const enSet = new Set(enKeys)

  // A key under an `en` LEAF is inside a dynamic group (`Record<string, ...>`
  // in types.ts, e.g. `settings.fieldLabels`). Locales may legitimately fill
  // those in, and they are not comparable key-by-key.
  const underDynamicGroup = key => {
    const parts = key.split('.')

    for (let i = 1; i < parts.length; i++) {
      if (enSet.has(parts.slice(0, i).join('.'))) {
        return true
      }
    }

    return false
  }

  const orphans = enKeys.filter(k => !isReferenced(k, scan)).sort()
  const orphanSet = new Set(orphans)

  const overSpecified = {}
  const untranslated = {}

  for (const locale of LOCALES) {
    if (locale === DEFAULT_LOCALE) {
      continue
    }

    const localeSet = new Set(keys[locale])
    const extra = keys[locale].filter(k => !enSet.has(k) && !underDynamicGroup(k)).sort()

    if (extra.length > 0) {
      overSpecified[locale] = extra
    }

    // Only keys code actually reaches: an orphan nobody renders cannot leak
    // English at anybody, so requiring a translation for it would be noise.
    untranslated[locale] = enKeys.filter(k => !orphanSet.has(k) && !localeSet.has(k) && !underDynamicGroup(k)).sort()
  }

  return { keys, orphans, overSpecified, scan, untranslated }
}

const { keys, orphans, overSpecified, scan, untranslated } = audit()

if (write) {
  fs.writeFileSync(BASELINE, `${JSON.stringify({ orphans, untranslated }, null, 2)}\n`)
  console.log(
    `wrote ${path.relative(APP, BASELINE)}: ${orphans.length} orphans, ` +
      `${Object.entries(untranslated)
        .map(([l, v]) => `${l}=${v.length}`)
        .join(' ')}`
  )
  process.exit(0)
}

const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'))
const failures = []

function diffAgainstBaseline(label, actual, recorded, { fixedBy, staleBy }) {
  const recordedSet = new Set(recorded)
  const actualSet = new Set(actual)
  const added = actual.filter(k => !recordedSet.has(k))
  const gone = recorded.filter(k => !actualSet.has(k))

  if (added.length > 0) {
    failures.push(`${label}: ${added.length} NEW\n${added.map(k => `    + ${k}`).join('\n')}\n  ${fixedBy}`)
  }

  if (gone.length > 0) {
    failures.push(
      `${label}: ${gone.length} baseline entries no longer apply\n${gone.map(k => `    - ${k}`).join('\n')}\n  ${staleBy}`
    )
  }
}

diffAgainstBaseline('R1 orphaned keys', orphans, baseline.orphans ?? [], {
  fixedBy: 'Delete the key from types.ts and every locale, or wire up the screen that renders it.',
  staleBy: 'These keys are live again — run `npm run i18n:baseline` to shrink the baseline.'
})

for (const locale of Object.keys(untranslated)) {
  diffAgainstBaseline(
    `R3 untranslated but rendered (${locale})`,
    untranslated[locale],
    baseline.untranslated?.[locale] ?? [],
    {
      fixedBy: `Translate them in src/i18n/${locale}.ts — until then this locale renders English here.`,
      staleBy: `Translated (or no longer rendered) — run \`npm run i18n:baseline\` to shrink the baseline.`
    }
  )
}

for (const [locale, extra] of Object.entries(overSpecified)) {
  failures.push(
    `R2 over-specified (${locale}): ${extra.length} key(s) \`en\` does not declare\n` +
      `${extra.map(k => `    + ${k}`).join('\n')}\n` +
      '  These merge into the tree and nothing can read them. Remove them, or add them to en.ts + types.ts.'
  )
}

const summary =
  `i18n audit — ${keys.en.length} en keys, ${scan.files.length} consumer files, ` +
  `${orphans.length} orphaned, ` +
  LOCALES.filter(l => l !== DEFAULT_LOCALE)
    .map(l => `${l} ${keys[l].length}/${keys.en.length}`)
    .join(' ')

if (failures.length > 0) {
  console.error(`${summary}\n`)
  for (const failure of failures) {
    console.error(`✗ ${failure}\n`)
  }
  console.error(`${failures.length} i18n rule violation(s).`)
  process.exit(1)
}

console.log(`${summary} — OK`)
