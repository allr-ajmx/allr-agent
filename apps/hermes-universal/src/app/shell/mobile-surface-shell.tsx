import { useLocation, useNavigate } from 'react-router-dom'

import { AgentsView } from '@/app/agents'
import { CommandCenterView } from '@/app/command-center'
import { CronView } from '@/app/cron'
import { GatewayConnectingScreen } from '@/app/gateway/gateway-connecting-screen'
import { ProfilesView } from '@/app/profiles'
import { SettingsFooter, SettingsView } from '@/app/settings/settings-view'
import { MobileChromeBar } from '@/app/shell/mobile-chrome-bar'
import { useSurfaceNavRows } from '@/app/shell/surface-nav'
import { TitlebarButton } from '@/app/shell/titlebar-button'
import { Codicon } from '@/components/ui/codicon'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { TitleMenuTrigger } from '@/components/ui/title-menu-trigger'
import { useKeyboardInset } from '@/hooks/use-keyboard-inset'
import { useI18n } from '@/i18n'
import { useStore } from '@/store/atom'
import { $connectionPhase, $hasConnected } from '@/store/connection'
import { $gatewaySwitching } from '@/store/gateway-switch'
import { deleteSessionLocal } from '@/store/session'
import { activitySurfaceForPath } from '@/store/windows'

// The shared mobile chrome for a windowable surface (Settings / Command Center /
// Profiles / Cron). It is the SAME layout the Android native activity screen uses,
// factored out of `app/activity-screen.tsx` so the iOS / generic-mobile in-app overlay
// (mobile-controller) can present these surfaces with identical chrome instead of the
// desktop split-nav view (MJX-203).
//
// Chrome: one row — Back on the left, the surface's name in the middle, nothing on
// the right. A second screen has exactly one way out and it is where a phone user's
// thumb already goes; a hamburger there meant the way out was a menu item inside a
// drawer. Where the surface HAS sub-sections, the name itself is the menu: title and
// chevron are one button, so the thing you read is the thing you tap. Surfaces with
// no sub-sections (Profiles, Cron are master/detail lists) render a plain title.
//
// Section state lives in the URL, so picking a row is an in-WebView route change and
// the chromeless view (`hideNav`) re-renders at that section.
//
// The two hosts differ only in their callbacks, injected here:
//   • Android native activity (activity-screen): onHome/onOpenSession = returnHome.
//   • iOS in-app overlay (mobile-controller): onHome = closeOverlayToPreviousRoute,
//     onOpenSession = navigate(sessionRoute(id)).
export function MobileSurfaceShell({
  onHome,
  onOpenSession,
  onNavigateRoute
}: {
  /** Back / home — and each surface's `onClose`. */
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
  const navigate = useNavigate()

  const phase = useStore($connectionPhase)
  const hasConnected = useStore($hasConnected)
  const switching = useStore($gatewaySwitching)
  const ready = phase === 'ready'

  const surface = activitySurfaceForPath(pathname)
  const navRows = useSurfaceNavRows(surface)

  const title =
    surface === 'agents'
      ? t.agents.title
      : surface === 'command-center'
        ? t.commandCenter.commandCenter
        : surface === 'cron'
          ? t.cron.title
          : surface === 'profiles'
            ? t.profiles.title
            : t.commandCenter.settings

  // Command Center / Cron / Profiles need a live connection for their data;
  // Settings can render once we've ever connected so it survives a reconnect. A
  // soft gateway switch briefly drops the socket while it re-dials — keep the
  // surface mounted across it rather than flashing the connecting screen.
  const showSurface = surface === 'settings' ? ready || hasConnected : ready || (switching && hasConnected)

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-slot="mobile-surface-shell">
      <MobileChromeBar
        center={
          navRows.length > 0 ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <TitleMenuTrigger className="w-full justify-start" density="mobile">
                  {title}
                </TitleMenuTrigger>
              </DropdownMenuTrigger>
              {/* Aligned to the title, not centred on it: the trigger now fills
                  the row, so "centred on the trigger" put the menu in the middle
                  of the screen with nothing above it. */}
              <DropdownMenuContent align="start" className="max-h-[70vh] w-56 overflow-y-auto" sideOffset={6}>
                {navRows.map(row => (
                  <DropdownMenuItem
                    className={row.active ? 'bg-(--ui-row-active-background) text-foreground' : undefined}
                    key={row.id}
                    onSelect={() => navigate(row.path)}
                  >
                    {row.icon}
                    <span className="min-w-0 flex-1 truncate">{row.label}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <span className="block truncate text-sm font-medium">{title}</span>
          )
        }
        left={
          <TitlebarButton density="mobile" label={t.common.back} onClick={onHome}>
            <Codicon name="chevron-left" size="1.4rem" />
          </TitlebarButton>
        }
      />

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
          ) : surface === 'cron' ? (
            <CronView onClose={onHome} onOpenSession={onOpenSession} variant="fullscreen" />
          ) : surface === 'agents' ? (
            <AgentsView onClose={onHome} variant="fullscreen" />
          ) : (
            <ProfilesView onClose={onHome} variant="fullscreen" />
          )
        ) : (
          <GatewayConnectingScreen />
        )}
      </div>

      {/* Export / import / reset config. It used to ride the nav drawer's footer;
          with the drawer gone it sits at the foot of the surface it belongs to —
          not in the title menu, where its reset confirmation is a Dialog that a
          closing DropdownMenu would unmount out from under itself. */}
      {showSurface && surface === 'settings' && (
        <div
          className="flex shrink-0 items-center justify-end gap-1 border-t border-(--ui-stroke-tertiary) bg-(--ui-bg-chrome) px-2 py-0.5"
          style={{ paddingBottom: 'calc(0.125rem + var(--safe-area-inset-bottom))' }}
        >
          <SettingsFooter />
        </div>
      )}
    </div>
  )
}
