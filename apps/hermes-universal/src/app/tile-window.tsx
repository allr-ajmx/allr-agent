// Side-effect import: the contribution controller registers every core tile at
// module scope, which is all this window needs from it (see TileHost).
import '@/app/contrib/controller'

import { useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

import { ChatScreen } from '@/app/chat/chat-screen'
import { ChatTitle } from '@/app/chat/chat-title'
import { SidebarProvider } from '@/app/shell/sidebar'
import { WindowControls } from '@/app/shell/window-controls'
import { NotificationStack } from '@/components/notifications'
import { useTileMap } from '@/components/pane-shell/tile/registry'
import { ContribBoundary } from '@/contrib/react/boundary'
import { useI18n } from '@/i18n'
import { isChatPaneId } from '@/lib/pane-ids'
import { useStore } from '@/store/atom'
import { $connectionPhase } from '@/store/connection'
import { sessionMissingFromCurrentGateway } from '@/store/gateway-soft-switch'
import { $gatewaySwitching } from '@/store/gateway-switch'
import { notify } from '@/store/notifications'
import { newSession, openSession, refreshSessions } from '@/store/session'
import { detachedTileId } from '@/store/windows'

import { NEW_CHAT_ROUTE, routeSessionId } from './routes'

// The CHAT host. A window whose tile is a chat surface (`workspace` or
// `session-tile:<id>`) renders a SINGLE chat with its own frameless titlebar — no
// sidebar, tiles, overlays, pet or statusbar (all of which live in
// MobileController, which we bypass at `app.tsx`). The target session id rides in
// the HashRouter route (`#/<id>`); once this window's own connection is live we
// load the session list (so the header title resolves — the sidebar that usually
// fetches it isn't mounted here) and resume the target into the global chat store,
// which ChatScreen renders. The in-chat ChatHeader stands down in a satellite
// window (see chat-header.tsx), so the title lives in this titlebar instead.
//
// MJX-104 shipped this as `SecondaryWindowRoot`. MJXHRM-173 made the window
// generic; the body below is unchanged, because its edge cases (the re-home
// re-resume, the "this session isn't on the gateway we moved to" fallback) were
// paid for once already.
function ChatTileHost() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const { t } = useI18n()
  const phase = useStore($connectionPhase)
  // This window re-homes when another WebView switches gateway (store/gateway-switch-sync).
  // Hold the chat across that window rather than blanking to an empty pane for the
  // second the socket is down — the same tolerance the other two roots carry.
  const switching = useStore($gatewaySwitching)
  const targetId = routeSessionId(pathname)
  const resumedRef = useRef<null | string>(null)
  // Set for the resume that follows a re-home, so the "it isn't here" path can say
  // WHY (the gateway moved) instead of reporting a generic open failure.
  const reHomedRef = useRef(false)

  // A re-home means the resume we already did was against the OLD gateway, so drop
  // the latch and let the effect below resume this session against the new one.
  useEffect(() => {
    if (switching) {
      resumedRef.current = null
      reHomedRef.current = true
    }
  }, [switching])

  useEffect(() => {
    // `switching` is a dependency, not just a guard: clearing resumedRef above is a
    // ref write, which re-triggers nothing on its own. Without it here, the re-resume
    // would depend on `phase` happening to move — true today, but only incidentally.
    //
    // Resume needs a live connection; wait for `ready` so the transcript loads
    // instead of latching on a dead poll (desktop's stuck-loading failure mode), and
    // sit out the switch itself rather than resuming against a socket being replaced.
    if (switching || phase !== 'ready' || !targetId || resumedRef.current === targetId) {
      return
    }

    resumedRef.current = targetId
    const afterReHome = reHomedRef.current
    reHomedRef.current = false

    void (async () => {
      // Await the list: the existence check below is only meaningful once the NEW
      // gateway's sessions have landed.
      await refreshSessions().catch(() => {})

      // A newer target superseded this resume while the list was in flight.
      if (resumedRef.current !== targetId) {
        return
      }

      // Sessions are per-backend, so the chat this window was pinned to usually does
      // NOT exist on the gateway we just moved to. Drop to a fresh session and say so,
      // rather than resuming into a dead id and surfacing "failed to open session".
      if (afterReHome && sessionMissingFromCurrentGateway(targetId)) {
        newSession()
        notify({
          kind: 'warning',
          title: t.settings.gateway.sessionMissingTitle,
          message: t.settings.gateway.sessionMissingMessage
        })
        // Leave the dead id behind, or the next render resumes it all over again.
        navigate(NEW_CHAT_ROUTE, { replace: true })

        return
      }

      await openSession(targetId)
    })()
  }, [navigate, phase, switching, t, targetId])

  return (
    <SidebarProvider>
      <div className="relative flex h-full min-h-0 flex-col">
        <div
          className="flex h-(--titlebar-height) shrink-0 items-center gap-1 border-b border-(--ui-stroke-tertiary) pl-2 pr-1"
          data-tauri-drag-region
        >
          <div className="min-w-0 flex-1 overflow-hidden">
            <ChatTitle />
          </div>
          <WindowControls />
        </div>
        {/* ChatScreen (`.chat`) is `flex:1 1 auto`, so it must be a DIRECT child of
            this flex-col — no wrapper, or its height collapses to content. */}
        {phase === 'ready' || switching ? <ChatScreen /> : <div className="flex-1" />}
      </div>
      <NotificationStack />
    </SidebarProvider>
  )
}

/**
 * The GENERIC host: one registered tile, rendered on its own.
 *
 * The tile set is available here because the contribution controller registers
 * at MODULE scope — importing it is enough, no shell required. That import is
 * explicit rather than inherited from `app.tsx`'s graph: without it this window
 * would keep working only for as long as nobody lazy-loads MobileController.
 *
 * `useTileMap`, not a one-shot `findTile`: a tile whose owner registers late (a
 * runtime plugin, a terminal waiting on its PTY) resolves when it arrives
 * instead of leaving the window permanently empty.
 */
function TileHost({ tileId }: { tileId: string }) {
  const { t } = useI18n()
  const tile = useTileMap().get(tileId)

  return (
    <SidebarProvider>
      <div className="relative flex h-full min-h-0 flex-col">
        <div
          className="flex h-(--titlebar-height) shrink-0 items-center gap-1 border-b border-(--ui-stroke-tertiary) pr-1 pl-2"
          data-tauri-drag-region
        >
          <span className="min-w-0 flex-1 truncate text-xs text-(--ui-text-secondary)">{tile?.title ?? tileId}</span>
          <WindowControls />
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {tile ? (
            <ContribBoundary id={tile.id}>{tile.render()}</ContribBoundary>
          ) : (
            <div className="grid h-full place-items-center px-6 text-center text-xs text-(--ui-text-quaternary)">
              {t.zones.detachedMissing}
            </div>
          )}
        </div>
      </div>
      <NotificationStack />
    </SidebarProvider>
  )
}

/**
 * Root for every SATELLITE window (MJXHRM-173) — a window hosting exactly one
 * tile, mounted by `app.tsx` instead of the full shell.
 *
 * A chat tile keeps the dedicated host it always had: resuming a session is not
 * "render this tile", it is a whole connection dance, and that window is also
 * reachable from three call sites that know a session and not a tile. Every
 * other tile goes through the generic host.
 *
 * No tile named at all means a legacy `?win=secondary` URL, whose target is the
 * session in the route — so it takes the chat host too.
 */
export function TileWindowRoot() {
  const tileId = detachedTileId()

  return !tileId || isChatPaneId(tileId) ? <ChatTileHost /> : <TileHost tileId={tileId} />
}
