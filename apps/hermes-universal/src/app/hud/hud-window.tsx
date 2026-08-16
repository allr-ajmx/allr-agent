// Side-effect import: the contribution controller registers every core tile at
// module scope. Explicit rather than inherited from `app.tsx`'s graph, for the
// same reason `tile-window.tsx` imports it — this window must keep working even
// if nobody else ever pulls it in.
import '@/app/contrib/controller'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'

import { ChatScreen } from '@/app/chat/chat-screen'
import { routeSessionId, sessionRoute } from '@/app/routes'
import { SidebarProvider } from '@/app/shell/sidebar'
import { NotificationStack } from '@/components/notifications'
import { Codicon } from '@/components/ui/codicon'
import { GlyphSpinner } from '@/components/ui/glyph-spinner'
import { useI18n } from '@/i18n'
import { chatMessageText } from '@/lib/chat-messages'
import { ChevronDown, ChevronUp } from '@/lib/icons'
import { navigateTo } from '@/lib/route-nav'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import { $busy, $messages } from '@/store/chat'
import { $attachmentMenuDropdownOpen } from '@/store/composer'
import { $connectionError, $connectionPhase } from '@/store/connection'
import { $modelMenuDropdownOpen } from '@/store/model'
import { $activeStoredSessionId, openSession, refreshSessions } from '@/store/session'
import { showAppWindow } from '@/store/windows'

import { reportHudSession } from './handoff'
import { closeHud } from './hud'
import { hudBandMax } from './hud-size'
import { useHudDrag } from './use-hud-drag'
import { useHudCardMetrics, useHudGrant, useTransparentDocument } from './use-hud-surface'

/** How long the panel stays fully legible after the last thing the agent said.
 *  Long enough to finish a sentence you glanced at; short enough that it has
 *  faded back before you wonder why it is still bright. */
const RECENT_HOLD_MS = 1100

/** Shared by the exit button and the collapse chevron. Hidden until the pointer
 *  is over the card — and `coarse:opacity-100` because hover never resolves on a
 *  touch screen, so without it these are controls only a mouse can find. */
const HUD_CONTROL_CLASS =
  'grid size-5 place-items-center rounded text-(--ui-text-quaternary) opacity-0 transition-opacity hover:bg-(--ui-control-hover-background) hover:text-(--ui-text-primary) coarse:opacity-100 focus-visible:opacity-100 group-hover/hud:opacity-100'

/**
 * True for a moment after the conversation last changed.
 *
 * Keyed on a cheap signature rather than on the message array: the chat store
 * republishes on plenty of edits that do not change what is on screen, and
 * re-arming the hold for each of those would leave the panel permanently bright.
 */
function useRecentActivity(): boolean {
  const messages = useStore($messages)
  const busy = useStore($busy)
  const [recent, setRecent] = useState(false)

  const last = messages.at(-1)
  const signature = `${messages.length}:${last?.id ?? ''}:${last ? chatMessageText(last).length : 0}`

  useEffect(() => {
    setRecent(true)

    const timer = window.setTimeout(() => setRecent(false), RECENT_HOLD_MS)

    return () => window.clearTimeout(timer)
  }, [signature])

  // A running turn holds the panel legible on its own: text is still arriving,
  // and fading out between tokens would be the worst of both.
  return recent || busy
}

/**
 * The bar's shape while there is no gateway to talk to.
 *
 * The HUD used to render `t.zones.detachedMissing` here — "This tile is not
 * available in this window." The HUD is not a tile and it is not missing; it is
 * connecting, and it says so inside the same rounded bar the composer occupies a
 * moment later, so the surface's SHAPE does not change under the user while it
 * resolves. A window that is a bar, then a sentence, then a bar again reads as
 * three different things.
 */
function HudPlaceholderBar({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex w-full items-center gap-2 rounded-full border border-(--ui-stroke-tertiary) bg-(--ui-chat-surface-background) px-4 py-3 text-xs text-(--ui-text-tertiary)">
      {children}
    </div>
  )
}

/**
 * The Spotlight bar, and the response panel it grows downward into.
 *
 * The composer is the REAL composer — `ChatScreen` verbatim, the same one the
 * main window renders, with its slash commands, attachments, queue and voice.
 * Nothing here swaps in a lighter version; the `html[data-hud]` rules in
 * `styles.css` take the composer out of its dock and make it the first row in
 * flow, and put the transcript in a card underneath it. A second composer would
 * be a second set of bugs.
 */
function HudSurface() {
  const { t } = useI18n()
  const { pathname } = useLocation()
  const phase = useStore($connectionPhase)
  const error = useStore($connectionError)
  const messages = useStore($messages)
  const grant = useHudGrant()
  const cardRef = useRef<HTMLDivElement | null>(null)
  const engaged = useRecentActivity()
  const resumedRef = useRef<null | string>(null)

  // An output-sized surface covers the whole screen, so the card is the only
  // part that may take input; a card-sized window is interactive by definition.
  const outputSized = grant?.outputSized ?? false

  // When summoned on root (`#/`), HUD always starts a fresh new session rather
  // than resuming the main app's last opened conversation.
  const routeId = routeSessionId(pathname)
  const targetId = routeId

  const pathnameRef = useRef(pathname)
  pathnameRef.current = pathname

  // The panel is open when there is a conversation to show and the user has not
  // put it away. That is also, exactly, "collapsed for a new session and tail
  // visible for a resumed one": a new chat has no messages.
  const [collapsedByUser, setCollapsedByUser] = useState(false)
  const open = messages.length > 0 && !collapsedByUser

  const bandMaxPx = useMemo(() => hudBandMax(window.screen?.availHeight || window.innerHeight), [])
  const modelMenuOpen = useStore($modelMenuDropdownOpen)
  const attachmentMenuOpen = useStore($attachmentMenuDropdownOpen)

  useTransparentDocument(true)
  useHudCardMetrics(cardRef, { attachmentMenuOpen, bandMaxPx, modelMenuOpen, open, outputSized })

  // Resume the conversation this window was summoned onto. Same shape as the
  // tile window's: the session list has to land before the title resolves, and a
  // resume needs a live connection or it latches on a dead poll.
  useEffect(() => {
    if (phase !== 'ready' || !targetId || resumedRef.current === targetId) {
      return
    }

    resumedRef.current = targetId

    void (async () => {
      await refreshSessions().catch(() => {})

      if (resumedRef.current !== targetId) {
        return
      }

      try {
        await openSession(targetId)
      } catch {
        // The remembered conversation has been deleted since it was recorded, or
        // the gateway is mid-restart. The blank new chat already on screen is
        // the right fallback for the first — not an error, and not a spinner
        // that never resolves — and releasing the latch is what lets the second
        // resolve on its own when the connection comes back, rather than sitting
        // on an empty chat with a perfectly good conversation one reconnect
        // away.
        resumedRef.current = null

        return
      }

      // Put a remembered resume in the route, so the rest of this window — the
      // report to the summoner most of all — sees a session at all.
      if (!routeSessionId(pathnameRef.current)) {
        navigateTo(sessionRoute(targetId))
      }
    })()
  }, [phase, targetId])

  // A draft that became a real session. Without this, a HUD summoned onto a
  // blank chat never navigates, so `targetId` stays null, `takeReportedHudSession`
  // answers null, and the re-home falls back to `$activeStoredSessionId` IN THE
  // MAIN WINDOW — a different conversation. The one the user just had here would
  // be orphaned.
  useEffect(
    () =>
      $activeStoredSessionId.subscribe(id => {
        if (!id || routeSessionId(pathnameRef.current)) {
          return
        }

        // Set FIRST, and load-bearing: without it the resume effect above sees a
        // new `targetId` with no latch and issues a redundant `refreshSessions()`
        // + `openSession()` against a slice that is already warm.
        resumedRef.current = id
        navigateTo(sessionRoute(id))
      }),
    []
  )

  // Tell the window that summoned us which conversation we ended up on, so it
  // can take the gateway stream back when we go away (MJXHRM-371).
  //
  // Written on every change rather than on teardown: this window is destroyed by
  // the compositor, and the value has to be on disk while it is still alive.
  // Deliberately NOT cleared on unmount, for the same reason — the main window
  // consumes and clears it, and a HUD racing its own destruction to erase it is
  // how the handoff would quietly fall back to a stale session.
  useEffect(() => {
    if (targetId) {
      reportHudSession(targetId)
    }
  }, [targetId])

  // Escape is the exit that costs nothing to learn. It is deliberately handled
  // here on the window rather than on the card: with exclusive keyboard focus
  // the key arrives whether or not anything inside is focused.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        void closeHud()
      }
    }

    window.addEventListener('keydown', onKey)

    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const { commandHeld, onPointerDown: onHudPointerDown } = useHudDrag()

  return (
    <SidebarProvider>
      <div
        className={cn(
          outputSized
            ? 'pointer-events-auto flex h-full w-full justify-center bg-transparent'
            : 'flex h-full w-full flex-col bg-transparent',
          commandHeld && 'cursor-grab active:cursor-grabbing select-none'
        )}
        data-command-held={commandHeld ? '' : undefined}
        data-hud-engaged={engaged ? '' : undefined}
        data-hud-root
        onPointerDown={onHudPointerDown}
      >
        <div
          className={
            outputSized
              ? 'group/hud pointer-events-auto relative flex max-h-full w-[37.5rem] max-w-full flex-col bg-transparent'
              : 'group/hud relative flex h-full min-h-0 w-full flex-col bg-transparent'
          }
          data-hud-band-state={open ? 'open' : 'collapsed'}
          data-hud-card
          ref={cardRef}
          style={{ '--hud-band-max': `${bandMaxPx}px` } as React.CSSProperties}
        >
          <div className="absolute end-1.5 top-1.5 z-10 flex items-center gap-0.5">
            {/* Collapse back to input-only. It does NOT dismiss and does not
                promote to the main window — and it KEEPS the panel closed,
                because a control the next token re-opens is a control that does
                not work. */}
            {messages.length > 0 && (
              <button
                aria-label={open ? t.hud.collapseReply : t.hud.expandReply}
                className={HUD_CONTROL_CLASS}
                data-hud-collapse
                onClick={() => setCollapsedByUser(was => !was)}
                type="button"
              >
                {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              </button>
            )}
            {/* The way back. Escape works and the summoning chord toggles, but
                both are invisible, and a surface with no visible exit is a
                surface people close by killing the app. */}
            <button
              aria-label={t.titlebar.exitHud}
              className={HUD_CONTROL_CLASS}
              data-hud-exit
              onClick={() => void closeHud()}
              type="button"
            >
              <Codicon name="chrome-close" />
            </button>
          </div>
          {phase === 'ready' ? (
            <ChatScreen />
          ) : phase === 'error' ? (
            <HudPlaceholderBar>
              <span className="min-w-0 flex-1 truncate">{error || t.hud.connectionFailed}</span>
              {/* Fixing a gateway is main-window work, and in background mode
                  this bar may be the only Hermes on screen. */}
              <button
                className="shrink-0 rounded px-2 py-1 text-(--ui-text-secondary) hover:bg-(--ui-control-hover-background) hover:text-(--ui-text-primary)"
                onClick={() => void showAppWindow()}
                type="button"
              >
                {t.tray.show}
              </button>
            </HudPlaceholderBar>
          ) : (
            <HudPlaceholderBar>
              <GlyphSpinner />
              <span>{t.hud.connecting}</span>
            </HudPlaceholderBar>
          )}
        </div>
      </div>
      <NotificationStack />
    </SidebarProvider>
  )
}

/** Root for the HUD's window, mounted by `app.tsx` on `?win=hud`. */
export function HudWindowRoot() {
  return <HudSurface />
}
