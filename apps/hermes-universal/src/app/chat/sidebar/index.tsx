import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import { $panesFlipped, $sidebarOpen, $sidebarOverlayMounted } from '@/store/layout'

import { SidebarNavRail } from './nav-rail'
import { ProfileRail } from './profile-switcher'
import { SidebarScrollBody } from './sidebar-content'

// The rich left sidebar (ported from desktop `app/chat/sidebar`). Rendered two
// ways: as the docked/hover-reveal `pane` (md+ desktop) and as the `sheet`
// drawer (phones). The `pane` variant paints the open/closed surface + edge
// border that draws the sidebar↔main division *through* the transparent titlebar
// (Requirement #1); the `sheet` variant lets the drawer own its chrome.
//
// Layout: top nav rail (New session · Capabilities · Messaging · Artifacts) →
// scroll body (search · pinned · sessions/projects · messaging groups · cron) →
// profile-rail footer.

export interface ChatSidebarProps {
  variant?: 'pane' | 'sheet'
  /** Drawer close (sheet variant) after a navigation. */
  onNavigate?: () => void
}

function SidebarBody({ variant, onNavigate }: { variant: 'pane' | 'sheet'; onNavigate?: () => void }) {
  return (
    <>
      {/* Top nav rail (Phase 2): the 4 desktop items under the transparent titlebar. */}
      <SidebarNavRail onNavigate={onNavigate} variant={variant} />

      {/* Scroll body: search + pinned + sessions/projects + messaging + cron. */}
      <SidebarScrollBody onNavigate={onNavigate} />

      {/* Fixed footer: the profile rail. */}
      <div className="shrink-0 px-2 pb-1 pt-0.5">
        <ProfileRail />
      </div>
    </>
  )
}

export function ChatSidebar({ variant = 'pane', onNavigate }: ChatSidebarProps) {
  const sidebarOpen = useStore($sidebarOpen)
  const overlayMounted = useStore($sidebarOverlayMounted)
  const panesFlipped = useStore($panesFlipped)

  // In the drawer the sheet controls visibility; in the pane we mount content
  // whenever the sidebar is open OR floating as a hover-reveal overlay.
  const contentVisible = variant === 'sheet' || sidebarOpen || overlayMounted

  if (variant === 'sheet') {
    // Pad the drawer content into the safe area top + bottom (status bar / home
    // indicator) using the reliable published vars. The surface background covers
    // the padding box, so the drawer still fills to the screen edges while the
    // nav rail and profile-rail footer clear the unsafe zones.
    return (
      <div
        className="flex h-full min-h-0 flex-col bg-(--ui-sidebar-surface-background)"
        style={{ paddingTop: 'var(--safe-area-inset-top)', paddingBottom: 'var(--safe-area-inset-bottom)' }}
      >
        <SidebarBody onNavigate={onNavigate} variant="sheet" />
      </div>
    )
  }

  return (
    <div
      className={cn(
        'relative flex h-full min-w-0 flex-col overflow-hidden border-t-0 border-b-0 text-foreground transition-none',
        panesFlipped ? 'border-l border-r-0' : 'border-r border-l-0',
        contentVisible
          ? 'border-(--sidebar-edge-border) bg-(--ui-sidebar-surface-background) opacity-100'
          : 'pointer-events-none border-transparent bg-transparent opacity-0'
      )}
    >
      {contentVisible && <SidebarBody variant="pane" />}
    </div>
  )
}
