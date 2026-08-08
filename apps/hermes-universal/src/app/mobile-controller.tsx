import { type ReactNode, useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

import { AgentsView } from '@/app/agents'
import { CommandCenterView } from '@/app/command-center'
import { ConnectScreen } from '@/app/connect-screen'
import { CronView } from '@/app/cron'
import { GatewayConnectingScreen } from '@/app/gateway/gateway-connecting-screen'
import { ModelVisibilityOverlay } from '@/app/model-visibility-overlay'
import { OnboardingScreen } from '@/app/onboarding/onboarding-screen'
import { FloatingPet } from '@/app/pet/floating-pet'
import { ProfilesView } from '@/app/profiles'
import { ProviderConnectOverlay } from '@/app/settings/provider-connect-overlay'
import { SettingsView } from '@/app/settings/settings-view'
import { StarmapView } from '@/app/starmap'
import { NotificationStack } from '@/components/notifications'
import { useMediaQuery } from '@/hooks/use-media-query'
import { IS_DESKTOP, IS_MOBILE } from '@/lib/platform'
import { useStore } from '@/store/atom'
import { $connectionPhase, $hasConnected } from '@/store/connection'
import { $restoring } from '@/store/gateway-restore'
import { $gatewaySwitching } from '@/store/gateway-switch'
import { $onboardingActive, checkConfigured } from '@/store/onboarding'
import { syncPetInfo } from '@/store/pet-gallery'
import { deleteSessionLocal } from '@/store/session'
import { $statusbarVisible } from '@/store/statusbar-prefs'
import { openAppRoute } from '@/store/windows'
import { bumpZoom, initZoom, setZoomPercent } from '@/store/zoom'

import { CommandPalette } from './command-palette'
import { ContribController } from './contrib/controller'
import { WorkspaceRoutes } from './contrib/panes'
import { useKeybinds } from './hooks/use-keybinds'
import { COMMAND_CENTER_ROUTE, GATEWAY_SETTINGS_ROUTE, sessionRoute } from './routes'
import { SessionSwitcher } from './session-switcher'
import { useOverlayRouting } from './shell/hooks/use-overlay-routing'
import { MobileShell } from './shell/mobile-shell'
import { MobileSurfaceShell } from './shell/mobile-surface-shell'
import { AppShell, SidebarProvider } from './shell/sidebar'
import { Statusbar } from './shell/statusbar'
import { Titlebar } from './shell/titlebar'

// Connected-guard + routing. Until a gateway connection is ready we show the
// full-screen ConnectScreen (no nav). Once ready, the first-run onboarding
// wizard shows if no provider is configured; otherwise the sidebar shell
// hosts the routed views. The toast stack (portaled to <body>) floats over all.
export function MobileController() {
  const phase = useStore($connectionPhase)
  const onboarding = useStore($onboardingActive)
  const restoring = useStore($restoring)
  const hasConnected = useStore($hasConnected)
  const switching = useStore($gatewaySwitching)
  const statusbarVisible = useStore($statusbarVisible)

  // UI scale: apply the persisted zoom once, and wire Cmd/Ctrl +/-/0 shortcuts.
  // Zoom stays outside the rebindable registry — desktop keeps it out too.
  useEffect(() => {
    initZoom()

    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) {
        return
      }

      if (event.key === '=' || event.key === '+') {
        event.preventDefault()
        bumpZoom(10)
      } else if (event.key === '-' || event.key === '_') {
        event.preventDefault()
        bumpZoom(-10)
      } else if (event.key === '0') {
        event.preventDefault()
        setZoomPercent(100)
      }
    }

    window.addEventListener('keydown', onKey)

    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // On reaching a live connection, check whether a provider is configured and
  // pull the active pet's sprite so the in-app pet can render in chat.
  useEffect(() => {
    if (phase === 'ready') {
      void checkConfigured()
      void syncPetInfo()
    }
  }, [phase])

  // A soft gateway switch (store/gateway-switch.ts) drops the socket for a moment
  // while it re-dials. Treat that window as live so the shell — and the surface
  // driving the switch (Settings, the statusbar gateway popover) — stays mounted
  // instead of bouncing to the connecting screen. Only once we've been connected:
  // on a first run the connect screen owns the dial and must keep it.
  const live = phase === 'ready' || (switching && hasConnected)
  const connected = live && !onboarding

  // Desktop always uses the docked (wide) shell regardless of window width;
  // mobile/web fall to the phone drawer below 768px. The wide path renders the
  // MJX-50 layout tree; the narrow path keeps the flat AppShell drawer.
  const mediaWide = useMediaQuery('(min-width: 768px)')
  const wide = IS_DESKTOP || mediaWide

  // Overlay views (settings / command-center / agents / cron / …) are top-level
  // portals rather than routed panes — desktop parity: the underlying route (chat)
  // stays as the backdrop and the portal floats over it. Open state and the
  // "return to where you were" path both come from the shared hook ported from
  // desktop's shell/hooks/use-overlay-routing.
  const { pathname } = useLocation()
  const navigate = useNavigate()

  const {
    agentsOpen,
    closeOverlayToPreviousRoute,
    commandCenterOpen,
    cronOpen,
    profilesOpen,
    returnPathRef,
    starmapOpen,
    settingsOpen
  } = useOverlayRouting()

  // The single global listener for every rebindable hotkey, plus the keybind
  // panel's capture mode (ported from desktop). It supersedes the ad-hoc ⌘B/⌘⇧F/
  // ⌘G/⌘N and ⌘K listeners this app used to carry. Mounted unconditionally so
  // the keys work on the connect / onboarding screens too.
  useKeybinds({
    toggleCommandCenter: () => (commandCenterOpen ? closeOverlayToPreviousRoute() : openAppRoute(COMMAND_CENTER_ROUTE))
  })

  // Only the Gateway settings page is usable while disconnected (it's the
  // reconnect / sign-in surface). Every other settings section needs live gateway
  // data, so keeping the overlay mounted there while disconnected would just render
  // empty sections — so a disconnect only holds the overlay open on Gateway.
  const settingsGatewayOpen = pathname === GATEWAY_SETTINGS_ROUTE

  // Whether any of the windowable surfaces (Settings / Command Center / Profiles /
  // Cron / Agents) is open — the trigger for the mobile in-app surface shell. Mirrors
  // the per-surface gates of the desktop overlays (Settings survives a disconnect on
  // the Gateway page; the others need a live connection).
  const mobileSurfaceOpen =
    (settingsOpen && (connected || settingsGatewayOpen)) ||
    (connected && (agentsOpen || commandCenterOpen || cronOpen || profilesOpen))

  let content: ReactNode

  if (!live) {
    // Not connected. Priority: a boot restore shows the connecting screen; if the
    // user is in Settings (e.g. they just signed out on the gateway page) keep a
    // neutral backdrop so the Settings overlay stays and shows the Sign in button
    // (desktop parity — sign-out doesn't bounce to the home/connect screen); an
    // in-session reconnect (dropped socket) shows the connecting screen; otherwise
    // it's a genuine first run → the connect screen.
    content = (
      <>
        <NotificationStack />
        {restoring ? (
          <GatewayConnectingScreen />
        ) : settingsGatewayOpen ? (
          <div className="h-full bg-background" />
        ) : hasConnected ? (
          <GatewayConnectingScreen />
        ) : (
          <ConnectScreen />
        )}
      </>
    )
  } else if (onboarding) {
    content = (
      <>
        <NotificationStack />
        <OnboardingScreen />
      </>
    )
  } else {
    content = (
      <>
        <NotificationStack />
        {/* Global command palette — ⌘K (the `nav.commandPalette` keybind),
            titlebar search, and the in-drawer button all open it; reaches every
            view not on the 4-item sidebar rail, plus sessions, settings fields,
            themes and plugin commands. */}
        <CommandPalette />
        {/* ⌃Tab session switcher HUD — keyboard-driven from useKeybinds. */}
        <SessionSwitcher />
        {/* Layout fork, mobile-first so a phone NEVER falls into the docked
            tile tree regardless of measured width:
            • IS_MOBILE → the new touch shell (blank scaffold for now).
            • wide (desktop, or ≥768 window) → the MJX-50 recursive LAYOUT TREE:
              every surface (sidebar / chat routes / files / preview / review /
              terminal) is an `area:'panes'` contribution the controller registers;
              the tree resolves content from the registry and hosts multi-session
              tiles.
            • else (web / sub-768 desktop window) → the flat AppShell drawer. */}
        {IS_MOBILE ? (
          <MobileShell />
        ) : wide ? (
          <ContribController />
        ) : (
          <AppShell>
            <WorkspaceRoutes />
          </AppShell>
        )}
      </>
    )
  }

  // SidebarProvider wraps every branch so the desktop Titlebar's sidebar button
  // has context on all screens. The frameless-window chrome (Titlebar) mounts
  // above the routed content on desktop Tauri only; mobile/web keep the native
  // top inset and per-screen headers.
  return (
    <SidebarProvider>
      <div className="relative flex h-full min-h-0 flex-col">
        {/* Frameless chrome — a REAL top row (in-flow, reserves its height) so
            it can never cover the content beneath it (the tree zone tab strips /
            session titles start right below it). Desktop Tauri only. */}
        {IS_DESKTOP && <Titlebar connected={connected} />}
        <div className="min-h-0 flex-1">{content}</div>
        {/* Bottom statusbar (ported from desktop): a real shrink-0 row below the
            content. Connected-only — it reads live gateway/session state. Hidden
            on mobile: the touch shell is a blank canvas for now and the statusbar
            is a desktop surface it will grow its own equivalent of.
            UNMOUNTED — not just hidden — while toggled off, so its status poll
            and the per-turn readouts stop with it. */}
        {connected && !IS_MOBILE && statusbarVisible && <Statusbar />}
        {/* Settings portal — a full-window overlay (fixed z-50) over the titlebar
            (z-40) and chat backdrop. Stays mounted while disconnected too (a
            settings-initiated "Save & reconnect", or a sign-out) so reconfiguring or
            re-authenticating the gateway never bounces the user out to the connect
            picker — desktop parity. Blocked only during the first-run onboarding
            wizard (phase ready but not connected). */}
        {/* Mobile: Settings / Command Center / Profiles present as ONE full-screen
            in-app surface with the shared mobile chrome (top bar + two drawers),
            derived live from the route — parity with the Android native activity
            screen (MJX-203). Its OWN SidebarProvider isolates these drawers from the
            home MobileShell's drawers (both mount Sheets keyed to the same useSidebar
            booleans). Home/back navigates to the stashed route (NOT returnHome, whose
            iOS fallback would try to close the primary window). The desktop floating-
            overlay path below is used off-mobile (and stays untouched). */}
        {IS_MOBILE && mobileSurfaceOpen && (
          <div className="fixed inset-0 z-50">
            <SidebarProvider>
              <MobileSurfaceShell
                onHome={closeOverlayToPreviousRoute}
                onNavigateRoute={path => navigate(path)}
                onOpenSession={sessionId => navigate(sessionRoute(sessionId))}
              />
            </SidebarProvider>
          </div>
        )}
        {!IS_MOBILE && settingsOpen && (connected || settingsGatewayOpen) && (
          <SettingsView returnPath={returnPathRef.current} variant="overlay" />
        )}
        {/* Agents ("Spawn tree") overlay — desktop's live subagent surface,
            floated over the chat backdrop and opened from the statusbar Agents
            item. Its Panel supplies the fixed-inset card + close-X / Esc. On a
            phone it is a windowable surface instead (MobileSurfaceShell / a
            native Android screen), so the desktop card never renders there. */}
        {!IS_MOBILE && connected && agentsOpen && <AgentsView onClose={closeOverlayToPreviousRoute} />}
        {/* Command Center overlay — desktop's Sessions / System / Usage /
            Maintenance ops surface, opened from the statusbar (icon + version
            chips) and the sidebar rail. */}
        {!IS_MOBILE && connected && commandCenterOpen && (
          <CommandCenterView
            onClose={closeOverlayToPreviousRoute}
            onDeleteSession={deleteSessionLocal}
            onNavigateRoute={path => navigate(path)}
            onOpenSession={sessionId => navigate(sessionRoute(sessionId))}
            variant="overlay"
          />
        )}
        {/* Cron ("Routines") overlay — desktop's scheduled-jobs master/detail:
            schedule, run history, pause/resume/trigger. Opened from the sidebar
            rail and from "Manage" on a sidebar cron row. On a phone it is a
            windowable surface instead (MobileSurfaceShell / a native Android
            screen), so the desktop card never renders there. */}
        {!IS_MOBILE && connected && cronOpen && (
          <CronView
            onClose={closeOverlayToPreviousRoute}
            onOpenSession={sessionId => navigate(sessionRoute(sessionId))}
          />
        )}
        {/* Profiles overlay — desktop's profile CRUD + soul editor master/detail. */}
        {!IS_MOBILE && connected && profilesOpen && <ProfilesView onClose={closeOverlayToPreviousRoute} />}
        {/* Star map overlay — the radial "what Hermes has learned" map. */}
        {connected && starmapOpen && <StarmapView onClose={closeOverlayToPreviousRoute} />}
        {/* Provider-connect overlay — a focused per-provider sign-in card that
            floats OVER the settings page (z-70) without unmounting it. Opened from
            Providers → Accounts; gated on $connectProvider, not $onboardingActive. */}
        {connected && <ProviderConnectOverlay />}
        {/* Edit-models ("model visibility") dialog — opened from the composer's
            model menu ("Edit models"). Self-gates on $modelVisibilityOpen +
            gateway-open; "Add provider…" routes to Providers → Accounts. */}
        {connected && <ModelVisibilityOverlay onOpenProviders={() => openAppRoute('/settings/providers')} />}
        {/* Floating pet — a top-level draggable + roaming mascot that floats over
            ALL routes. It patrols the Settings overlay's edge when open.

            On a phone it walks all four screen edges rather than only the floor,
            sits below the composer bars rather than over them, and lifts on
            contact (its box owns the gesture — see PET_TOUCH_ACTION). It is
            hidden while a MobileSurfaceShell surface is up: those are full-screen route
            surfaces with no card inset, so the overlay ledge the pet would
            patrol doesn't exist there. */}
        {connected && !(IS_MOBILE && mobileSurfaceOpen) && (
          <FloatingPet
            overlayOpen={settingsOpen || agentsOpen || commandCenterOpen || cronOpen || profilesOpen || starmapOpen}
          />
        )}
      </div>
    </SidebarProvider>
  )
}
