import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'

import { ChatScreen } from '@/app/chat/chat-screen'
import { ChatTitle } from '@/app/chat/chat-title'
import { SidebarProvider } from '@/app/shell/sidebar'
import { WindowControls } from '@/app/shell/window-controls'
import { NotificationStack } from '@/components/notifications'
import { useStore } from '@/store/atom'
import { $connectionPhase } from '@/store/connection'
import { $gatewaySwitching } from '@/store/gateway-switch'
import { openSession, refreshSessions } from '@/store/session'

import { routeSessionId } from './routes'

// Secondary-window root (MJX-104). A native pop-out (`?win=secondary`, opened by
// `src-tauri/src/window.rs`) renders a SINGLE chat with its own frameless titlebar
// — no sidebar, tiles, overlays, pet or statusbar (all of which live in
// MobileController, which we bypass at `app.tsx`). The target session id rides in
// the HashRouter route (`#/<id>`); once this window's own connection is live we
// load the session list (so the header title resolves — the sidebar that usually
// fetches it isn't mounted here) and resume the target into the global chat store,
// which ChatScreen renders. The in-chat ChatHeader stands down in a secondary
// window (see chat-header.tsx), so the title lives in this titlebar instead.
export function SecondaryWindowRoot() {
  const { pathname } = useLocation()
  const phase = useStore($connectionPhase)
  // This window re-homes when another WebView switches gateway (store/gateway-switch-sync).
  // Hold the chat across that window rather than blanking to an empty pane for the
  // second the socket is down — the same tolerance the other two roots carry.
  const switching = useStore($gatewaySwitching)
  const targetId = routeSessionId(pathname)
  const resumedRef = useRef<null | string>(null)

  // A re-home means the resume we already did was against the OLD gateway, so drop
  // the latch and let the effect below resume this session against the new one. (It
  // may not exist there — an empty chat with the surfaced error is the expected
  // outcome, not a crash.)
  useEffect(() => {
    if (switching) {
      resumedRef.current = null
    }
  }, [switching])

  useEffect(() => {
    // Resume needs a live connection; wait for `ready` so the transcript loads
    // instead of latching on a dead poll (desktop's stuck-loading failure mode).
    if (phase !== 'ready' || !targetId || resumedRef.current === targetId) {
      return
    }

    resumedRef.current = targetId
    void refreshSessions()
    void openSession(targetId)
  }, [phase, targetId])

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
