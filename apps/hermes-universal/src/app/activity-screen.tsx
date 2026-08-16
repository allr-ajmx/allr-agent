import { useCallback } from 'react'

import { OnboardingScreen } from '@/app/onboarding/onboarding-screen'
import { ProviderConnectOverlay } from '@/app/settings/provider-connect-overlay'
import { MobileSurfaceShell } from '@/app/shell/mobile-surface-shell'
import { SidebarProvider } from '@/app/shell/sidebar'
import { NotificationStack } from '@/components/notifications'
import { useKeyboardInset } from '@/hooks/use-keyboard-inset'
import { useStore } from '@/store/atom'
import { $onboardingActive } from '@/store/onboarding'
import { returnHome } from '@/store/windows'

// Native activity-screen root (MJX-141). On Android, the windowable surfaces
// (Settings / Command Center / Profiles / Cron) open in ONE native screen activity (a
// fresh WebView carrying `?win=activity`, launched from `src-tauri/src/window.rs`).
// `app.tsx` mounts this instead of the full chat shell (MobileController).
//
// The chrome (Back · title-menu · surface, derived live from the route) lives in the
// shared `MobileSurfaceShell` so the iOS / generic-mobile in-app overlay
// (mobile-controller) renders these surfaces with the exact same layout (MJX-203).
// Here the Back / open-session actions map to `returnHome` (finish the native scene →
// back to the sessions activity), which is also what the hardware back key does.
//
// The WebView shares the single Rust core, but its JS/connection is fresh:
// `main.tsx` auto-reconnects on boot, so — like SecondaryWindowRoot —
// `MobileSurfaceShell` waits for `$connectionPhase` before rendering the surface.
export function ActivityScreenRoot() {
  // Publishes the visual-viewport vars `html.is-mobile #root` is sized from
  // (styles.css). Mounted HERE rather than left to `MobileSurfaceShell`: the
  // onboarding branch below returns before that shell, and its API-key fields are
  // exactly the kind of focused input that moves the visual viewport.
  useKeyboardInset()

  // Opening a session belongs in the main chat activity, so "open session" here just
  // returns Home (the sessions activity) rather than routing within this scene.
  const goHome = useCallback(() => {
    void returnHome()
  }, [])

  const onboarding = useStore($onboardingActive)

  // Settings ▸ Providers lives on this surface, and both of its setup
  // affordances are state-driven: a provider row sets `$connectProvider`, and
  // Settings ▸ Model's "Set up provider" falls through to `openOnboarding()`.
  // Neither renders anything on its own, so without these two mounted the
  // triggers this screen DOES show would silently do nothing here while working
  // in the chat shell (which mounts both).
  if (onboarding) {
    return (
      <SidebarProvider>
        <OnboardingScreen />
        <NotificationStack />
      </SidebarProvider>
    )
  }

  return (
    <SidebarProvider>
      <MobileSurfaceShell onHome={goHome} onOpenSession={goHome} />
      <ProviderConnectOverlay />
      <NotificationStack />
    </SidebarProvider>
  )
}
