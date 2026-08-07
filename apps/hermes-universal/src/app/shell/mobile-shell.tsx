import { WorkspaceRoutes } from '@/app/contrib/panes'
import { useKeyboardInset } from '@/hooks/use-keyboard-inset'

import { useRestoreLastSession } from './hooks/use-restore-last-session'
import { MobileSidebar } from './mobile-sidebar'
import { MobileTopBar } from './mobile-top-bar'
import { MobileWorkspace } from './mobile-workspace'
import { useSidebar } from './sidebar'

// The root mobile layout. A phone takes this branch (IS_MOBILE) instead of the
// docked tile tree or the sub-768 AppShell drawer, so the touch layout is never
// entangled with the desktop drag/resize surfaces.
//
// Composition: the top bar, the app route table (WorkspaceRoutes → the chat view
// ChatScreen, which owns the thread + docked composer), and the left sidebar as a
// Sheet drawer opened from the top bar's button. Mirrors the old AppShell phone
// branch, under our own top bar + mobile sizing.
//
// Sizing: the phone reads the whole UI up a step for readability, done the
// natural way — the `--dt-base-size` rem token is bumped for `html.is-mobile`
// in styles.css, so every rem-based size reflows larger (not a CSS zoom, which
// scales unevenly). Safe area: the top bar owns the top inset; the composer owns
// its own bottom (home indicator) and side insets; the soft keyboard lifts the
// content via --keyboard-inset.

export function MobileShell() {
  // Publishes --keyboard-inset / data-keyboard-open, consumed by the lift below.
  useKeyboardInset()
  // Opens the chat you were last in once the gateway is up, instead of leaving
  // the phone on the blank new session it always cold-starts with.
  useRestoreLastSession()
  const { openMobile, setOpenMobile, openMobileRight, setOpenMobileRight } = useSidebar()

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <MobileTopBar />

      {/* The routed content (chat view + full-page views). ChatScreen provides
          its own `.chat` positioning context for the docked composer; the
          margin-bottom lifts the whole view — composer included — above the soft
          keyboard when it's open. */}
      <div className="flex min-h-0 flex-1 flex-col" style={{ marginBottom: 'var(--keyboard-inset, 0px)' }}>
        <WorkspaceRoutes />
      </div>

      {/* The sidebar — opened from the top bar's left button. A full-screen
          sibling like the Workspace, not a drawer: a long list is the last thing
          that wants a third of the screen spent on a dimmed backdrop, and the
          app's two halves should not have two different shapes. */}
      {openMobile && <MobileSidebar onClose={() => setOpenMobile(false)} />}

      {/* The Workspace — opened from the top bar's right button. A full-screen
          sibling of the chat rather than a drawer: review, files, editor and the
          terminal each need the whole width and their own keyboard handling. */}
      {openMobileRight && <MobileWorkspace onClose={() => setOpenMobileRight(false)} />}
    </div>
  )
}
