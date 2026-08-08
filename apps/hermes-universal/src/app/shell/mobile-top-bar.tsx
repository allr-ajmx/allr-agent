import { useLocation, useNavigate } from 'react-router-dom'

import { ChatTitle } from '@/app/chat/chat-title'
import { TITLEBAR_AREAS } from '@/app/contrib/surfaces'
import { isWorkspacePagePath, NEW_CHAT_ROUTE } from '@/app/routes'
import { Codicon } from '@/components/ui/codicon'
import { Slot } from '@/contrib/react/slot'
import { useI18n } from '@/i18n'

import { MobileChromeBar } from './mobile-chrome-bar'
import { useSidebar } from './sidebar'
import { TitlebarButton } from './titlebar-button'

// The mobile top bar. Styled after the desktop titlebar chrome (same border /
// --ui-bg-chrome / codicon vocabulary) but as a touch-friendly row that owns the
// safe-area top inset — the chrome fills the status-bar area and the controls sit
// below the notch. First increment hosts only the left-sidebar toggle button;
// more buttons (search / settings / …) are added here later.
//
// `titleBar.left` / `titleBar.right` are mounted here too, so a plugin chip lands
// on the phone exactly as it does in the desktop titlebar. `titleBar.center` is
// deliberately NOT mounted: on mobile ChatTitle owns all the middle slack (there
// is no header row), and a contributed node there would fight it for width.
export function MobileTopBar() {
  const { t } = useI18n()
  const { toggleMobile, toggleMobileRight } = useSidebar()
  const navigate = useNavigate()
  // Derived from the path rather than read off `$workspacePage`: only the
  // desktop controller keeps that atom in sync, and this bar is the phone's.
  const onPage = isWorkspacePagePath(useLocation().pathname)

  return (
    <MobileChromeBar
      // Active session title — the same clickable pill (session actions menu)
      // the desktop chat header uses. On mobile the fixed layout has no header
      // row, so it lives here.
      // Fills the row it is given: the title is this bar's only wide target and
      // the way into the session menu, so it takes the full height and width and
      // starts at the left edge — matching the title menu on every second screen.
      center={<ChatTitle className="h-full w-full justify-start" />}
      left={
        <>
          {/* On a full page the useful control in this corner is the way out, so
              it becomes Back — to the chat, which is the phone's one home. On the
              chat itself it opens the sidebar.

              `history` rather than a speech bubble or a hamburger: the button
              names what is behind it (your past chats) instead of the mechanism,
              and a bubble read as "messages" next to an app that is nothing but
              messages. The icon size is set via Codicon's `size` (inline
              font-size) — it beats TitlebarButton's base `[&_.codicon]` rule,
              which an equal-specificity class override can't. */}
          {onPage ? (
            <TitlebarButton className="size-4" label={t.common.back} onClick={() => navigate(NEW_CHAT_ROUTE)}>
              <Codicon name="chevron-left" size="1.4rem" />
            </TitlebarButton>
          ) : (
            <TitlebarButton className="size-4" label={t.titlebar.showSidebar} onClick={toggleMobile}>
              <Codicon name="history" size="1.4rem" />
            </TitlebarButton>
          )}
          <Slot area={TITLEBAR_AREAS.left} />
        </>
      }
      right={
        <>
          {/* Right-sidebar toggle → the Workspace. Uses the drawer / right-panel
              glyph (not a gear — this opens a panel, not settings). */}
          <Slot area={TITLEBAR_AREAS.right} />
          <TitlebarButton className="size-4" label={t.titlebar.showRightSidebar} onClick={toggleMobileRight}>
            <Codicon name="layout-sidebar-right" size="1.4rem" />
          </TitlebarButton>
        </>
      }
    />
  )
}
