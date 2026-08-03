import { useCallback } from 'react'
import { useLocation } from 'react-router-dom'

import { CommandCenterView } from '@/app/command-center'
import { GatewayConnectingScreen } from '@/app/gateway/gateway-connecting-screen'
import { ProfilesView } from '@/app/profiles'
import { SettingsFooter, SettingsView } from '@/app/settings/settings-view'
import { MobileRightPanel } from '@/app/shell/mobile-right-panel'
import { SidebarProvider, useSidebar } from '@/app/shell/sidebar'
import { NotificationStack } from '@/components/notifications'
import { Codicon } from '@/components/ui/codicon'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import { useKeyboardInset } from '@/hooks/use-keyboard-inset'
import { useI18n } from '@/i18n'
import { useStore } from '@/store/atom'
import { $connectionPhase, $hasConnected } from '@/store/connection'
import { deleteSessionLocal } from '@/store/session'
import { activitySurfaceForPath, returnHome } from '@/store/windows'

import { ActivityNavSidebar } from './activity-screen-nav'
import { TitlebarButton } from './shell/titlebar-button'

// Native activity-screen root (MJX-141). On Android/iOS, the windowable surfaces
// (Settings / Command Center / Profiles) open in ONE native screen activity / scene
// (a fresh WebView carrying `?win=activity`, launched from `src-tauri/src/window.rs`).
// `app.tsx` mounts this instead of the full chat shell (MobileController).
//
// The shell mirrors the home MobileShell: a top bar (left nav toggle · title ·
// right drawer toggle) over two `Sheet` drawers. Which surface is shown is derived
// LIVE from the current route (`activitySurfaceForPath`), so switching surfaces from
// the right-drawer switcher is an instant in-WebView route change — no relaunch.
//
// The WebView shares the single Rust core, but its JS/connection is fresh:
// `main.tsx` auto-reconnects on boot, so — like SecondaryWindowRoot — we wait for
// `$connectionPhase` before rendering. Settings may stay up across a save-and-
// reconnect (mirrors mobile-controller's gate) via `$hasConnected`.
export function ActivityScreenRoot() {
  return (
    <SidebarProvider>
      <ActivityShell />
      <NotificationStack />
    </SidebarProvider>
  )
}

function ActivityShell() {
  // Publishes --keyboard-inset so the content lifts above the soft keyboard when
  // an input (API keys, search) is focused.
  useKeyboardInset()
  const { t } = useI18n()
  const { pathname } = useLocation()

  const { openMobile, setOpenMobile, toggleMobile, openMobileRight, setOpenMobileRight, toggleMobileRight } =
    useSidebar()

  const phase = useStore($connectionPhase)
  const hasConnected = useStore($hasConnected)
  const ready = phase === 'ready'

  // Home returns to the home activity (MainActivity, where the sessions live).
  const goHome = useCallback(() => {
    void returnHome()
  }, [])

  const surface = activitySurfaceForPath(pathname)

  const title =
    surface === 'command-center' ? t.commandCenter.commandCenter : surface === 'profiles' ? t.profiles.title : t.commandCenter.settings

  // Command Center + Profiles need a live connection for their data; Settings can
  // render once we've ever connected so it survives a reconnect.
  const showSurface = surface === 'settings' ? ready || hasConnected : ready

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* Top bar — owns the safe-area top inset (status-bar / notch). Left toggles
          the section-nav drawer; right toggles the Status/Files + switcher drawer. */}
      <div
        className="shrink-0 border-b border-(--ui-stroke-tertiary) bg-(--ui-bg-chrome) select-none"
        style={{ paddingTop: 'var(--safe-area-inset-top)' }}
      >
        <div className="flex h-8 items-center gap-1 px-2">
          <TitlebarButton className="size-4" label={t.titlebar.showSidebar} onClick={toggleMobile}>
            <Codicon name="list-unordered" size="1.4rem" />
          </TitlebarButton>

          <div className="min-w-0 flex-1 overflow-hidden">
            <span className="block truncate text-center text-sm font-medium">{title}</span>
          </div>

          <TitlebarButton className="size-4" label={t.titlebar.showRightSidebar} onClick={toggleMobileRight}>
            <Codicon name="layout-sidebar-right" size="1.4rem" />
          </TitlebarButton>
        </div>
      </div>

      {/* Routed surface. Lifts above the soft keyboard like the home shell. */}
      <div className="flex min-h-0 flex-1 flex-col" style={{ marginBottom: 'var(--keyboard-inset, 0px)' }}>
        {showSurface ? (
          surface === 'settings' ? (
            <SettingsView hideNav onClose={goHome} variant="fullscreen" />
          ) : surface === 'command-center' ? (
            <CommandCenterView
              hideNav
              onClose={goHome}
              onDeleteSession={deleteSessionLocal}
              // Opening a session belongs in the main chat activity; return there.
              onOpenSession={goHome}
              variant="fullscreen"
            />
          ) : (
            <ProfilesView onClose={goHome} variant="fullscreen" />
          )
        ) : (
          <GatewayConnectingScreen />
        )}
      </div>

      {/* Left drawer — the current surface's sub-nav + Home entry. */}
      <Sheet onOpenChange={setOpenMobile} open={openMobile}>
        <SheetContent className="w-[19rem] gap-0 p-0" showCloseButton={false} side="left">
          <ActivityNavSidebar
            footer={surface === 'settings' ? <SettingsFooter /> : undefined}
            onNavigate={() => setOpenMobile(false)}
            surface={surface}
          />
        </SheetContent>
      </Sheet>

      {/* Right drawer — Status / Files + the screen switcher (Command Center /
          Settings / Profiles), reused from the home shell. */}
      <Sheet onOpenChange={setOpenMobileRight} open={openMobileRight}>
        <SheetContent className="w-[19rem] gap-0 p-0" showCloseButton={false} side="right">
          <MobileRightPanel />
        </SheetContent>
      </Sheet>
    </div>
  )
}
