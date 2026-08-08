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

import { lazy, type ReactNode, Suspense, useMemo } from 'react'
import { Route, Routes } from 'react-router-dom'

import { ChatScreen } from '@/app/chat/chat-screen'
import { RightSidebarPane } from '@/app/right-pane'
import { PreviewRail } from '@/app/right-pane/preview/preview-rail'
import { ReviewPane } from '@/app/right-pane/review'
import { TerminalArea } from '@/app/right-pane/terminal/terminal-area'
import { ARTIFACTS_ROUTE, contributedRoutes, MESSAGING_ROUTE, ROUTES_AREA, SKILLS_ROUTE } from '@/app/routes'
import { ContribBoundary, ContribRender } from '@/contrib/react/boundary'
import { useContributions } from '@/contrib/react/use-contributions'
import { registry } from '@/contrib/registry'
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
 *  old AppShell's `previewFile`. Exported so the mobile Workspace opens files
 *  through the same pipeline instead of growing a third copy of it. */
export function previewFile(path: string) {
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

// ── The app's own pages, as `routes` contributions (MJX-52) ─────────────────
// Registering them here means the route table, the page tiles (app/chat/
// route-tile.tsx) and any future page host all read ONE list, and a plugin page
// is structurally identical to Capabilities. `title` is what a page tile's tab
// shows; it stays in English like the other core contribution titles (the pane
// titles above), since tab titles aren't localized yet.
registry.registerMany([
  {
    area: ROUTES_AREA,
    data: { path: SKILLS_ROUTE },
    id: 'skills',
    order: 0,
    render: () => <SkillsPage />,
    title: 'Capabilities'
  },
  {
    area: ROUTES_AREA,
    data: { path: MESSAGING_ROUTE },
    id: 'messaging',
    order: 10,
    render: () => <MessagingPage />,
    title: 'Messaging'
  },
  {
    area: ROUTES_AREA,
    data: { path: ARTIFACTS_ROUTE },
    id: 'artifacts',
    order: 20,
    render: () => <ArtifactsPage />,
    title: 'Artifacts'
  }
])

/** The `workspace` pane — the app route table (chat + full-page views). Full
 *  pages mark the zone body `data-zone-no-header` for the drawer layout, which
 *  has no tab strip of its own; in the layout tree the strip STAYS on a page —
 *  with sessions as tiles it is the way back to them. Overlay routes fall through
 *  to the chat backdrop (rendered as MobileController portals over the shell). */
export function WorkspaceRoutes() {
  // Subscribed, not read once: a plugin that loads after first paint (disk door,
  // hot reload) gets its page without remounting the core route table. The
  // validated list comes from `contributedRoutes()` — the same helper
  // `isContributedPath` uses — so a path can never be a route here and a session
  // id there.
  const contributions = useContributions(ROUTES_AREA)
  const pageRoutes = useMemo(() => contributedRoutes(contributions), [contributions])

  return (
    <Routes>
      {/* Every page — the app's own and contributed alike — renders as a full
          page inside the workspace pane, each behind its own blast wall, BEFORE
          the catch-all below. */}
      {pageRoutes.map(route => (
        <Route
          element={
            <WorkspacePage
              view={
                <ContribBoundary id={route.key}>
                  <ContribRender render={route.render} />
                </ContribBoundary>
              }
            />
          }
          key={route.key}
          path={route.path}
        />
      ))}
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
      {/* The chat, as ONE route node covering both "/" (a fresh chat) and
          "/<sessionId>" (a resumed one). It used to be two — a `path="/"` route
          above the pages and this splat below — and those are different
          positions in the element tree, so React Router unmounted and remounted
          the entire chat on every session switch. That teardown is the repaint
          the phone shows as a flash: thread, scroll position and composer all
          rebuilt to display the same view. A splat matches an empty remainder,
          so "/" needs no route of its own. */}
      <Route element={<ChatScreen />} path="*" />
    </Routes>
  )
}
