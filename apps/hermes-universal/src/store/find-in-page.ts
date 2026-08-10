import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import { stepOrdinal } from '@/lib/find-in-page'
import { PLATFORM } from '@/lib/platform'
import { atom } from '@/store/atom'

/**
 * Find-in-page state (MJXHRM-49).
 *
 * Desktop drives Electron's `webContents.findInPage`; universal invokes the Rust
 * commands in `src-tauri/src/find_in_page.rs`, which reach through to
 * WebKitGTK's own find controller. Same engine-level search, different door.
 *
 * The ordinal is OURS. WebKitGTK reports how many matches exist and never which
 * one is selected, so "3 of 12" is counted here as the user steps — see
 * `stepOrdinal`. The count always comes from the engine.
 */

/** Emitted by the Rust side with the match count for the current query. */
const FOUND_IN_PAGE_EVENT = 'hermes://found-in-page'

export interface FindInPageState {
  active: boolean
  query: string
  matchOrdinal: number
  matchCount: number
}

const EMPTY: FindInPageState = { active: false, matchCount: 0, matchOrdinal: 0, query: '' }

export const $findInPage = atom<FindInPageState>({ ...EMPTY })

/**
 * Whether this build can search the page at all.
 *
 * The engine handle behind `with_webview` is platform-specific, and only the
 * WebKitGTK one is implemented (see the Rust module's docs). Checked here rather
 * than letting the invoke fail, so ⌘F simply does nothing on a platform that
 * can't honour it instead of flashing a bar that reports zero matches for
 * everything.
 */
export function findInPageSupported(): boolean {
  return PLATFORM === 'linux'
}

function callFind(query: string, forward: boolean, findNext: boolean): void {
  void invoke('find_in_page', { findNext, forward, query }).catch(() => undefined)
}

function callStop(): void {
  void invoke('stop_find_in_page').catch(() => undefined)
}

export function openFindBar(): void {
  if (!findInPageSupported()) {
    return
  }

  $findInPage.set({ ...EMPTY, active: true })
}

export function closeFindBar(): void {
  // Already closed: don't re-issue the stop. Escape is a shared gesture (dialogs
  // and the session switcher claim it too), so a stray second close must not
  // reach into the engine again.
  if (!$findInPage.get().active) {
    return
  }

  $findInPage.set({ ...EMPTY })
  // Ends the search AND drops the highlight — a bar that closes over a still-
  // highlighted page has not really closed.
  callStop()
}

export function setFindQuery(query: string): void {
  const prev = $findInPage.get()

  // Never search for a closed bar. The component clears its debounce on close,
  // but a timer that already fired (or any late caller) must not re-issue a find
  // and re-highlight the page after the user pressed Escape.
  if (!prev.active) {
    return
  }

  if (!query) {
    $findInPage.set({ ...prev, matchCount: 0, matchOrdinal: 0, query: '' })
    callStop()

    return
  }

  // Ordinal 0 until the engine answers: a fresh query has selected nothing yet,
  // and carrying the previous query's position over would be a lie for a frame.
  $findInPage.set({ ...prev, matchOrdinal: 0, query })
  callFind(query, true, false)
}

function step(direction: 'backward' | 'forward'): void {
  const state = $findInPage.get()

  if (!state.active || !state.query) {
    return
  }

  $findInPage.set({ ...state, matchOrdinal: stepOrdinal(state.matchOrdinal, state.matchCount, direction) })
  callFind(state.query, direction === 'forward', true)
}

export function findNext(): void {
  step('forward')
}

export function findPrevious(): void {
  step('backward')
}

/**
 * Called when the engine reports a count for the current query.
 *
 * A count arriving for a query the user has already cleared is dropped: the
 * search is async, so a result for the previous keystroke can land after the
 * bar was emptied and would resurrect a stale counter.
 */
export function updateFindResults(count: number): void {
  const prev = $findInPage.get()

  if (!prev.active || !prev.query) {
    return
  }

  const matchCount = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0

  $findInPage.set({
    ...prev,
    matchCount,
    // First result for a fresh query: the engine has selected match one.
    matchOrdinal: matchCount === 0 ? 0 : prev.matchOrdinal || 1
  })
}

// The result subscription is process-wide, not per-mount: the find bar lives in
// the global overlay set and the shell remounts it on a connection re-home while
// route changes keep it alive. Refcount the single listener so a remount cannot
// stack duplicates — every stacked listener would re-dispatch the same result
// and, worse, outlive its component.
let listenerRefs = 0
let detachListener: (() => void) | undefined
let pendingDetach: Promise<UnlistenFn> | undefined

/**
 * Subscribe to match counts. Returns a release fn; the underlying listener is
 * installed on the first subscriber and removed when the last one releases. Safe
 * to call from an effect with a `[]` dep list.
 */
export function initFindInPageListener(): () => void {
  listenerRefs += 1

  if (listenerRefs === 1) {
    // `listen` resolves asynchronously, so a mount/unmount inside one tick would
    // otherwise leave the listener attached with the refcount already at zero.
    pendingDetach = listen<number>(FOUND_IN_PAGE_EVENT, event => updateFindResults(event.payload))

    void pendingDetach
      .then(stop => {
        if (listenerRefs > 0) {
          detachListener = stop
        } else {
          stop()
        }
      })
      .catch(() => undefined)
  }

  let released = false

  return () => {
    // Guard double-release: React can invoke a cleanup once, but a caller
    // holding the fn shouldn't be able to drive the refcount negative.
    if (released) {
      return
    }

    released = true
    listenerRefs -= 1

    if (listenerRefs === 0) {
      detachListener?.()
      detachListener = undefined
      pendingDetach = undefined
    }
  }
}

/** Test seam: number of live subscriptions (0 or 1 in practice). */
export function findInPageListenerCount(): number {
  return listenerRefs
}
