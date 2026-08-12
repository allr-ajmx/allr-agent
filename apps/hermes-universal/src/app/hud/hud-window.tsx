// Side-effect import: the contribution controller registers every core tile at
// module scope. Explicit rather than inherited from `app.tsx`'s graph, for the
// same reason `tile-window.tsx` imports it — this window must keep working even
// if nobody else ever pulls it in.
import '@/app/contrib/controller'

import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'

import { ChatScreen } from '@/app/chat/chat-screen'
import { routeSessionId } from '@/app/routes'
import { SidebarProvider } from '@/app/shell/sidebar'
import { NotificationStack } from '@/components/notifications'
import { Codicon } from '@/components/ui/codicon'
import { useI18n } from '@/i18n'
import { chatMessageText } from '@/lib/chat-messages'
import { useStore } from '@/store/atom'
import { $busy, $messages } from '@/store/chat'
import { $connectionPhase } from '@/store/connection'
import { openSession, refreshSessions } from '@/store/session'

import { reportHudSession } from './handoff'
import { closeHud } from './hud'
import { useHudGrant, useHudInteractiveRect, useTransparentDocument } from './use-hud-surface'

/** How long the band stays open after the last thing the agent said. Long enough
 *  to finish a sentence you glanced at; short enough that it is gone before you
 *  wonder why it is still there. */
const RECENT_HOLD_MS = 1100

/** The band never takes more than this much of the screen — it is a glance at
 *  the tail of a conversation, not a window onto it. */
const BAND_MAX_PX = 168
const BAND_MAX_FRACTION = 0.42

/**
 * True for a moment after the conversation last changed.
 *
 * Keyed on a cheap signature rather than on the message array: the chat store
 * republishes on plenty of edits that do not change what is on screen, and
 * re-arming the hold for each of those would leave the band permanently open.
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

  // A running turn holds the band open on its own: text is still arriving, and
  // fading out between tokens would be the worst of both.
  return recent || busy
}

/**
 * The Spotlight bar with a fading chat band.
 *
 * The composer is the REAL composer — `ChatScreen` verbatim, the same one the
 * main window renders, with its slash commands, attachments, queue and voice.
 * Nothing here swaps in a lighter version; the layout below repositions it and
 * the stylesheet's `[data-hud]` rules restyle it. A second composer would be a
 * second set of bugs.
 */
function HudSurface() {
  const { t } = useI18n()
  const { pathname } = useLocation()
  const phase = useStore($connectionPhase)
  const grant = useHudGrant()
  const cardRef = useRef<HTMLDivElement | null>(null)
  const engaged = useRecentActivity()
  const targetId = routeSessionId(pathname)
  const resumedRef = useRef<null | string>(null)

  // An output-sized surface covers the whole screen, so the card is the only
  // part that may take input; a card-sized window is interactive by definition.
  const outputSized = grant?.outputSized ?? false

  useTransparentDocument(true)
  useHudInteractiveRect(cardRef, outputSized)

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

      if (resumedRef.current === targetId) {
        await openSession(targetId)
      }
    })()
  }, [phase, targetId])

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

  return (
    <SidebarProvider>
      <div
        className={
          outputSized
            ? 'pointer-events-none flex h-full w-full justify-center bg-transparent'
            : 'flex h-full w-full flex-col bg-transparent'
        }
        data-hud-engaged={engaged ? '' : undefined}
        data-hud-root
      >
        <div
          className={
            outputSized
              ? 'group/hud pointer-events-auto relative flex max-h-full w-[35rem] max-w-full flex-col overflow-hidden rounded-xl border border-(--ui-stroke-tertiary) bg-(--ui-chat-surface-background) shadow-2xl'
              : 'group/hud relative flex h-full min-h-0 w-full flex-col overflow-hidden'
          }
          data-hud-card
          ref={cardRef}
          style={
            {
              '--hud-band-max': `${Math.min(window.innerHeight * BAND_MAX_FRACTION, BAND_MAX_PX)}px`
            } as React.CSSProperties
          }
        >
          {/* The way back. Escape works and the summoning chord toggles, but
              both are invisible, and a surface with no visible exit is a surface
              people close by killing the app. `coarse:opacity-100` for the same
              reason one step further: hover never resolves on a touch screen,
              and neither of the two invisible routes is a KEY a finger can
              press — so without it this was an exit that only a keyboard could
              find. */}
          <button
            aria-label={t.titlebar.exitHud}
            className="absolute right-1.5 top-1.5 z-10 grid size-5 place-items-center rounded text-(--ui-text-quaternary) opacity-0 transition-opacity hover:bg-(--ui-fill-secondary) hover:text-(--ui-text-primary) coarse:opacity-100 focus-visible:opacity-100 group-hover/hud:opacity-100"
            data-hud-exit
            onClick={() => void closeHud()}
            type="button"
          >
            <Codicon name="chrome-close" />
          </button>
          {phase === 'ready' ? (
            <ChatScreen />
          ) : (
            <div className="grid h-24 place-items-center px-6 text-center text-xs text-(--ui-text-quaternary)">
              {t.zones.detachedMissing}
            </div>
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
