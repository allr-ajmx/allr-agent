import { useStore } from '@nanostores/react'
import { type ComponentProps, useState } from 'react'

import { TreeSkeleton } from '@/components/chat/skeletons'
import { ErrorBoundary } from '@/components/error-boundary'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { SearchField } from '@/components/ui/search-field'
import { Tip } from '@/components/ui/tooltip'
import { useDelayedTrue } from '@/hooks/use-delayed-true'
import { useI18n } from '@/i18n'
import { normalizeOrLocalPreviewTarget } from '@/lib/local-preview'
import { IS_MOBILE } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { $panesFlipped, revealFileInTree } from '@/store/layout'
import { notifyError } from '@/store/notifications'
import { setCurrentSessionPreviewTarget } from '@/store/preview'
import { $effectiveCwd } from '@/store/workspace-events'

import { SidebarPanelLabel } from '../shell/sidebar-label'

import { ProjectTree } from './files/tree'
import { type TreeNode, useProjectTree } from './files/use-project-tree'

interface RightSidebarPaneProps {
  onActivateFile: (path: string) => void
  onActivateFolder: (path: string) => void
  /** Fired once a file has actually been opened in the preview. The pane owns
   *  the path normalisation, so a host that needs to react to an open — the
   *  phone brings its Editor tab forward — observes it here rather than
   *  re-implementing it. */
  onFileOpened?: (path: string) => void
}

export function RightSidebarPane({ onActivateFile, onActivateFolder, onFileOpened }: RightSidebarPaneProps) {
  const { t } = useI18n()
  const r = t.rightSidebar
  const panesFlipped = useStore($panesFlipped)
  // "Browse the FOCUSED chat's working directory" — the tile you last clicked
  // into, not whatever the left sidebar last selected. A bare/detached chat
  // (resolveNewSessionCwd → '') has none, so `$effectiveCwd` hands back the
  // backend workspace root instead of leaving the tree blank; it only stays
  // empty during the boot window before that root has landed.
  const cwd = useStore($effectiveCwd).trim()
  const hasWorkspace = Boolean(cwd)

  const {
    collapseAll,
    collapseNonce,
    data,
    effectiveCwd,
    loadChildren,
    openState,
    refreshRoot,
    rootError,
    rootLoading,
    setNodeOpen
  } = useProjectTree(cwd)

  const cwdName =
    effectiveCwd
      .split(/[\\/]+/)
      .filter(Boolean)
      .pop() ?? effectiveCwd

  const canCollapse = Object.values(openState).some(Boolean)

  const previewFile = async (path: string) => {
    try {
      const preview = await normalizeOrLocalPreviewTarget(path, effectiveCwd || undefined)

      if (!preview) {
        throw new Error(r.couldNotPreview(path))
      }

      setCurrentSessionPreviewTarget(preview, 'file-browser', path)
      onFileOpened?.(path)
    } catch (error) {
      notifyError(error, r.previewUnavailable)
    }
  }

  return (
    <aside
      aria-label={r.aria}
      className={cn(
        'before:pointer-events-none relative flex h-full w-full min-w-0 flex-col overflow-hidden border-(--ui-stroke-secondary) bg-(--ui-sidebar-surface-background) text-(--ui-text-tertiary)',
        panesFlipped
          ? 'border-r shadow-[inset_-0.0625rem_0_0_color-mix(in_srgb,white_18%,transparent)]'
          : 'border-l shadow-[inset_0.0625rem_0_0_color-mix(in_srgb,white_18%,transparent)]'
      )}
    >
      <FilesystemTab
        canCollapse={canCollapse}
        collapseNonce={collapseNonce}
        cwd={effectiveCwd}
        cwdName={cwdName}
        data={data}
        error={rootError}
        hasWorkspace={hasWorkspace}
        loading={rootLoading}
        onActivateFile={onActivateFile}
        onActivateFolder={onActivateFolder}
        onCollapseAll={collapseAll}
        onLoadChildren={loadChildren}
        onNodeOpenChange={setNodeOpen}
        onPreviewFile={previewFile}
        onRefresh={() => void refreshRoot()}
        openState={openState}
      />
    </aside>
  )
}

interface FilesystemTabProps extends FileTreeBodyProps {
  canCollapse: boolean
  cwdName: string
  hasWorkspace: boolean
  onCollapseAll: () => void
  onRefresh: () => void
}

// Sidebar palette + hover-reveal: header actions stay reachable while moving
// from the project label to the action buttons.
const HEADER_ACTION_CLASS =
  'text-sidebar-foreground/70 hover:bg-sidebar-accent! hover:text-sidebar-accent-foreground! focus-visible:ring-sidebar-ring'

// The reveal carries its own coarse-pointer escape, so call sites don't have
// to branch: with no hover to wait for, the button is simply present. That also
// covers a touchscreen desktop, which IS_MOBILE deliberately does not.
const HEADER_ACTION_LABEL_REVEAL = `${HEADER_ACTION_CLASS} pointer-events-none opacity-0 transition-opacity coarse:pointer-events-auto coarse:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 group-focus-within/project-header:pointer-events-auto group-focus-within/project-header:opacity-100 group-hover/project-header:pointer-events-auto group-hover/project-header:opacity-100`

function FilesystemTab({
  canCollapse,
  collapseNonce,
  cwd,
  cwdName,
  data,
  error,
  hasWorkspace,
  loading,
  onActivateFile,
  onActivateFolder,
  onCollapseAll,
  onLoadChildren,
  onNodeOpenChange,
  onPreviewFile,
  onRefresh,
  openState
}: FilesystemTabProps) {
  const { t } = useI18n()
  const r = t.rightSidebar
  const [filter, setFilter] = useState('')

  // No working directory (a bare/detached chat) → no tree, just a terse hint.
  // Switching workspace is a project/worktree action, never a raw folder picker.
  if (!hasWorkspace) {
    return <PaneEmptyState label={r.noProjectOpen} />
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <RightSidebarSectionHeader>
        <div className="flex min-w-0 flex-1">
          <SidebarPanelLabel>{cwdName}</SidebarPanelLabel>
        </div>
        <Tip label={r.refreshTree}>
          <Button
            aria-label={r.refreshTree}
            className={HEADER_ACTION_LABEL_REVEAL}
            disabled={loading}
            onClick={onRefresh}
            size="icon-xs"
            variant="ghost"
          >
            <Codicon name="refresh" size="0.8125rem" spinning={loading} />
          </Button>
        </Tip>
        <Tip label={r.collapseAll}>
          <Button
            aria-label={r.collapseAll}
            className={cn(HEADER_ACTION_CLASS, !canCollapse && 'pointer-events-none opacity-0')}
            disabled={!canCollapse}
            onClick={onCollapseAll}
            size="icon-xs"
            variant="ghost"
          >
            <Codicon name="collapse-all" size="0.8125rem" />
          </Button>
        </Tip>
      </RightSidebarSectionHeader>

      {/* Scrolling a deep tree with a thumb is the worst part of every mobile
          IDE, so the phone gets a filter as its first-class way in. It matches
          only what's been loaded — the tree is lazy and the gateway has no file
          search — which the placeholder says out loud rather than pretending to
          be a project-wide search that silently misses things. */}
      {IS_MOBILE && (
        <div className="shrink-0 px-2 pb-1">
          <SearchField
            aria-label={r.filterFiles}
            containerClassName="w-full"
            onChange={setFilter}
            onClear={() => setFilter('')}
            placeholder={r.filterFiles}
            value={filter}
          />
        </div>
      )}

      {IS_MOBILE && filter.trim() ? (
        <FilterResults
          cwd={cwd}
          data={data}
          onOpenFile={onPreviewFile ?? onActivateFile}
          onOpenFolder={path => {
            setFilter('')
            revealFileInTree(path)
          }}
          query={filter.trim()}
        />
      ) : (
        <FileTreeBody
          collapseNonce={collapseNonce}
          cwd={cwd}
          data={data}
          error={error}
          loading={loading}
          onActivateFile={onActivateFile}
          onActivateFolder={onActivateFolder}
          onLoadChildren={onLoadChildren}
          onNodeOpenChange={onNodeOpenChange}
          onPreviewFile={onPreviewFile}
          onRetry={onRefresh}
          openState={openState}
        />
      )}
    </div>
  )
}

/** Cap the flat result list: past this it stops being scannable and starts being
 *  another tree to scroll. */
const FILTER_RESULT_CAP = 200

function collectMatches(nodes: TreeNode[], needle: string, out: TreeNode[]): TreeNode[] {
  for (const node of nodes) {
    if (out.length >= FILTER_RESULT_CAP) {
      return out
    }

    if (!node.placeholder && node.name.toLowerCase().includes(needle)) {
      out.push(node)
    }

    if (node.children?.length) {
      collectMatches(node.children, needle, out)
    }
  }

  return out
}

/** Flat matches, files and folders alike. Flat beats a filtered tree on a phone:
 *  the answer is one tap away instead of behind the disclosure chain that led to
 *  it. Tapping a folder returns to the tree with that folder revealed. */
function FilterResults({
  cwd,
  data,
  onOpenFile,
  onOpenFolder,
  query
}: {
  cwd: string
  data: TreeNode[]
  onOpenFile: (path: string) => void
  onOpenFolder: (path: string) => void
  query: string
}) {
  const { t } = useI18n()
  const r = t.rightSidebar
  const matches = collectMatches(data, query.toLowerCase(), [])

  if (matches.length === 0) {
    return <PaneEmptyState label={r.filterNoMatches} />
  }

  const root = cwd.replace(/[\\/]+$/, '')

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {matches.map(node => {
        const relative = node.id.startsWith(root) ? node.id.slice(root.length).replace(/^[\\/]+/, '') : node.id
        const parent = relative.slice(0, Math.max(0, relative.lastIndexOf('/')))

        return (
          <button
            className="flex min-h-11 w-full items-center gap-2 px-3 text-left"
            key={node.id}
            onClick={() => (node.isDirectory ? onOpenFolder(node.id) : onOpenFile(node.id))}
            type="button"
          >
            <Codicon
              className="shrink-0 text-(--ui-text-tertiary)"
              name={node.isDirectory ? 'folder' : 'file'}
              size="0.95rem"
            />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm text-foreground">{node.name}</span>
              {parent && <span className="truncate text-[0.7rem] text-(--ui-text-tertiary)">{parent}</span>}
            </span>
          </button>
        )
      })}
    </div>
  )
}

export function RightSidebarSectionHeader({ children, className, ...props }: ComponentProps<'div'>) {
  return (
    <div className={cn('group/project-header flex h-7 shrink-0 items-center px-2.5', className)} {...props}>
      {children}
    </div>
  )
}

interface FileTreeBodyProps {
  collapseNonce: number
  cwd: string
  data: ReturnType<typeof useProjectTree>['data']
  error: string | null
  loading: boolean
  onActivateFile: (path: string) => void
  onActivateFolder: (path: string) => void
  onLoadChildren: (id: string) => void | Promise<void>
  onNodeOpenChange: (id: string, open: boolean) => void
  onPreviewFile?: (path: string) => void
  /** Force-reload the root. The hook also auto-retries while errored, so this
   *  is the impatient-user path. */
  onRetry?: () => void
  openState: ReturnType<typeof useProjectTree>['openState']
}

function FileTreeBody({
  collapseNonce,
  cwd,
  data,
  error,
  loading,
  onActivateFile,
  onActivateFolder,
  onLoadChildren,
  onNodeOpenChange,
  onPreviewFile,
  onRetry,
  openState
}: FileTreeBodyProps) {
  const { t } = useI18n()
  const r = t.rightSidebar
  // Stay blank for a beat, then skeleton — so a fast project switch doesn't
  // flash a jarring loading state.
  const showSkeleton = useDelayedTrue(loading && data.length === 0)

  if (!cwd) {
    return <EmptyState body={r.noProjectBody} title={r.noProjectTitle} />
  }

  if (error) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
        <EmptyState body={r.unreadableBody(error)} title={r.unreadableTitle} />
        {onRetry && (
          <button
            className="text-[0.68rem] font-medium text-muted-foreground transition hover:text-foreground"
            onClick={onRetry}
            type="button"
          >
            {r.tryAgain}
          </button>
        )}
      </div>
    )
  }

  if (loading && data.length === 0) {
    return showSkeleton ? <FileTreeLoadingState /> : <div className="min-h-0 flex-1" />
  }

  if (data.length === 0) {
    return <EmptyState body={r.emptyBody} title={r.emptyTitle} />
  }

  return (
    <ErrorBoundary
      fallback={({ reset }) => (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
          <EmptyState body={r.treeErrorBody} title={r.treeErrorTitle} />
          <button
            className="text-[0.68rem] font-medium text-muted-foreground transition hover:text-foreground"
            onClick={reset}
            type="button"
          >
            {r.tryAgain}
          </button>
        </div>
      )}
      key={cwd}
      label="file-tree"
    >
      <ProjectTree
        collapseNonce={collapseNonce}
        cwd={cwd}
        data={data}
        onActivateFile={onActivateFile}
        onActivateFolder={onActivateFolder}
        onLoadChildren={onLoadChildren}
        onNodeOpenChange={onNodeOpenChange}
        onPreviewFile={onPreviewFile}
        openState={openState}
      />
    </ErrorBoundary>
  )
}

function FileTreeLoadingState() {
  const { t } = useI18n()

  return (
    <div aria-label={t.rightSidebar.loadingTree} className="min-h-0 flex-1" role="status">
      <TreeSkeleton />
    </div>
  )
}

// Terse pane empty state ("No files" / "No diffs"): the panel label itself —
// same uppercase/tracking + dither dot — just muted instead of theme-primary,
// centered. Shared by the file tree and review panes so both read identically.
export function PaneEmptyState({ label }: { label: string }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-4">
      <SidebarPanelLabel className="pl-0 text-(--ui-text-quaternary)">{label}</SidebarPanelLabel>
    </div>
  )
}

// Richer empty/error state (title + body) for the file tree's read failures.
export function EmptyState({ body, title }: { body: string; title?: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-4 text-center">
      {title && (
        <div className="text-[0.7rem] font-semibold uppercase tracking-[0.07em] text-muted-foreground/75">{title}</div>
      )}
      <div className="text-[0.68rem] leading-relaxed text-muted-foreground/65">{body}</div>
    </div>
  )
}
