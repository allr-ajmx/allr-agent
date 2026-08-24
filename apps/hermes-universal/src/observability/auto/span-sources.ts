/**
 * Build transform: tell every span which module raised it.
 *
 * Rewrites the IMPORT, not the call sites:
 *
 *   import { isRecording, recordSpan } from '@/observability'
 *
 * becomes
 *
 *   import { isRecording, withSource as __withSource } from '@/observability'
 *   const { recordSpan } = __withSource('components/chat/code-fence.tsx')
 *
 * One rewrite per module instead of one per call, which is what makes this
 * cheap enough to be worth doing: the app has ~17 emitting modules and several
 * hundred call sites, and a per-call rewrite would have to know which argument
 * position holds `attrs` for six different signatures. The import knows nothing
 * and has to know nothing.
 *
 * It stays on ONE LINE for the same reason `store-names.ts` only appends inside
 * an existing call: line numbers are unchanged, so `map: null` is honest and a
 * stack trace still points where it says it does.
 *
 * WHY THIS IS WORTH A TRANSFORM AT ALL. A span says what happened and when. It
 * never said where it was raised from, so reading a capture meant recognising an
 * operation name and remembering which module emits it — and `span` is exported
 * to nine modules, several of which emit names that read alike. Hand-writing the
 * module name at each call site would work exactly until someone copied a call
 * into another file, which is the failure mode this whole layer is built to
 * avoid: instrumentation that is quietly wrong reads exactly like
 * instrumentation that is right.
 *
 * THIS LIVES HERE, NOT IN vite.config.ts, for the reason `store-names.ts` gives:
 * it edits source text in modules the whole app imports, and code that dangerous
 * should be testable.
 */

/** Only the helpers that can open or record a span get bound. */
const SOURCED = new Set(['beginDetached', 'beginSpan', 'openSpan', 'recordSpan', 'span', 'spanAsync'])

/**
 * The observability import, in either of the two shapes the app writes it: the
 * public surface (`@/observability`) and the sibling reach inside `auto/`
 * (`../span`, `./span`).
 *
 * Type-only imports are excluded by requiring `{` to follow directly — a
 * `import type { SpanAttrs }` line has `type` in between, and rewriting it would
 * produce a runtime `const` destructuring a type.
 */
const IMPORT = /import \{([^}]*)\} from '(@\/observability|\.{1,2}\/span)'/g

interface Split {
  /** Named imports that stay a real import (types, `isRecording`, …). */
  plain: string[]
  /** Named imports that become facade properties. */
  sourced: string[]
}

/** Split one import clause into what the facade provides and what it does not. */
function splitClause(clause: string): Split {
  const plain: string[] = []
  const sourced: string[] = []

  for (const raw of clause.split(',')) {
    const specifier = raw.trim()

    if (!specifier) {
      continue
    }

    // `type X` and `X as Y` both stay as they are: a type has no runtime
    // binding to rebind, and an alias is rare enough here that not handling it
    // is better than handling it subtly wrong.
    if (SOURCED.has(specifier)) {
      sourced.push(specifier)
    } else {
      plain.push(specifier)
    }
  }

  return { plain, sourced }
}

/**
 * The module name a span will carry: repo-relative, `src/` stripped.
 *
 * Short enough to read in a Jaeger tag and still unambiguous — `auto/frames.ts`
 * and `components/chat/code-fence.tsx` are both immediately placeable, which
 * a bare basename would not be (`index.ts` names nothing).
 */
export function sourceNameFor(id: string): string {
  const withoutQuery = id.split('?')[0]
  const at = withoutQuery.lastIndexOf('/src/')

  return at === -1 ? withoutQuery.replace(/^.*\//, '') : withoutQuery.slice(at + '/src/'.length)
}

/** Returns rewritten source, or null when there was nothing to do. */
export function addSpanSources(code: string, id: string): null | string {
  if (!code.includes("from '@/observability'") && !code.includes("/span'")) {
    return null
  }

  // IDEMPOTENT, like `addStoreNames`: a second pass must be a no-op rather than
  // a facade wrapping a facade.
  if (code.includes('__withSource')) {
    return null
  }

  const source = sourceNameFor(id)
  const importer = new RegExp(IMPORT.source, 'g')
  const edits: { from: number; text: string; to: number }[] = []
  let match: RegExpExecArray | null

  while ((match = importer.exec(code)) !== null) {
    // A multi-line import clause would collapse to one line and shift every
    // line number below it, which is the one thing `map: null` promises does
    // not happen. Left alone — those modules simply go unattributed, and the
    // fix is to write the import on one line.
    if (match[0].includes('\n')) {
      continue
    }

    const { plain, sourced } = splitClause(match[1])

    if (sourced.length === 0) {
      continue
    }

    const specifier = match[2]
    const kept = [...plain, 'withSource as __withSource'].join(', ')

    edits.push({
      from: match.index,
      text: `import { ${kept} } from '${specifier}'; const { ${sourced.join(', ')} } = __withSource('${source}')`,
      to: match.index + match[0].length
    })
  }

  if (edits.length === 0) {
    return null
  }

  // Back-to-front so earlier offsets stay valid as text is replaced.
  let next = code

  for (const edit of edits.reverse()) {
    next = `${next.slice(0, edit.from)}${edit.text}${next.slice(edit.to)}`
  }

  return next
}
