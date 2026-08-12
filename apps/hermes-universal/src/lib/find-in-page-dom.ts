/**
 * The portable half of find-in-page (MJXHRM-387).
 *
 * Linux drives WebKitGTK's own `WebKitFindController` from Rust — highlight-all,
 * engine-accurate counts, no JavaScript involved. Every other target reaches its
 * engine's find only through a native binding this Linux host cannot compile,
 * and on macOS/iOS that binding would buy nothing at all: `WKWebView`'s public
 * `findString:configuration:completionHandler:` answers a single
 * `WKFindResult.matchFound` boolean — the same answer `window.find` already
 * gives, minus a count. See `src-tauri/src/find_in_page.rs` for the per-platform
 * ledger.
 *
 * So the fallback is the one search primitive every engine already ships:
 * `window.find`. It is non-standard but implemented in both WebKit (macOS, iOS)
 * and Blink (Windows WebView2, Android WebView), it selects and scrolls the
 * match for us, and it costs no new Rust and no new crates.
 *
 * **Counting is separate from navigating, on purpose.** `window.find` reports
 * only "did I find one more", so counting with it means walking the whole
 * document and dragging the viewport along to every match before jumping back —
 * visible thrash on a long transcript. The count instead comes from a text scan,
 * which touches no selection and moves nothing.
 *
 * **The scan mirrors how an engine reads the page, not how the DOM is nested.**
 * An engine flattens each inline run into one string before matching, so
 * `<span>foo</span><span>.bar</span>` — every Shiki-highlighted code token, every
 * bold word inside a sentence — is one searchable run. A per-text-node scan
 * would count `foo.bar` as zero matches while `window.find` selected and scrolled
 * to it, and the bar would read `0/0` over a highlighted hit. Blocks and `<br>`
 * end a run, so text either side of a paragraph break never fuses into a match
 * that isn't there.
 *
 * What it still cannot see, on every platform including Linux:
 *   - transcript turns the render budget has UNMOUNTED (`thread/list.tsx` drops
 *     the head of a long conversation from the DOM entirely);
 *   - anything inside an `<iframe>` — artifact previews, URL/YouTube/Spotify
 *     embeds. `window.find` is called with `searchInFrames=false` because a
 *     cross-origin frame cannot be searched anyway and a same-origin one would
 *     move a viewport we do not own;
 *   - the terminal, which xterm paints to a WebGL canvas — there is no text
 *     there to find;
 *   - text drawn by a plugin into a shadow root.
 */

/** Counting stops here. A transcript can be enormous and "500+" answers the
 *  user's real question ("is it in here, roughly how often") just as well. */
export const DOM_FIND_MATCH_CAP = 500

/** Subtrees whose text is never what someone is searching for. */
const SKIPPED_TAGS = new Set(['NOSCRIPT', 'SCRIPT', 'STYLE', 'TEMPLATE', 'TITLE'])

/**
 * Tags that keep their text in the SAME run as the text beside them.
 *
 * A tag list rather than a `getComputedStyle().display` read: the scan runs on
 * every keystroke over the whole document, and a style read per element is a
 * forced style recalc per element — the exact cost `content-visibility` was
 * added to this transcript to avoid. The list covers what actually wraps text
 * here (Shiki token spans, markdown emphasis/links/code, KaTeX spans); a `span`
 * a stylesheet has made `display:block` would fuse two runs, which over-counts
 * by a hair rather than under-counting to zero.
 */
const INLINE_TAGS = new Set([
  'A',
  'ABBR',
  'B',
  'BDI',
  'BDO',
  'CITE',
  'CODE',
  'DATA',
  'DEL',
  'DFN',
  'EM',
  'FONT',
  'I',
  'INS',
  'KBD',
  'LABEL',
  'MARK',
  'Q',
  'RUBY',
  'S',
  'SAMP',
  'SMALL',
  'SPAN',
  'STRONG',
  'SUB',
  'SUP',
  'TIME',
  'TT',
  'U',
  'VAR',
  'WBR'
])

interface FindCapableWindow {
  find?: (
    query: string,
    caseSensitive?: boolean,
    backwards?: boolean,
    wrapAround?: boolean,
    wholeWord?: boolean,
    searchInFrames?: boolean,
    showDialog?: boolean
  ) => boolean
  getSelection?: () => Selection | null
}

function activeWindow(): FindCapableWindow | null {
  return typeof window === 'undefined' ? null : (window as unknown as FindCapableWindow)
}

/** Whether this engine can search the rendered page from JavaScript. */
export function domFindSupported(win: FindCapableWindow | null = activeWindow()): boolean {
  return typeof win?.find === 'function'
}

/**
 * True when the element's text is not rendered, so no find can ever land on it.
 *
 * Counting it would put a number next to the input that no amount of pressing
 * "next" can reach — the counter's worst failure, because it reads as "the app
 * found it and won't show me".
 *
 * Only the cheap, local signals are consulted (attributes and the inline style
 * map). Text hidden by a CLASS (`hidden md:flex`) is still counted; catching it
 * needs a computed-style read per element, and this runs per keystroke over the
 * whole document. In this app that residue is chrome — icon labels, responsive
 * duplicates of a button — not prose.
 */
function isUnrenderedElement(element: Element): boolean {
  if (SKIPPED_TAGS.has(element.tagName) || element.hasAttribute('hidden')) {
    return true
  }

  if (element.getAttribute('aria-hidden') === 'true') {
    return true
  }

  const inline = (element as Partial<HTMLElement>).style

  return inline?.display === 'none' || inline?.visibility === 'hidden'
}

/** A closed `<details>` renders its summary and nothing else. */
function closedDetails(element: Element): boolean {
  return element.tagName === 'DETAILS' && !(element as HTMLDetailsElement).open
}

interface ScanState {
  /** The inline run built so far, not yet matched against. */
  buffer: string
  count: number
}

/** Match what has accumulated, then start a new run. */
function flush(state: ScanState, needle: string, cap: number): void {
  const haystack = state.buffer.toLowerCase()

  state.buffer = ''

  // Overlapping matches are not counted twice ("aa" in "aaa" is one, then the
  // scan resumes past it) — the same thing an engine find does when you keep
  // pressing next.
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) {
    state.count += 1

    if (state.count >= cap) {
      return
    }
  }
}

function scanChildren(node: Node, needle: string, cap: number, state: ScanState): void {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (state.count >= cap) {
      return
    }

    if (child.nodeType === Node.TEXT_NODE) {
      state.buffer += child.nodeValue ?? ''

      continue
    }

    if (child.nodeType !== Node.ELEMENT_NODE) {
      continue
    }

    const element = child as Element

    // Unrendered text does not merely go uncounted — it BREAKS the run, or the
    // words either side of a hidden span would fuse into a phantom match.
    if (isUnrenderedElement(element)) {
      flush(state, needle, cap)

      continue
    }

    if (element.tagName === 'BR') {
      flush(state, needle, cap)

      continue
    }

    if (closedDetails(element)) {
      flush(state, needle, cap)

      for (let part = element.firstChild; part; part = part.nextSibling) {
        if (part.nodeType === Node.ELEMENT_NODE && (part as Element).tagName === 'SUMMARY') {
          scanChildren(part, needle, cap, state)
        }
      }

      flush(state, needle, cap)

      continue
    }

    if (INLINE_TAGS.has(element.tagName)) {
      scanChildren(element, needle, cap, state)

      continue
    }

    flush(state, needle, cap)
    scanChildren(element, needle, cap, state)
    flush(state, needle, cap)
  }
}

/**
 * Count case-insensitive occurrences of `query` in the rendered text.
 *
 * Text is matched per inline RUN, not per text node, so a query straddling
 * `<b>`/`<span>`/`<a>` boundaries counts — see the module header for why that is
 * the common case here rather than an edge one.
 */
export function countDomTextMatches(
  query: string,
  root: Node | null = typeof document === 'undefined' ? null : document.body,
  cap: number = DOM_FIND_MATCH_CAP
): number {
  const needle = query.toLowerCase()

  if (!root || !needle || typeof document === 'undefined') {
    return 0
  }

  const state: ScanState = { buffer: '', count: 0 }

  scanChildren(root, needle, cap, state)
  flush(state, needle, cap)

  return Math.min(state.count, cap)
}

interface DomFindOptions {
  backwards?: boolean
  /** Start from the top of the document instead of the current selection. */
  fromStart?: boolean
  win?: FindCapableWindow | null
}

/**
 * Select and scroll to a match. Returns whether one was found.
 *
 * `fromStart` clears the selection first, which is what makes a NEW query begin
 * at the top of the document rather than wherever the previous query left the
 * caret — otherwise typing a second search would silently skip everything above
 * the last hit.
 */
export function domFind(query: string, { backwards = false, fromStart = false, win }: DomFindOptions = {}): boolean {
  const target = win === undefined ? activeWindow() : win

  if (!query || typeof target?.find !== 'function') {
    return false
  }

  if (fromStart) {
    clearDomFindSelection(target)
  }

  // caseSensitive=false, wrapAround=true, wholeWord=false, searchInFrames=false,
  // showDialog=false — wrapping is what makes next/previous cycle rather than
  // dead-end at the last match.
  try {
    return target.find(query, false, backwards, true, false, false, false)
  } catch {
    // Some engines throw rather than return false on an unsupported call shape.
    return false
  }
}

/** Drop the highlight. A find bar that closes over a still-selected match has
 *  not really closed. */
export function clearDomFindSelection(win: FindCapableWindow | null = activeWindow()): void {
  try {
    win?.getSelection?.()?.removeAllRanges()
  } catch {
    /* selection unavailable — nothing to clear */
  }
}
