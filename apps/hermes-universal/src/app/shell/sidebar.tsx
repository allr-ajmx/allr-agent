import { createContext, type ReactNode, useContext, useMemo, useState } from 'react'

import { ChatSidebar } from '@/app/chat/sidebar'
import { RightSidebarPane } from '@/app/right-pane'
import { PreviewRail } from '@/app/right-pane/preview/preview-rail'
import { ReviewPane } from '@/app/right-pane/review'
import { TerminalArea } from '@/app/right-pane/terminal/terminal-area'
import { Pane, PaneMain, PaneShell } from '@/components/pane-shell'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import { useMediaQuery } from '@/hooks/use-media-query'
import { Menu } from '@/lib/icons'
import { normalizeOrLocalPreviewTarget } from '@/lib/local-preview'
import { IS_DESKTOP } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import { $currentCwd } from '@/store/chat'
import {
  $panesFlipped,
  $rightSidebarOpen,
  $terminalOpen,
  CHAT_SIDEBAR_PANE_ID,
  FILE_TREE_DEFAULT_WIDTH,
  FILE_TREE_MAX_WIDTH,
  FILE_TREE_MIN_WIDTH,
  FILE_TREE_PANE_ID,
  PREVIEW_DEFAULT_WIDTH,
  PREVIEW_MAX_WIDTH,
  PREVIEW_MIN_WIDTH,
  PREVIEW_PANE_ID,
  setSidebarOverlayMounted,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  TERMINAL_COLUMN_DEFAULT_WIDTH,
  TERMINAL_COLUMN_MAX_WIDTH,
  TERMINAL_COLUMN_MIN_WIDTH,
  TERMINAL_COLUMN_PANE_ID,
  TERMINAL_DEFAULT_HEIGHT,
  TERMINAL_MAX_HEIGHT,
  TERMINAL_MIN_HEIGHT,
  TERMINAL_PANE_ID
} from '@/store/layout'
import { $previewTabs, setCurrentSessionPreviewTarget } from '@/store/preview'
import { $reviewOpen, REVIEW_PANE_ID } from '@/store/review'

// The rich chat sidebar (ported from desktop) renders as a resizable/hover-reveal
// docked PANE on md+ and as a left `Sheet` DRAWER on phones — one shared
// <ChatSidebar>, two presentations (responsive discipline #5). Below this
// breakpoint the drawer takes over, so the pane never needs desktop's
// force-collapse; the pane's own hover-reveal covers the toggle-closed case.
const SIDEBAR_WIDE_MEDIA_QUERY = '(min-width: 768px)'

interface SidebarCtx {
  openMobile: boolean
  setOpenMobile: (v: boolean) => void
  toggleMobile: () => void
  // Right drawer (mobile). Symmetric with the left; its content is a later step,
  // so the toggle is wired but no drawer is mounted yet.
  openMobileRight: boolean
  setOpenMobileRight: (v: boolean) => void
  toggleMobileRight: () => void
}

const SidebarContext = createContext<SidebarCtx | null>(null)

export function useSidebar(): SidebarCtx {
  const ctx = useContext(SidebarContext)

  if (!ctx) {
    throw new Error('useSidebar must be used within <SidebarProvider>')
  }

  return ctx
}

export function SidebarProvider({ children }: { children: ReactNode }) {
  const [openMobile, setOpenMobile] = useState(false)
  const [openMobileRight, setOpenMobileRight] = useState(false)

  const value = useMemo<SidebarCtx>(
    () => ({
      openMobile,
      setOpenMobile,
      toggleMobile: () => setOpenMobile(v => !v),
      openMobileRight,
      setOpenMobileRight,
      toggleMobileRight: () => setOpenMobileRight(v => !v)
    }),
    [openMobile, openMobileRight]
  )

  return <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>
}

/** Hamburger that opens the phone drawer. Screens drop this into their own header (usually `md:hidden`). */
export function SidebarTrigger({ className }: { className?: string }) {
  const { toggleMobile } = useSidebar()

  return (
    <Button aria-label="Open navigation" className={className} onClick={toggleMobile} size="icon-sm" variant="ghost">
      <Menu className="size-5" />
    </Button>
  )
}

/** The responsive frame: docked pane on md+, drawer on phones, one main slot. */
/** Open a file from the tree in the real preview pipeline. Verbatim from
 *  desktop's app/contrib/panes.tsx. */
function previewFile(path: string) {
  void normalizeOrLocalPreviewTarget(path, $currentCwd.get() || undefined)
    .then(target => {
      if (target) {
        setCurrentSessionPreviewTarget(target, 'file-browser', path)
      }
    })
    .catch(() => undefined)
}

export function AppShell({ children }: { children: ReactNode }) {
  // Desktop always uses the docked shell (resizable/hover-reveal panes + the
  // titlebar-offset content), regardless of window width. Without this a sub-768px
  // desktop window falls into the phone branch, which has no docked sidebars, no
  // titlebar offset, and no hamburger (the chat's mobile header is IS_DESKTOP-
  // hidden) — leaving no sidebars and no usable top bar. Mobile/web keep the
  // responsive drawer behavior below 768px.
  const mediaWide = useMediaQuery(SIDEBAR_WIDE_MEDIA_QUERY)
  const wide = IS_DESKTOP || mediaWide
  const { openMobile, setOpenMobile } = useSidebar()
  const panesFlipped = useStore($panesFlipped)
  const rightOpen = useStore($rightSidebarOpen)
  const terminalOpen = useStore($terminalOpen)
  // The editor pane only shows once a file is open; the file tree shows whenever
  // the right sidebar is open. Closing the right sidebar hides both (main fills).
  const hasPreview = useStore($previewTabs).length > 0
  // The review (git diff) pane is its own column, revealed by ⌘G / $reviewOpen
  // independently of the right-sidebar toggle — desktop parity.
  const reviewOpen = useStore($reviewOpen)
  const currentCwd = useStore($currentCwd)
  // The file-tree + editor rails dock opposite the chat sidebar.
  const railSide = panesFlipped ? 'left' : 'right'

  if (!wide) {
    return (
      <div className="flex h-full min-h-0">
        <main className="flex min-h-0 min-w-0 flex-1 flex-col pt-[env(safe-area-inset-top)]">{children}</main>

        <Sheet onOpenChange={setOpenMobile} open={openMobile}>
          <SheetContent className="w-[19rem] gap-0 p-0" side="left">
            <ChatSidebar onNavigate={() => setOpenMobile(false)} variant="sheet" />
          </SheetContent>
        </Sheet>
      </div>
    )
  }

  // Terminal placement: while the right sidebar is open it's a bottom-row pane
  // spanning the open right columns (editor + file tree width); when the right
  // sidebar is closed it's a full-height right column at a preset, independently
  // resizable width. Both are independent of the right-sidebar toggle.
  const terminalBottomActive = terminalOpen && rightOpen
  const terminalColumnActive = terminalOpen && !rightOpen

  return (
    <PaneShell className="h-full">
      <Pane
        defaultOpen
        hoverReveal
        id={CHAT_SIDEBAR_PANE_ID}
        maxWidth={SIDEBAR_MAX_WIDTH}
        minWidth={SIDEBAR_DEFAULT_WIDTH}
        onOverlayActiveChange={setSidebarOverlayMounted}
        overlayWidth={SIDEBAR_DEFAULT_WIDTH}
        resizable
        side={panesFlipped ? 'right' : 'left'}
        width={SIDEBAR_DEFAULT_WIDTH}
      >
        <ChatSidebar variant="pane" />
      </Pane>

      <PaneMain>
        {/* Push routed content below the transparent titlebar overlay on desktop
            Tauri; the pane background still reaches y=0 so the division shows. */}
        <div className={cn('flex min-h-0 flex-1 flex-col', IS_DESKTOP && 'pt-(--titlebar-height)')}>{children}</div>
      </PaneMain>

      {/* Right pane: the tabbed editor (inner, only once a file is open) + the file
          tree (outer/far-right edge, matching desktop). Both collapse to 0 when the
          right-sidebar toggle is off, so main fills the space. */}
      <Pane
        disabled={!rightOpen || !hasPreview}
        divider
        id={PREVIEW_PANE_ID}
        maxWidth={PREVIEW_MAX_WIDTH}
        minWidth={PREVIEW_MIN_WIDTH}
        resizable
        side={railSide}
        width={PREVIEW_DEFAULT_WIDTH}
      >
        {rightOpen && hasPreview && <PreviewRail />}
      </Pane>
      <Pane
        disabled={!rightOpen}
        divider
        id={FILE_TREE_PANE_ID}
        maxWidth={FILE_TREE_MAX_WIDTH}
        minWidth={FILE_TREE_MIN_WIDTH}
        resizable
        side={railSide}
        width={FILE_TREE_DEFAULT_WIDTH}
      >
        {rightOpen && <RightSidebarPane onActivateFile={previewFile} onActivateFolder={previewFile} />}
      </Pane>

      {/* Review — the git diff pane (desktop's right-sidebar/review). Its own
          column so it can open independently of the file tree, keyed on the cwd
          so switching projects rebuilds the diff state instead of showing the
          previous repo's files (mirrors desktop's ReviewPaneContent). */}
      <Pane
        disabled={!reviewOpen}
        divider
        id={REVIEW_PANE_ID}
        maxWidth={FILE_TREE_MAX_WIDTH}
        minWidth={FILE_TREE_MIN_WIDTH}
        resizable
        side={railSide}
        width={FILE_TREE_DEFAULT_WIDTH}
      >
        {reviewOpen && (
          <div className={cn('flex h-full min-h-0 flex-col', IS_DESKTOP && 'pt-(--titlebar-height)')}>
            <ReviewPane key={currentCwd || 'no-cwd'} />
          </div>
        )}
      </Pane>

      {/* Terminal — full-height right column when the right sidebar is closed
          (preset width). Pushed below the titlebar so it doesn't intersect it. */}
      <Pane
        disabled={!terminalColumnActive}
        divider
        id={TERMINAL_COLUMN_PANE_ID}
        maxWidth={TERMINAL_COLUMN_MAX_WIDTH}
        minWidth={TERMINAL_COLUMN_MIN_WIDTH}
        resizable
        side={railSide}
        width={TERMINAL_COLUMN_DEFAULT_WIDTH}
      >
        {terminalColumnActive && (
          <div className={cn('h-full min-h-0', IS_DESKTOP && 'pt-(--titlebar-height)')}>
            <TerminalArea />
          </div>
        )}
      </Pane>

      {/* Terminal — bottom row spanning the open right columns when the right
          sidebar is open (width = editor + file tree, or file tree alone). */}
      <Pane
        bottomRow
        disabled={!terminalBottomActive}
        divider
        height={TERMINAL_DEFAULT_HEIGHT}
        id={TERMINAL_PANE_ID}
        maxHeight={TERMINAL_MAX_HEIGHT}
        minHeight={TERMINAL_MIN_HEIGHT}
        resizable
        side={railSide}
      >
        {terminalBottomActive && <TerminalArea />}
      </Pane>
    </PaneShell>
  )
}
