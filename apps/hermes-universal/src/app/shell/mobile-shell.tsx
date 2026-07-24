import { WorkspaceRoutes } from '@/app/contrib/panes'
import { ChatSidebar } from '@/app/chat/sidebar'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import { useKeyboardInset } from '@/hooks/use-keyboard-inset'

import { MobileRightPanel } from './mobile-right-panel'
import { MobileTopBar } from './mobile-top-bar'
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

      {/* Left sidebar as a drawer — opened by the top bar's sidebar button
          (useSidebar().toggleMobile). One shared <ChatSidebar>, sheet variant. */}
      <Sheet onOpenChange={setOpenMobile} open={openMobile}>
        {/* No close X — on mobile it lands in the status-bar/notch area and is
            redundant (tap outside / swipe to dismiss). */}
        <SheetContent className="w-[19rem] gap-0 p-0" showCloseButton={false} side="left">
          <ChatSidebar onNavigate={() => setOpenMobile(false)} variant="sheet" />
        </SheetContent>
      </Sheet>

      {/* Right sidebar drawer — opened from the top bar's right button. Hosts the
          Status / Files tabs. Same tap-outside / swipe dismissal, no close X. */}
      <Sheet onOpenChange={setOpenMobileRight} open={openMobileRight}>
        <SheetContent className="w-[19rem] gap-0 p-0" showCloseButton={false} side="right">
          <MobileRightPanel />
        </SheetContent>
      </Sheet>
    </div>
  )
}
