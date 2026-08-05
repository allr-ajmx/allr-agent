/**
 * Build transform: give every store a name.
 *
 * Rewrites `export const $foo = atom(x)` to `atom(x, '$foo')` so the wrapper in
 * `stores.ts` can label its spans. Every atom in the app is a module-level
 * `export const $Name = …`, so this covers them all, and real nanostores ignores
 * trailing arguments — which makes the rewrite inert whenever the alias is off.
 *
 * Without it every store span would read `anonymous`, which is the one outcome
 * that would make store autocapture pointless: knowing a write was slow without
 * knowing which store wrote is barely better than not knowing.
 *
 * THIS LIVES HERE, NOT IN vite.config.ts, because it is the piece most able to
 * break the build — it edits source text in every store module — and code that
 * dangerous should be testable. The first version used a regex and produced
 * `atom(hasSavedTarget(, '$restoring') || hasPendingOAuth())`, a parse error in
 * a module the whole app imports. See store-names.test.ts.
 */

/** Modules whose stores are constructed dynamically and name themselves. */
const OPENER = /export const (\$[A-Za-z0-9_]+)(?::[^=]+)? = (?:atom|map)\(/g

/**
 * Index of the `)` closing the call whose `(` is at `open`, or -1.
 *
 * Balanced rather than regex because arguments nest — `atom(a() || b())` is
 * real code in this app — and quote-aware because a default like `atom(')')`
 * would otherwise throw the depth count off.
 */
export function findCallEnd(code: string, open: number): number {
  let depth = 0
  let quote = ''

  for (let i = open; i < code.length; i += 1) {
    const ch = code[i]

    if (quote) {
      if (ch === '\\') {
        i += 1
      } else if (ch === quote) {
        quote = ''
      }

      continue
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
    } else if (ch === '(') {
      depth += 1
    } else if (ch === ')') {
      depth -= 1

      if (depth === 0) {
        return i
      }
    }
  }

  return -1
}

/** Returns rewritten source, or null when there was nothing to do. */
export function addStoreNames(code: string): null | string {
  if (!code.includes('atom(') && !code.includes('map(')) {
    return null
  }

  const opener = new RegExp(OPENER.source, 'g')
  const edits: { at: number; text: string }[] = []
  let match: RegExpExecArray | null

  while ((match = opener.exec(code)) !== null) {
    const open = match.index + match[0].length - 1
    const close = findCallEnd(code, open)

    if (close === -1) {
      continue
    }

    const args = code.slice(open + 1, close).trim()

    // IDEMPOTENT. This transform matches raw text, so it also sees `export
    // const $x = atom(` written inside a string or a comment — its own test
    // fixtures are exactly that, and the first version rewrote them and then
    // rewrote the rewrite. Bailing when the call already carries this store's
    // name makes a second pass a no-op instead of a corruption.
    if (args.endsWith(`'${match[1]}'`)) {
      continue
    }

    // `atom()` with no initial value still needs one, or the name would land in
    // the value position and every such store would boot holding its own name.
    edits.push({ at: close, text: args ? `, '${match[1]}'` : `undefined, '${match[1]}'` })
  }

  if (edits.length === 0) {
    return null
  }

  // Back-to-front so earlier offsets stay valid as text is inserted.
  let next = code

  for (const edit of edits.reverse()) {
    next = `${next.slice(0, edit.at)}${edit.text}${next.slice(edit.at)}`
  }

  return next
}
