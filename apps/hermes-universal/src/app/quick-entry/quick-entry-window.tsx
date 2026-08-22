import { useEffect, useLayoutEffect, useReducer, useRef } from 'react'

import { useI18n } from '@/i18n'
import { IS_TAURI } from '@/lib/platform'
import { cn } from '@/lib/utils'
import {
  initialQuickComposerState,
  QUICK_TARGET_CURRENT,
  QUICK_TARGET_NEW,
  type QuickComposerEvent,
  quickComposerReducer,
  type QuickComposerState,
  type QuickEntrySessionOption
} from '@/store/quick-entry'

import { emitQuickEntryHello, emitQuickEntrySubmit, onQuickEntryState } from './channel'
import { closeQuickEntry } from './quick-entry'

/**
 * A transparent window needs a transparent document, and the app's stylesheet
 * paints `body` with the chat surface colour.
 *
 * Injected from this module rather than added to `styles.css` next to the HUD's
 * `html[data-hud]` block: those rules exist because the HUD restyles the REAL
 * chat screen from the outside, and there are a dozen of them. This surface owns
 * every pixel it draws, so its one rule travels with it — and the app-wide
 * stylesheet is the file every parallel stream is editing.
 *
 * `useLayoutEffect` so it lands before the first paint rather than one frame of
 * opaque background into the window's life.
 */
function useTransparentSurface(): void {
  useLayoutEffect(() => {
    const style = document.createElement('style')

    style.textContent = 'html,body,#root{background:transparent !important;}'
    document.head.appendChild(style)

    return () => style.remove()
  }, [])
}

/** One target the prompt can be aimed at. */
function TargetChip({ active, label, onSelect }: { active: boolean; label: string; onSelect: () => void }) {
  return (
    <button
      aria-pressed={active}
      className={cn(
        'max-w-40 shrink-0 truncate rounded-full border px-2.5 py-1 text-[11px] transition-colors',
        active
          ? 'border-(--ui-stroke-secondary) bg-(--ui-bg-tertiary) text-(--ui-text-primary)'
          : 'border-transparent text-(--ui-text-tertiary) hover:bg-(--ui-bg-secondary) hover:text-(--ui-text-secondary)'
      )}
      onClick={onSelect}
      type="button"
    >
      {label}
    </button>
  )
}

/**
 * The Quick Entry composer — the whole surface of the global-chord mini window.
 *
 * Deliberately one input plus a target picker and nothing else: this is a
 * capture surface, not a second chat. Where the HUD mounts the REAL `ChatScreen`
 * because it IS the conversation, this window must not — it has no gateway
 * connection, so a composer wired to one would be a composer that cannot send.
 *
 * All behaviour rides `quickComposerReducer` (pure, unit-tested): submit hands
 * the trimmed text plus target to the primary window and asks to dismiss; an
 * empty submit does neither, so a stray Enter cannot make the window vanish;
 * Escape and losing the window's focus dismiss without sending; a gateway the
 * primary window reports as down disables the input entirely.
 */
function QuickEntrySurface() {
  const { t } = useI18n()
  const copy = t.quickEntry
  const inputRef = useRef<HTMLInputElement>(null)

  // The reducer returns { send, state }; this wrapper performs the side effects
  // — hand the payload to the primary window, close this one — so the decision
  // stays pure and testable while the effects stay in exactly one place.
  const [state, dispatch] = useReducer((current: QuickComposerState, event: QuickComposerEvent) => {
    const { send, state: next } = quickComposerReducer(current, event)

    if (send) {
      void emitQuickEntrySubmit(send)
      void closeQuickEntry()
    } else if (!next.visible && current.visible) {
      void closeQuickEntry()
    }

    return next
  }, initialQuickComposerState)

  useTransparentSurface()

  // Say hello and adopt the reply. This window has no gateway of its own, so
  // the push is its only view of backend truth — until it lands the input is
  // disabled and says why.
  useEffect(() => {
    let disposed = false
    let off: (() => void) | null = null

    void onQuickEntryState(payload => {
      const push = payload as null | { connected?: unknown; sessions?: unknown }

      dispatch({
        connected: push?.connected === true,
        sessions: Array.isArray(push?.sessions) ? (push.sessions as QuickEntrySessionOption[]) : [],
        type: 'state'
      })
    }).then(unlisten => {
      if (disposed) {
        unlisten()

        return
      }

      off = unlisten
      // Only ask once we are listening, or the answer can arrive first.
      void emitQuickEntryHello()
    })

    inputRef.current?.focus()

    return () => {
      disposed = true
      off?.()
    }
  }, [])

  // Focus loss dismisses — that is the whole contract of a capture surface — but
  // ONLY once this window has actually held focus. A compositor that reports a
  // spurious unfocus while the window is still being mapped would otherwise
  // dismiss it before the user could type a character, and a Quick Entry that
  // vanishes on summon is indistinguishable from one that never opened.
  useEffect(() => {
    if (!IS_TAURI) {
      return undefined
    }

    let armed = false
    let disposed = false
    let off: (() => void) | null = null

    void (async () => {
      try {
        const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow')

        const unlisten = await getCurrentWebviewWindow().onFocusChanged(({ payload: focused }) => {
          if (focused) {
            armed = true
            // A re-summon reuses an open window (`openSatelliteWindow` focuses
            // rather than rebuilding), and re-summoning must give a FRESH
            // capture surface — never yesterday's half-typed draft.
            dispatch({ type: 'shown' })
            requestAnimationFrame(() => inputRef.current?.focus())

            return
          }

          if (armed) {
            dispatch({ type: 'blur' })
          }
        })

        if (disposed) {
          unlisten()

          return
        }

        off = unlisten
      } catch {
        // No window system here — Escape is still the way out.
      }
    })()

    return () => {
      disposed = true
      off?.()
    }
  }, [])

  // Escape on the window rather than on the input: it must work whether or not
  // the caret is in the field, and the picker chips are focusable too.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault()
        dispatch({ type: 'dismiss' })
      }
    }

    window.addEventListener('keydown', onKey)

    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="flex h-dvh w-full items-center justify-center bg-transparent p-3">
      <div className="flex w-full flex-col gap-2 rounded-xl border border-(--ui-stroke-tertiary) bg-(--ui-chat-surface-background) px-3.5 py-2.5 shadow-2xl">
        <div className="flex items-center gap-2.5">
          <span aria-hidden className="shrink-0 select-none text-[15px] leading-none text-(--ui-text-quaternary)">
            ›
          </span>
          <input
            aria-label={copy.label}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            className="min-w-0 flex-1 border-none bg-transparent text-[15px] text-(--ui-text-primary) outline-none placeholder:text-(--ui-text-quaternary) disabled:opacity-55"
            disabled={!state.connected}
            onChange={event => dispatch({ draft: event.target.value, type: 'edit' })}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                dispatch({ type: 'submit' })
              }
            }}
            placeholder={state.connected ? copy.placeholder : copy.notConnected}
            ref={inputRef}
            spellCheck={false}
            value={state.draft}
          />
        </div>
        {/* Chips rather than a `<select>`: a native dropdown takes the window's
            focus to open its popup, and this window dismisses on focus loss —
            the picker would close the surface it belongs to. */}
        <div aria-label={copy.targetLabel} className="flex items-center gap-1.5" role="group">
          <span className="shrink-0 select-none text-[11px] text-(--ui-text-quaternary)">{copy.sendTo}</span>
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <TargetChip
              active={state.target === QUICK_TARGET_CURRENT}
              label={copy.currentChat}
              onSelect={() => dispatch({ target: QUICK_TARGET_CURRENT, type: 'target' })}
            />
            <TargetChip
              active={state.target === QUICK_TARGET_NEW}
              label={copy.newSession}
              onSelect={() => dispatch({ target: QUICK_TARGET_NEW, type: 'target' })}
            />
            {state.sessions.map(session => (
              <TargetChip
                active={state.target === session.id}
                key={session.id}
                label={session.title}
                onSelect={() => dispatch({ target: session.id, type: 'target' })}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

/** Root for the quick window, mounted by `app.tsx` on `?win=quick`. */
export function QuickEntryWindowRoot() {
  return <QuickEntrySurface />
}
