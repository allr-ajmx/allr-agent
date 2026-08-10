import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'

import { Codicon } from '@/components/ui/codicon'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { findBarKeyAction, formatMatchLabel } from '@/lib/find-in-page'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import {
  $findInPage,
  closeFindBar,
  findNext,
  findPrevious,
  initFindInPageListener,
  setFindQuery
} from '@/store/find-in-page'

/**
 * Find-in-page overlay (⌘F).
 *
 * Drives WebKitGTK's own find controller through the Rust commands in
 * `src-tauri/src/find_in_page.rs`, so the user gets the engine's incremental
 * search — highlight, step, Escape to clear — over the rendered transcript and
 * editor panels rather than a DOM scan that cannot see virtualized rows.
 *
 * Accelerators, matching the platform convention: ⌘F opens (the
 * `view.findInPage` keybind), ⌘G / ⌘⇧G step from anywhere while the bar is open,
 * Enter / ⇧Enter step from the input, Escape closes and clears the highlight.
 *
 * Key routing lives in `lib/find-in-page.ts` as a pure matcher so the
 * accelerator set is testable without a DOM.
 */
export function FindBar() {
  const { t } = useI18n()
  const { active, matchCount, matchOrdinal, query } = useStore($findInPage)
  const inputRef = useRef<HTMLInputElement>(null)
  const [localQuery, setLocalQuery] = useState('')
  const { pathname } = useLocation()

  // Navigating away (opening another session, a settings page, …) closes the bar
  // and clears the highlight. The engine's find selection is per-webview, not
  // per-route: without this, highlights and a stale match counter from the
  // previous chat would survive onto the next view. Implemented as effect
  // cleanup so the first render never fires it, a pathname change tears down the
  // previous route's search, and unmount gets the same teardown. closeFindBar is
  // idempotent, so a closed bar never re-enters the engine.
  useEffect(() => {
    void pathname

    return () => closeFindBar()
  }, [pathname])

  useEffect(() => {
    if (active) {
      setLocalQuery('')
      // A frame's delay so the DOM paints the input before we focus it.
      const id = requestAnimationFrame(() => inputRef.current?.focus())

      return () => cancelAnimationFrame(id)
    }

    return undefined
  }, [active])

  // Match counts from the engine. Refcounted in the store, so a remount can't
  // stack listeners; deliberately mount-scoped and NOT tied to `active` —
  // results for an in-flight search must still land if the bar just closed.
  useEffect(() => initFindInPageListener(), [])

  // Debounced search: fire 200ms after the user stops typing. Cleanup covers
  // every exit — another keystroke, the bar closing, unmount — so nothing can
  // search after the bar is gone.
  useEffect(() => {
    if (!active || !localQuery) {
      return undefined
    }

    const id = setTimeout(() => setFindQuery(localQuery), 200)

    return () => clearTimeout(id)
  }, [active, localQuery])

  // Global accelerators while the bar is open: Escape closes, ⌘G / ⌘⇧G step.
  // Capture-phase so they win regardless of which element inside the shell owns
  // focus (composer textarea, side panel button, …). The keybind dispatcher
  // stands aside for these while the bar is open — see `findBarClaimsCombo`;
  // stopPropagation alone cannot do it, since both listeners sit on `window`.
  useEffect(() => {
    if (!active) {
      return undefined
    }

    const onKeyDown = (event: KeyboardEvent) => {
      const action = findBarKeyAction(event)

      if (!action) {
        return
      }

      event.preventDefault()
      event.stopPropagation()

      if (action === 'close') {
        closeFindBar()
      } else if (action === 'next') {
        findNext()
      } else {
        findPrevious()
      }
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })

    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [active])

  if (!active) {
    return null
  }

  const onInput = (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value
    setLocalQuery(value)

    // Empty query: clear the highlight immediately rather than after the debounce.
    if (!value) {
      setFindQuery('')
    }
  }

  // Enter / ⇧Enter step while focus is in the input. Escape and ⌘G are handled
  // by the window listener above, so they are intentionally not duplicated here
  // — `inInput` only unlocks the bare-Enter family.
  const onKeyDown = (event: React.KeyboardEvent) => {
    const action = findBarKeyAction(event, { inInput: true })

    if (action !== 'next' && action !== 'previous') {
      return
    }

    event.preventDefault()

    if (action === 'next') {
      findNext()
    } else {
      findPrevious()
    }
  }

  const label = t.findInPage.title
  const matchLabel = formatMatchLabel(query, matchOrdinal, matchCount)

  return (
    <div
      className={cn(
        'pointer-events-auto fixed right-4 top-[calc(var(--titlebar-height,0px)+0.5rem)] z-(--z-over-modal)',
        'flex items-center gap-1 rounded-lg border border-(--stroke-nous) bg-(--ui-chat-bubble-background) px-2 py-1 shadow-nous'
      )}
      role="search"
    >
      <input
        aria-label={label}
        className="h-6 w-40 bg-transparent text-xs text-foreground outline-none placeholder:text-(--ui-text-tertiary)"
        onChange={onInput}
        onKeyDown={onKeyDown}
        placeholder={label}
        ref={inputRef}
        type="text"
        value={localQuery}
      />

      {matchLabel && (
        <span
          aria-live="polite"
          className="min-w-12 text-center text-[0.6875rem] tabular-nums text-(--ui-text-tertiary)"
        >
          {matchLabel}
        </span>
      )}

      <Tip label={t.findInPage.previous}>
        <button
          aria-label={t.findInPage.previous}
          className="grid size-5 place-items-center rounded text-(--ui-text-secondary) hover:bg-(--ui-control-hover-background) hover:text-foreground"
          onClick={findPrevious}
          type="button"
        >
          <Codicon name="chevron-up" size="0.75rem" />
        </button>
      </Tip>

      <Tip label={t.findInPage.next}>
        <button
          aria-label={t.findInPage.next}
          className="grid size-5 place-items-center rounded text-(--ui-text-secondary) hover:bg-(--ui-control-hover-background) hover:text-foreground"
          onClick={findNext}
          type="button"
        >
          <Codicon name="chevron-down" size="0.75rem" />
        </button>
      </Tip>

      <button
        aria-label={t.common.close}
        className="grid size-5 place-items-center rounded text-(--ui-text-secondary) hover:bg-(--ui-control-hover-background) hover:text-foreground"
        onClick={closeFindBar}
        type="button"
      >
        <Codicon name="close" size="0.75rem" />
      </button>
    </div>
  )
}
