/**
 * Real-data pane surfaces for the layout-tree contribution root.
 *
 * Universal difference from desktop's `app/contrib/panes.tsx`: universal's
 * surfaces are SELF-WIRED (each reads its own stores/hooks) rather than
 * prop-drilled through a controller `WiringActions` bag, so there is no
 * `WiredPane`/`WiringApi` indirection here — each pane contribution renders its
 * component directly. The workspace pane hosts the app's route table
 * (chat + full-page views); overlay routes (settings/command-center/…) still
 * render as MobileController portals over the shell, so they resolve to the
 * chat backdrop here.
 */

import { lazy, type ReactNode, Suspense } from 'react'
import { Route, Routes } from 'react-router-dom'

import { ChatScreen } from '@/app/chat/chat-screen'
import { RightSidebarPane } from '@/app/right-pane'
import { PreviewRail } from '@/app/right-pane/preview/preview-rail'
import { ReviewPane } from '@/app/right-pane/review'
import { TerminalArea } from '@/app/right-pane/terminal/terminal-area'
import { normalizeOrLocalPreviewTarget } from '@/lib/local-preview'
import { useStore } from '@/store/atom'
import { $currentCwd } from '@/store/chat'
import { setCurrentSessionPreviewTarget } from '@/store/preview'

// Dev-only markdown/KaTeX perf bench — same build-time guard as MobileController
// so it never reaches a release bundle. Kept reachable from the workspace pane.
const BENCH_ENABLED = import.meta.env.DEV || import.meta.env.VITE_ENABLE_BENCH === 'true'

const MarkdownBench = BENCH_ENABLED
  ? lazy(() => import('@/dev/markdown-bench').then(module => ({ default: module.MarkdownBench })))
  : null

/** Open a file from the tree in the real preview pipeline. Verbatim from the
 *  old AppShell's `previewFile`. */
function previewFile(path: string) {
  void normalizeOrLocalPreviewTarget(path, $currentCwd.get() || undefined)
    .then(target => {
      if (target) {
        setCurrentSessionPreviewTarget(target, 'file-browser', path)
      }
    })
    .catch(() => undefined)
}

/** The `files` pane — the file browser; activating a file opens it in preview. */
export function FilesPane() {
  return <RightSidebarPane onActivateFile={previewFile} onActivateFolder={previewFile} />
}

/** The `preview` pane — the tabbed file viewer/editor rail (its own tab strip). */
export function PreviewRailPane() {
  return <PreviewRail />
}

/** The `review` pane — the git diff sidebar, keyed on the cwd so switching
 *  projects rebuilds the diff state (mirrors the old AppShell's keyed mount). */
export function ReviewPaneContent() {
  const currentCwd = useStore($currentCwd)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ReviewPane key={currentCwd || 'no-cwd'} />
    </div>
  )
}

/** The `terminal` pane — the multi-terminal integrated shell area. */
export function TerminalPane() {
  return <TerminalArea />
}

// Full-page views load on demand (same split as MobileController).
const SkillsPage = lazy(async () => ({ default: (await import('@/app/skills')).SkillsView }))
const MessagingPage = lazy(async () => ({ default: (await import('@/app/messaging')).MessagingView }))
const ArtifactsPage = lazy(async () => ({ default: (await import('@/app/artifacts')).ArtifactsView }))

function WorkspacePage({ view }: { view: ReactNode }) {
  return (
    <div className="contents" data-zone-no-header>
      <Suspense fallback={null}>{view}</Suspense>
    </div>
  )
}

/** The `workspace` pane — the app route table (chat + full-page views). Full
 *  pages mark the zone body `data-zone-no-header` so the zone's tab bar stands
 *  down while a page shows (mirrors `headerVeto`). Overlay routes fall through
 *  to the chat backdrop (rendered as MobileController portals over the shell). */
export function WorkspaceRoutes() {
  return (
    <Routes>
      <Route element={<ChatScreen />} path="/" />
      <Route element={<WorkspacePage view={<SkillsPage />} />} path="/skills" />
      <Route element={<WorkspacePage view={<MessagingPage />} />} path="/messaging" />
      <Route element={<WorkspacePage view={<ArtifactsPage />} />} path="/artifacts" />
      {MarkdownBench && (
        <Route
          element={
            <Suspense fallback={null}>
              <MarkdownBench />
            </Suspense>
          }
          path="/dev/markdown-bench"
        />
      )}
      <Route element={<ChatScreen />} path="*" />
    </Routes>
  )
}
