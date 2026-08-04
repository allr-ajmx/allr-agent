import { useLocation } from 'react-router-dom'

import { ActivityNavSidebar } from '@/app/activity-screen-nav'
import { CommandCenterView } from '@/app/command-center'
import { GatewayConnectingScreen } from '@/app/gateway/gateway-connecting-screen'
import { ProfilesView } from '@/app/profiles'
import { SettingsFooter, SettingsView } from '@/app/settings/settings-view'
import { MobileRightPanel } from '@/app/shell/mobile-right-panel'
import { useSidebar } from '@/app/shell/sidebar'
import { TitlebarButton } from '@/app/shell/titlebar-button'
import { Codicon } from '@/components/ui/codicon'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import { useKeyboardInset } from '@/hooks/use-keyboard-inset'
import { useI18n } from '@/i18n'
import { useStore } from '@/store/atom'
import { $connectionPhase, $hasConnected } from '@/store/connection'
import { $gatewaySwitching } from '@/store/gateway-switch'
import { deleteSessionLocal } from '@/store/session'
import { activitySurfaceForPath } from '@/store/windows'

// The shared mobile chrome for a windowable surface (Settings / Command Center /
// Profiles). It is the SAME layout the Android native activity screen uses, factored
// out of `app/activity-screen.tsx` so the iOS / generic-mobile in-app overlay
// (mobile-controller) can present these surfaces with identical chrome instead of the
// desktop split-nav view (MJX-203).
//
// Chrome: a top bar (left nav toggle · centered title · right drawer toggle) over two
// `Sheet` drawers — the surface's sub-nav on the left (ActivityNavSidebar) and the
// Status/Files panel on the right (MobileRightPanel). The shown surface is derived
// LIVE from the route (`activitySurfaceForPath`), so switching surfaces from the
// right-drawer switcher is an instant in-WebView route change.
//
// The two hosts differ only in their callbacks, injected here:
//   • Android native activity (activity-screen): onHome/onOpenSession = returnHome.
//   • iOS in-app overlay (mobile-controller): onHome = closeOverlayToPreviousRoute,
//     onOpenSession = navigate(sessionRoute(id)).
// The caller supplies the surrounding SidebarProvider (so the in-app overlay can use
// its OWN provider and not share drawer open-state with the home MobileShell).
export function MobileSurfaceShell({
  onHome,
  onOpenSession,
  onNavigateRoute
}: {
  /** Home / back — and each surface's `onClose`. */
  onHome: () => void
  /** Command Center row tap. */
  onOpenSession: (sessionId: string) => void
  /** Command Center route jumps (optional; in-app path wires `navigate`). */
  onNavigateRoute?: (path: string) => void
}) {
  // Publishes --keyboard-inset so the content lifts above the soft keyboard when an
  // input (API keys, search) is focused.
  useKeyboardInset()
  const { t } = useI18n()
  const { pathname } = useLocation()

  const { openMobile, setOpenMobile, toggleMobile, openMobileRight, setOpenMobileRight, toggleMobileRight } =
    useSidebar()

  const phase = useStore($connectionPhase)
  const hasConnected = useStore($hasConnected)
  const switching = useStore($gatewaySwitching)
  const ready = phase === 'ready'

  const surface = activitySurfaceForPath(pathname)

  const title =
    surface === 'command-center'
      ? t.commandCenter.commandCenter
      : surface === 'profiles'
        ? t.profiles.title
        : t.commandCenter.settings

  // Command Center + Profiles need a live connection for their data; Settings can
  // render once we've ever connected so it survives a reconnect. A soft gateway
  // switch briefly drops the socket while it re-dials — keep the surface mounted
  // across it rather than flashing the connecting screen.
  const showSurface = surface === 'settings' ? ready || hasConnected : ready || (switching && hasConnected)

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
            <SettingsView hideNav onClose={onHome} variant="fullscreen" />
          ) : surface === 'command-center' ? (
            <CommandCenterView
              hideNav
              onClose={onHome}
              onDeleteSession={deleteSessionLocal}
              onNavigateRoute={onNavigateRoute}
              onOpenSession={onOpenSession}
              variant="fullscreen"
            />
          ) : (
            <ProfilesView onClose={onHome} variant="fullscreen" />
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
            onHome={onHome}
            onNavigate={() => setOpenMobile(false)}
            surface={surface}
          />
        </SheetContent>
      </Sheet>

      {/* Right drawer — Status / Files + the screen switcher, reused from the home shell. */}
      <Sheet onOpenChange={setOpenMobileRight} open={openMobileRight}>
        <SheetContent className="w-[19rem] gap-0 p-0" showCloseButton={false} side="right">
          <MobileRightPanel />
        </SheetContent>
      </Sheet>
    </div>
  )
}
