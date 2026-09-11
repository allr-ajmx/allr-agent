import { TITLEBAR_AREAS } from '@/app/contrib/surfaces'
import { Codicon } from '@/components/ui/codicon'
import { Slot } from '@/contrib/react/slot'
import { useI18n } from '@/i18n'
import { useStore } from '@/store/atom'
import { openCommandPalette } from '@/store/command-palette'
import { $hapticsMuted } from '@/store/haptics'
import {
  $leftEdgeOpen,
  $panesFlipped,
  $rightEdgeOpen,
  toggleLeftEdge,
  togglePanesFlipped,
  toggleRightEdge
} from '@/store/layout'
import { openAppRoute } from '@/store/windows'

import { DownloadsTray } from './downloads-tray'
import { LayoutMenu } from './layout-menu'
import { TitlebarButton } from './titlebar-button'
import { WindowControls } from './window-controls'

// Custom window chrome: a transparent, draggable top strip (frameless window).
// Left cluster: sidebar toggle + swap-panes. Right cluster: haptics mute,
// shortcuts, settings, right-sidebar toggle — then the min/max/close controls.
// Icons are VS Code codicons — the SAME pack + glyph names hermes-desktop uses
// for its titlebar — so the two apps' chrome matches exactly. Toolbar clusters
// show once connected; the window controls + drag band are always present.
// Desktop-Tauri only (mounted behind IS_DESKTOP in MobileController).
export function Titlebar({ connected }: { connected: boolean }) {
  const { t } = useI18n()
  const hapticsMuted = useStore($hapticsMuted)
  const panesFlipped = useStore($panesFlipped)
  // Positional, not pane-identity: each cluster's toggle drives whatever sits on
  // its own side of main, so a swap never leaves a button lying about its pane.
  const leftEdgeOpen = useStore($leftEdgeOpen)
  const rightEdgeOpen = useStore($rightEdgeOpen)

  return (
    <div
      // Opaque top chrome with a bottom border — a REAL layout row (in-flow,
      // reserves its height) at the very top of the shell, not an overlay, so it
      // can never cover the content below (the tree zone tab strips / session
      // titles sit right beneath it). The empty middle is a window drag region;
      // the button clusters are interactive.
      className="relative z-40 flex h-(--titlebar-height) w-full shrink-0 items-center gap-0.5 border-b border-(--ui-stroke-tertiary) bg-(--ui-bg-chrome) px-2 select-none"
    >
      {connected && (
        <div className="pointer-events-auto flex items-center gap-0.5">
          <TitlebarButton
            actionId="view.toggleSidebar"
            active={leftEdgeOpen}
            label={leftEdgeOpen ? t.titlebar.hideSidebar : t.titlebar.showSidebar}
            onClick={toggleLeftEdge}
          >
            <Codicon name="layout-sidebar-left" />
          </TitlebarButton>
          <TitlebarButton
            actionId="view.flipPanes"
            active={panesFlipped}
            label={t.titlebar.swapSidebarSides}
            onClick={togglePanesFlipped}
          >
            <Codicon name="arrow-swap" />
          </TitlebarButton>
          <TitlebarButton actionId="nav.commandPalette" label={t.titlebar.searchTitle} onClick={openCommandPalette}>
            <Codicon name="search" />
          </TitlebarButton>
          <Slot area={TITLEBAR_AREAS.left} />
        </div>
      )}

      {/* The session title lives inside the chat pane (see chat-header.tsx),
          aligned into THIS band. The left portion of the middle passes clicks
          through to that title (pointer-events-none, inherited); the right
          portion stays a draggable window region for moving the frameless
          window. Title is left-aligned so it never falls under the drag strip. */}
      <div className="pointer-events-auto h-full flex-[4]" data-tauri-drag-region />

      {/* Contributed center content sits BETWEEN the two drag bands in its own
          non-drag container, so clicks reach it instead of moving the window.
          `shrink-0` with no basis means an empty area costs zero width and the
          drag strip is exactly what it was before. */}
      <div className="pointer-events-auto flex h-full shrink-0 items-center gap-0.5">
        <Slot area={TITLEBAR_AREAS.center} />
      </div>

      <div className="pointer-events-auto h-full flex-1" data-tauri-drag-region />

      {connected && (
        <div className="pointer-events-auto flex items-center gap-0.5">
          <Slot area={TITLEBAR_AREAS.right} />
          {/* Gateway files being written to this device. Always present, the way
              a browser's download button is: the panel is the only route back to
              a finished transfer, so a button that came and went would hide the
              history it exists to show. Activity is carried by the badge, not by
              the button's presence. It lists peers' downloads too (rule 21), so
              a file queued from the HUD lands here. */}
          <DownloadsTray />
          {/* Layout / tile-preview button — pick a workspace preset (Default /
              Focus / Terminal deck / Quad) or reset the layout. */}
          <LayoutMenu />
          <TitlebarButton
            active={hapticsMuted}
            label={hapticsMuted ? t.titlebar.unmuteHaptics : t.titlebar.muteHaptics}
            onClick={() => $hapticsMuted.set(!$hapticsMuted.get())}
          >
            <Codicon name={hapticsMuted ? 'mute' : 'unmute'} />
          </TitlebarButton>
          {/* No HUD button here. The HUD itself is untouched — `view.toggleHud`
              is still a keybind (`lib/keybinds/actions.ts`, mod+shift+H, claimed
              globally) and `app/hooks/use-keybinds.ts` still runs it — only the
              titlebar affordance is gone, by request. Note that the chord is
              currently the ONLY route in: there is no command-palette entry for
              it, so deleting the binding would strand the feature. */}
          <TitlebarButton
            actionId="keybinds.openPanel"
            label={t.titlebar.openKeybinds}
            onClick={() => openAppRoute('/settings/shortcuts')}
          >
            <Codicon name="keyboard" />
          </TitlebarButton>
          <TitlebarButton
            actionId="nav.settings"
            label={t.titlebar.openSettings}
            onClick={() => openAppRoute('/settings')}
          >
            <Codicon name="settings-gear" />
          </TitlebarButton>
          <TitlebarButton
            actionId="view.toggleRightSidebar"
            active={rightEdgeOpen}
            label={rightEdgeOpen ? t.titlebar.hideRightSidebar : t.titlebar.showRightSidebar}
            onClick={toggleRightEdge}
          >
            <Codicon name="layout-sidebar-right" />
          </TitlebarButton>
        </div>
      )}

      <div className="pointer-events-auto flex items-center">
        <WindowControls />
      </div>
    </div>
  )
}
