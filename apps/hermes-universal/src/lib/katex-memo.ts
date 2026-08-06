/**
 * Memoizing wrapper around `rehype-katex` that collapses each equation to a
 * SINGLE hast node carrying KaTeX's HTML as a string.
 *
 * Two separate problems, one plugin.
 *
 * 1. Repeat work. The default `@streamdown/math` plugin runs `rehype-katex` on
 *    every markdown commit. During streaming that means each new token re-runs
 *    KaTeX on EVERY math node in the message, including equations that haven't
 *    changed. We key each equation on `(displayMode, value)` in a process-global
 *    LRU, so a unique equation pays the KaTeX cost once and survives remounts
 *    (session switch, message-list churn).
 *
 * 2. Tree size — the bigger problem, and the reason this file no longer
 *    produces hast subtrees at all. KaTeX emits ~65 `<span>`s for one display
 *    equation. Handed to rehype as nodes, each one becomes a hast node, then a
 *    React element, then an inline-styled DOM node. Measured on
 *    `src/dev/fixtures/latex-heavy.md` (bench/pipeline-bench.mjs):
 *
 *      hast nodes, no math render                  306
 *      hast nodes, expanded KaTeX                 2528   (8.3x)
 *      hast nodes, collapsed KaTeX                 306   (1x)
 *
 *      unified → hast, expanded KaTeX          23-31ms
 *      unified → hast, collapsed KaTeX          ~9.5ms
 *
 *    That 8.3x is what made a math transcript expensive to BUILD (React walks
 *    every node) and expensive to KEEP (every later style recalc / layout pass
 *    walks every DOM node — which is why toggling a sidebar or resizing the
 *    window stalled on a math-heavy chat but not a prose one).
 *
 *    Only ~a third of that difference is KaTeX itself; the rest was
 *    `hast-util-from-html-isomorphic` parsing KaTeX's HTML string back into
 *    hast (~0.61ms/equation, 3.4x the ~0.18ms render it follows) purely so the
 *    result could be re-serialized into DOM. We never inspect those nodes, so
 *    the round trip bought nothing.
 *
 * So: cache the HTML STRING, and splice in one `<katex-html>` element holding
 * it. `markdown-text.tsx` registers a component for that tag which writes the
 * string with `dangerouslySetInnerHTML` — one engine-side innerHTML parse
 * instead of ~65 JS-driven createElement calls. KaTeX's own markup is
 * unchanged; it just arrives inside one host element instead of as loose
 * siblings, and the path from string to DOM is what moved.
 *
 * Everything else deliberately still mirrors `rehype-katex`: the same class
 * detection, the same `<pre>`-walk-up for ```math fences, the same
 * strict-then-lenient two-pass render with a VFile message on the first
 * failure, and the same parent-splice semantics. Drop-in replacement for the
 * math slot in streamdown's PluginConfig.
 *
 * Wire it in via `createMemoizedMathPlugin`:
 *
 *   import { createMemoizedMathPlugin } from '@/lib/katex-memo'
 *   const math = createMemoizedMathPlugin({ singleDollarTextMath: true })
 *   <Streamdown plugins={{ math }} ... />
 */

import type { Element, Parent, Root } from 'hast'
import { toText } from 'hast-util-to-text'
import katex from 'katex'
import remarkMath from 'remark-math'
import type { Pluggable } from 'unified'
import { SKIP, visitParents } from 'unist-util-visit-parents'
import type { VFile } from 'vfile'

import { span } from '@/observability'

/**
 * Tag name for the collapsed node. Must stay in sync with the component
 * registered under the same key in
 * `components/assistant-ui/markdown-text.tsx` — `hast-util-to-jsx-runtime`
 * resolves components by an exact own-property lookup on `tagName`.
 *
 * A hyphen makes it a valid custom-element name, so if the component is ever
 * missing the browser renders an inert unknown element rather than choking.
 */
export const KATEX_HTML_TAG = 'katex-html'

interface KatexMemoOptions {
  /**
   * Color used for KaTeX errors when we fall back to the lenient parser.
   * Mirrors `@streamdown/math`'s default so the visual output is identical.
   */
  errorColor?: string
}

interface MathPluginConfig {
  /**
   * Match `singleDollarTextMath` from `@streamdown/math`. When true the
   * remark-math parser treats `$x$` as inline math; when false it requires
   * `$$x$$`. Models almost always emit the single-dollar form, so we
   * default it to true at the createMemoizedMathPlugin call site.
   */
  singleDollarTextMath?: boolean
  errorColor?: string
}

/**
 * Cached render — KaTeX's HTML for one equation, verbatim.
 *
 * A string, not a hast subtree: nothing downstream reads the structure, and
 * keeping it as a string is what lets one equation cost one node.
 */
type CachedRender = string

// Entries are now strings rather than ~65-node subtrees, so the cache is far
// cheaper per entry than it was and can hold a whole long session's equations.
const CACHE_LIMIT = 2048

class LruCache<K, V> {
  private readonly map = new Map<K, V>()

  get(key: K): undefined | V {
    const value = this.map.get(key)

    if (value === undefined) {
      return undefined
    }

    // Refresh recency by re-inserting at the tail. Map iteration order is
    // insertion order, so the oldest entry is at the head.
    this.map.delete(key)
    this.map.set(key, value)

    return value
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key)
    } else if (this.map.size >= CACHE_LIMIT) {
      const oldest = this.map.keys().next().value

      if (oldest !== undefined) {
        this.map.delete(oldest)
      }
    }

    this.map.set(key, value)
  }
}

const cache = new LruCache<string, CachedRender>()

/**
 * Note what is NOT in the key: `errorColor`. The cache is module-global and
 * shared by every plugin instance, and errorColor IS baked into the lenient
 * pass's output — so two instances configured with different colors would share
 * the first one's error markup. There is one instance today (markdown-text.tsx),
 * so this is a latent trap rather than a bug; add it to the key if that changes.
 *
 * A cached FAILURE is fine — renderMath is deterministic in (value, displayMode)
 * — but note the `file.message` diagnostic only fires on a miss, so a repeated
 * broken equation reports once, not once per occurrence. Nothing reads
 * `file.messages` today.
 */
function cacheKey(displayMode: boolean, value: string): string {
  // `\u0001` is a control character that (a) won't appear in normal
  // markdown and (b) is a single byte so the join is cheap.
  return `${displayMode ? 'd' : 'i'}\u0001${value}`
}

/** Minimal HTML-text escape for the last-resort error fallback. */
function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * Render one math expression to an HTML string, with the same two-pass strategy
 * `rehype-katex` uses internally: try strict first (so genuine TeX errors get
 * reported in the VFile message stream), and on failure fall back to lenient
 * mode so the document still renders without a thrown exception. The lenient
 * fallback paints the equation in `errorColor` instead of erroring out.
 *
 * SECURITY — this string is written to the DOM with `dangerouslySetInnerHTML`
 * by the `katex-html` component, so what it may contain is load-bearing:
 *
 *   - `trust` is never passed, so it keeps KaTeX's default of `false`. That is
 *     what disables `\href`, `\url`, `\htmlClass`, `\htmlId`, `\htmlStyle` and
 *     `\includegraphics` — the only commands that can emit a URL or an
 *     attribute derived from the TeX source. With trust off KaTeX renders them
 *     as visible error text instead. DO NOT enable `trust`.
 *   - Everything else KaTeX writes is escaped by KaTeX itself; the markup is
 *     generated from its own parse tree, not interpolated from the source.
 *   - The error branches below never interpolate raw input either: the source
 *     text goes through `escapeHtml`.
 *
 * So the string is KaTeX-generated markup with no attacker-reachable sink. Any
 * change that widens this (enabling `trust`, or accepting HTML from elsewhere)
 * must be reviewed against the innerHTML write in markdown-text.tsx.
 */
function renderMath(value: string, displayMode: boolean, errorColor: string, file: VFile, element: Element): string {
  try {
    return katex.renderToString(value, { displayMode, throwOnError: true })
  } catch (error) {
    const cause = error as Error

    file.message('Could not render math with KaTeX', {
      cause,
      place: element.position,
      ruleId: cause.name?.toLowerCase() ?? 'katex',
      source: 'rehype-katex-memo'
    })

    try {
      return katex.renderToString(value, {
        displayMode,
        errorColor,
        strict: 'ignore',
        throwOnError: false
      })
    } catch {
      // Last-resort fallback — render the source text inside a styled span so
      // the user at least sees what was supposed to be there. Mirrors
      // rehype-katex's own escape hatch.
      return `<span class="katex-error" style="color:${escapeHtml(errorColor)}" title="${escapeHtml(
        String(error)
      )}">${escapeHtml(value)}</span>`
    }
  }
}

/**
 * The actual rehype plugin. Wraps `rehype-katex`'s logic with our LRU
 * cache. Mirrors the upstream visitor exactly except for the cache lookup
 * and an LRU.set on miss.
 */
function createMemoizedRehypeKatex(options: KatexMemoOptions = {}): Pluggable {
  const errorColor = options.errorColor ?? 'var(--color-muted-foreground)'

  return () =>
    function transform(tree: Root, file: VFile): undefined {
      visitParents(tree, 'element', (element, parents) => {
        const classes = Array.isArray(element.properties?.className) ? (element.properties.className as string[]) : []

        // Match the same class set rehype-katex looks for. `language-math`
        // is the markdown ` ```math ` form, `math-inline` is what
        // remark-math emits for `$x$`, `math-display` for `$$x$$`.
        const languageMath = classes.includes('language-math')
        const mathDisplay = classes.includes('math-display')
        const mathInline = classes.includes('math-inline')

        if (!(languageMath || mathDisplay || mathInline)) {
          return
        }

        let displayMode = mathDisplay
        let scope: Element = element
        let parent: Parent | undefined = parents[parents.length - 1]

        // For ` ```math ` the scope walks up to the wrapping <pre> and
        // we treat it as display math. Same logic rehype-katex uses.
        if (languageMath && parent && parent.type === 'element' && (parent as Element).tagName === 'pre') {
          scope = parent as Element
          parent = parents[parents.length - 2]
          displayMode = true
        }

        // No parent means the math node is at the root — there's nothing
        // to splice into, so bail. This shouldn't happen for properly
        // nested markdown but is the same defensive guard rehype-katex has.
        if (!parent) {
          return
        }

        const value = toText(scope, { whitespace: 'pre' })
        const key = cacheKey(displayMode, value)
        let html = cache.get(key)

        if (html === undefined) {
          // Only the MISS is spanned — a hit is a Map lookup and spanning it
          // would bury the renders that cost something under thousands that
          // don't. The span count IS the miss count, which is the number that
          // says whether this cache is working: on a settled transcript it
          // should approach zero, and if it doesn't, equations are being
          // re-keyed rather than KaTeX getting slower.
          html = span('katex.render', () => renderMath(value, displayMode, errorColor, file, scope), {
            display: displayMode ? 'block' : 'inline'
          })
          cache.set(key, html)
        }

        const index = parent.children.indexOf(scope as Element)

        if (index === -1) {
          return
        }

        // ONE node, carrying the HTML as text. A fresh object each time (the
        // cached value is an immutable string, so nothing downstream can reach
        // back and poison the cache the way a shared hast subtree could — which
        // is why the old implementation had to structuredClone every render).
        //
        // `dataDisplay` becomes `data-display` on the rendered element; the
        // component and the stylesheet both key off it, since display math
        // needs block layout and inline math must stay in the text flow.
        parent.children.splice(index, 1, {
          type: 'element',
          tagName: KATEX_HTML_TAG,
          properties: { dataDisplay: displayMode ? 'true' : 'false' },
          children: [{ type: 'text', value: html }]
        })

        return SKIP
      })
    }
}

/**
 * Build a streamdown MathPlugin object that uses the memoized rehype-katex
 * wrapper. Drop-in for `@streamdown/math`'s `createMathPlugin`.
 */
export function createMemoizedMathPlugin(config: MathPluginConfig = {}) {
  const remarkPlugin: Pluggable = [remarkMath, { singleDollarTextMath: config.singleDollarTextMath ?? false }]

  const rehypePlugin = createMemoizedRehypeKatex({ errorColor: config.errorColor })

  return {
    name: 'katex' as const,
    type: 'math' as const,
    remarkPlugin,
    rehypePlugin,
    getStyles: () => 'katex/dist/katex.min.css'
  }
}
