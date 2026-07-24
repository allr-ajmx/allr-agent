import { type ReactNode, useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

import { AgentsView } from '@/app/agents'
import { CommandCenterView } from '@/app/command-center'
import { ConnectScreen } from '@/app/connect-screen'
import { CronView } from '@/app/cron'
import { GatewayConnectingScreen } from '@/app/gateway/gateway-connecting-screen'
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
import { $onboardingActive, checkConfigured } from '@/store/onboarding'
import { syncPetInfo } from '@/store/pet-gallery'
import { deleteSessionLocal } from '@/store/session'
import { bumpZoom, initZoom, setZoomPercent } from '@/store/zoom'

import { ContribController } from './contrib/controller'
import { WorkspaceRoutes } from './contrib/panes'
import { useKeybinds } from './hooks/use-keybinds'
import { COMMAND_CENTER_ROUTE, sessionRoute } from './routes'
import { SessionSwitcher } from './session-switcher'
import { CommandMenu } from './shell/command-menu'
import { useOverlayRouting } from './shell/hooks/use-overlay-routing'
import { MobileShell } from './shell/mobile-shell'
import { AppShell, SidebarProvider } from './shell/sidebar'
import { Statusbar } from './shell/statusbar'
import { Titlebar } from './shell/titlebar'

// Connected-guard + routing. Until a gateway connection is ready we show the
// full-screen ConnectScreen (no nav). Once ready, the first-run onboarding
// wizard shows if no provider is configured (K11); otherwise the sidebar shell
// hosts the routed views. The toast stack (portaled to <body>) floats over all.
export function MobileController() {
  const phase = useStore($connectionPhase)
  const onboarding = useStore($onboardingActive)
  const restoring = useStore($restoring)
  const hasConnected = useStore($hasConnected)

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
  // pull the active pet's sprite (K10.b) so the in-app pet can render in chat.
  useEffect(() => {
    if (phase === 'ready') {
      void checkConfigured()
      void syncPetInfo()
    }
  }, [phase])

  const connected = phase === 'ready' && !onboarding

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
    toggleCommandCenter: () => (commandCenterOpen ? closeOverlayToPreviousRoute() : navigate(COMMAND_CENTER_ROUTE))
  })

  // Only the Gateway settings page is usable while disconnected (it's the
  // reconnect / sign-in surface). Every other settings section needs live gateway
  // data, so keeping the overlay mounted there while disconnected would just render
  // empty sections — so a disconnect only holds the overlay open on Gateway.
  const settingsGatewayOpen = pathname === '/settings/gateway'

  let content: ReactNode

  if (phase !== 'ready') {
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
        {/* Global command menu — ⌘K (the `nav.commandPalette` keybind), titlebar
            search, and the in-drawer button all open it; reaches every view not
            on the 4-item sidebar rail. */}
        <CommandMenu />
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
            is a desktop surface it will grow its own equivalent of. */}
        {connected && !IS_MOBILE && <Statusbar />}
        {/* Settings portal — a full-window overlay (fixed z-50) over the titlebar
            (z-40) and chat backdrop. Stays mounted while disconnected too (a
            settings-initiated "Save & reconnect", or a sign-out) so reconfiguring or
            re-authenticating the gateway never bounces the user out to the connect
            picker — desktop parity. Blocked only during the first-run onboarding
            wizard (phase ready but not connected). */}
        {settingsOpen && (connected || settingsGatewayOpen) && <SettingsView returnPath={returnPathRef.current} />}
        {/* Agents ("Spawn tree") overlay — desktop's live subagent surface,
            floated over the chat backdrop and opened from the statusbar Agents
            item. Its Panel supplies the fixed-inset card + close-X / Esc. */}
        {connected && agentsOpen && <AgentsView onClose={closeOverlayToPreviousRoute} />}
        {/* Command Center overlay — desktop's Sessions / System / Usage /
            Maintenance ops surface, opened from the statusbar (icon + version
            chips) and the sidebar rail. */}
        {connected && commandCenterOpen && (
          <CommandCenterView
            onClose={closeOverlayToPreviousRoute}
            onDeleteSession={deleteSessionLocal}
            onNavigateRoute={path => navigate(path)}
            onOpenSession={sessionId => navigate(sessionRoute(sessionId))}
          />
        )}
        {/* Cron ("Routines") overlay — desktop's scheduled-jobs master/detail:
            schedule, run history, pause/resume/trigger. Opened from the sidebar
            rail and from "Manage" on a sidebar cron row. */}
        {connected && cronOpen && (
          <CronView
            onClose={closeOverlayToPreviousRoute}
            onOpenSession={sessionId => navigate(sessionRoute(sessionId))}
          />
        )}
        {/* Profiles overlay — desktop's profile CRUD + soul editor master/detail. */}
        {connected && profilesOpen && <ProfilesView onClose={closeOverlayToPreviousRoute} />}
        {/* Star map overlay — the radial "what Hermes has learned" map. */}
        {connected && starmapOpen && <StarmapView onClose={closeOverlayToPreviousRoute} />}
        {/* Provider-connect overlay — a focused per-provider sign-in card that
            floats OVER the settings page (z-70) without unmounting it. Opened from
            Providers → Accounts; gated on $connectProvider, not $onboardingActive. */}
        {connected && <ProviderConnectOverlay />}
        {/* Floating pet — a top-level draggable + roaming mascot (fixed z-60) that
            floats over ALL routes. It patrols the Settings overlay's edge when open.
            Hidden on mobile while the touch shell is a blank scaffold. */}
        {connected && !IS_MOBILE && (
          <FloatingPet
            overlayOpen={settingsOpen || agentsOpen || commandCenterOpen || cronOpen || profilesOpen || starmapOpen}
          />
        )}
      </div>
    </SidebarProvider>
  )
}
