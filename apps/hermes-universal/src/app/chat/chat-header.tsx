import { ChatTitle } from '@/app/chat/chat-title'
import { SidebarTrigger } from '@/app/shell/sidebar'
import { IS_DESKTOP, IS_MOBILE } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import { $sessionId } from '@/store/chat'
import { $leftEdgeOpen, $panesFlipped, $terminalOpen } from '@/store/layout'
import { $reviewOpen } from '@/store/review'
import { $activeStoredSessionId } from '@/store/session'
import { isSecondaryWindow } from '@/store/windows'

// The chat title header — ported from desktop's in-pane ChatHeader
// (apps/desktop/src/app/chat/index.tsx + `titlebarHeaderBaseClass`). It's the
// chat column's top row, so it tracks the chat pane horizontally (moves with the
// left sidebar) and is chat-only (absent on other routes). The title itself is
// ChatTitle (a clickable pill → session menu), shared with the mobile top bar.
//
// On desktop it's pulled UP (negative margin) into the reserved
// pt-(--titlebar-height) band so it aligns with the window-controls bar rather
// than stacking below it. On the empty new-session view (no session at all) it
// renders nothing (desktop parity — the intro extends up). On MOBILE it isn't
// rendered at all — the title lives in the top bar (see MobileTopBar).
const HEADER_CLASS =
  'relative z-3 flex h-(--titlebar-height) w-full min-w-0 shrink-0 items-center justify-start gap-2 overflow-hidden border-b border-(--ui-stroke-tertiary) bg-(--ui-chat-surface-background)'

// Width of the window's left toggle cluster (sidebar-left / swap / search) plus
// the titlebar's own px-2 — the title must clear it when the chat pane reaches
// the window's left edge (nothing docked on that side). Re-do the sum if a
// button joins the cluster or changes size in `app/shell/titlebar*.tsx`.
const LEFT_CLUSTER_INSET = 'pl-[6.75rem]'

export function ChatHeader() {
  const activeId = useStore($activeStoredSessionId)
  const runtimeSessionId = useStore($sessionId)
  // POSITIONAL, like the titlebar toggles: what matters is whether ANY pane sits
  // on the window's LEFT edge, not whether the chat sidebar is open.
  const leftEdgeOpen = useStore($leftEdgeOpen)
  const panesFlipped = useStore($panesFlipped)
  const reviewOpen = useStore($reviewOpen)
  const terminalOpen = useStore($terminalOpen)
  const leftColumnOpen = leftEdgeOpen || (panesFlipped && (reviewOpen || terminalOpen))

  // A secondary (pop-out) window shows the title in its own titlebar, so the
  // in-chat header stands down (desktop parity).
  if (isSecondaryWindow()) {
    return null
  }

  // Empty new-session view (no stored AND no runtime session): show nothing, so
  // the intro fills the top band (desktop's ChatHeader returns null here).
  if (!activeId && !runtimeSessionId) {
    return null
  }

  // Pull into the reserved titlebar band on desktop; clear the left toggle
  // cluster only when nothing is docked on the left edge (else the cluster sits
  // over that pane, not the chat).
  const headerClass = cn(
    HEADER_CLASS,
    IS_DESKTOP && 'mt-[calc(-1*var(--titlebar-height))]',
    IS_DESKTOP && !leftColumnOpen ? LEFT_CLUSTER_INSET : 'pl-3',
    'pr-3'
  )

  return (
    <header className={headerClass}>
      {/* Mobile carries the sidebar toggle in the top bar (MobileTopBar), so the
          chat header only shows it on non-desktop, non-mobile (small web). */}
      {!IS_DESKTOP && !IS_MOBILE && <SidebarTrigger className="shrink-0" />}
      <div className="min-w-0 flex-1 overflow-hidden">
        <ChatTitle />
      </div>
    </header>
  )
}
