/**
 * The portable half of find-in-page (MJXHRM-387).
 *
 * Linux drives WebKitGTK's own `WebKitFindController` from Rust — highlight-all,
 * engine-accurate counts, no JavaScript involved. Every other target has no such
 * door: `WKWebView` exposes no public find API at all, `ICoreWebView2::Find`
 * needs a recent runtime plus a direct `webview2-com` dependency, and Android's
 * `WebView.findAllAsync` needs JNI. Three native bindings that could not even be
 * COMPILED on the Linux host this is developed on, let alone tested, is not a
 * trade worth making for a search box.
 *
 * So the fallback is the one search primitive every engine already ships:
 * `window.find`. It is non-standard but implemented in both WebKit (macOS) and
 * Blink (Windows WebView2, Android WebView), it selects and scrolls the match
 * for us, and it costs no new Rust and no new crates.
 *
 * **Counting is separate from navigating, on purpose.** `window.find` reports
 * only "did I find one more", so counting with it means walking the whole
 * document and dragging the viewport along to every match before jumping back —
 * visible thrash on a long transcript. The count instead comes from a text-node
 * scan, which touches no selection and moves nothing.
 *
 * Two honest limits of that scan, both documented rather than papered over:
 *   - a match SPLIT ACROSS ELEMENTS ("<b>He</b>llo") is not counted, though
 *     `window.find` will happily land on it, so the count can read low;
 *   - like the engine's own find, virtualized rows that aren't mounted are not
 *     searched — the same blind spot the Linux path has.
 */

/** Counting stops here. A transcript can be enormous and "500+" answers the
 *  user's real question ("is it in here, roughly how often") just as well. */
export const DOM_FIND_MATCH_CAP = 500

/** Subtrees whose text is never what someone is searching for. */
const SKIPPED_TAGS = new Set(['NOSCRIPT', 'SCRIPT', 'STYLE', 'TEMPLATE', 'TITLE'])

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

/** True when the element (or an ancestor) is deliberately not being shown. */
function isHiddenElement(element: Element): boolean {
  return element.hasAttribute('hidden') || element.getAttribute('aria-hidden') === 'true'
}

/**
 * Count case-insensitive occurrences of `query` in the rendered text.
 *
 * Overlapping matches are not counted twice ("aa" in "aaa" is one, then the scan
 * resumes past it) — the same thing an engine find does when you keep pressing
 * next.
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

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: node => {
      const parent = node.parentElement

      if (!parent || SKIPPED_TAGS.has(parent.tagName)) {
        return NodeFilter.FILTER_REJECT
      }

      return isHiddenElement(parent) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
    }
  })

  let total = 0

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const haystack = (node.nodeValue ?? '').toLowerCase()

    for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) {
      total += 1

      if (total >= cap) {
        return cap
      }
    }
  }

  return total
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
