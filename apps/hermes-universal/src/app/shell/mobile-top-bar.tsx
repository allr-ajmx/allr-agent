import { ChatTitle } from '@/app/chat/chat-title'
import { TITLEBAR_AREAS } from '@/app/contrib/surfaces'
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

  return (
    <MobileChromeBar
      // Active session title — the same clickable pill (session actions menu)
      // the desktop chat header uses. On mobile the fixed layout has no header
      // row, so it lives here.
      center={<ChatTitle />}
      left={
        <>
          {/* Left-sidebar toggle. Wired to the drawer state (useSidebar). The icon
              size is set via Codicon's `size` (inline font-size) — it beats
              TitlebarButton's base `[&_.codicon]` rule, which an equal-specificity
              class override can't. Big icon nearly filling the button → tight
              padding. rem tracks the --dt-base-size token. */}
          <TitlebarButton className="size-4" label={t.titlebar.showSidebar} onClick={toggleMobile}>
            <Codicon name="comment-discussion" size="1.4rem" />
          </TitlebarButton>
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
