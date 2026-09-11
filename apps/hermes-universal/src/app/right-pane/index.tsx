import { useStore } from '@nanostores/react'
import { type ComponentProps, type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from 'react'

import { TreeSkeleton } from '@/components/chat/skeletons'
import { ErrorBoundary } from '@/components/error-boundary'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { SearchField } from '@/components/ui/search-field'
import { Tip } from '@/components/ui/tooltip'
import { useDelayedTrue } from '@/hooks/use-delayed-true'
import { useTapHandlers } from '@/hooks/use-tap'
import { useI18n } from '@/i18n'
import { type FileSearchHit, nextSelectionIndex, parentLabel } from '@/lib/file-search'
import { normalizeOrLocalPreviewTarget } from '@/lib/local-preview'
import { IS_MOBILE } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { setExplorerPath } from '@/store/explorer-path'
import { $panesFlipped, revealFileInTree } from '@/store/layout'
import { notifyError } from '@/store/notifications'
import { setCurrentSessionPreviewTarget } from '@/store/preview'
import { $effectiveCwd, $workspaceHome } from '@/store/workspace-events'

import { SidebarPanelLabel } from '../shell/sidebar-label'

import { FileEntryContextMenu } from './file-actions'
import { ProjectTree } from './files/tree'
import { useFileSearch } from './files/use-file-search'
import { useProjectTree } from './files/use-project-tree'

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
  //
  // This is the ONLY thing that roots the tree. There used to be a
  // `$fileTreeRootOverride` layered on top for the Home button, and it broke
  // the binding in both directions at once: it moved the view while the session
  // kept working elsewhere, and while it was set a real cwd change could not
  // show through it. Choosing a folder now moves a cwd (`store/explorer-path`)
  // and the tree follows from `$effectiveCwd`, which is derived and therefore
  // cannot disagree with the session.
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
        // The rails are grid columns, so they already mirror under `dir=rtl` and
        // the seam follows with a logical border. The inner highlight is a
        // box-shadow OFFSET — geometry, not layout — so it carries the direction
        // sign instead, or it would light the opposite edge from its own border.
        panesFlipped
          ? 'border-e shadow-[inset_calc(-0.0625rem*var(--dir-flip-x))_0_0_color-mix(in_srgb,white_18%,transparent)]'
          : 'border-s shadow-[inset_calc(0.0625rem*var(--dir-flip-x))_0_0_color-mix(in_srgb,white_18%,transparent)]'
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
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(-1)
  const home = useStore($workspaceHome).trim()
  const search = useFileSearch({ cwd, data, query })
  const trimmed = query.trim()

  // Never point the cursor at a row that is no longer there: the answer landing
  // replaces the list under a held arrow key.
  const selectedIndex = Math.min(selected, search.hits.length - 1)

  // Home asks the same question every other folder pick asks — move this chat,
  // or only new ones — instead of silently re-rooting the view. `home` is the
  // GATEWAY's home directory (sessions run there, not here); it is an additive
  // field, so an older backend leaves it empty and the button is not rendered.
  const homeTap = useTapHandlers(() => setExplorerPath(home))

  const openHit = (hit: FileSearchHit) => {
    if (hit.isDirectory) {
      // A folder answer is "take me there", not "open it": clearing the query
      // puts the tree back with that folder revealed, which is where the user
      // can actually work.
      setQuery('')
      setSelected(-1)
      revealFileInTree(hit.path)
    } else {
      ;(onPreviewFile ?? onActivateFile)(hit.path)
    }
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!trimmed) {
      return
    }

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setSelected(nextSelectionIndex(selectedIndex, event.key === 'ArrowDown' ? 1 : -1, search.hits.length))
    } else if (event.key === 'Enter') {
      const hit = search.hits[selectedIndex >= 0 ? selectedIndex : 0]

      if (hit) {
        event.preventDefault()
        openHit(hit)
      }
    } else if (event.key === 'Escape') {
      event.preventDefault()
      setQuery('')
      setSelected(-1)
    }
  }

  // No working directory (a bare/detached chat) → no tree, just a terse hint.
  // Switching workspace is a project/worktree action, never a raw folder picker.
  if (!hasWorkspace) {
    return <PaneEmptyState label={r.noProjectOpen} />
  }

  // The bar says what it can actually do. On a gateway with the search route
  // that is the whole tree; on one without it, only the folders already
  // expanded — which is what the original mobile-only filter promised, and the
  // promise it must go back to making rather than pretending to be
  // project-wide and silently missing things.
  const searchLabel = search.available === false ? r.filterFiles : r.searchFiles

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <RightSidebarSectionHeader>
        <div className="flex min-w-0 flex-1">
          <SidebarPanelLabel>{cwdName}</SidebarPanelLabel>
        </div>
        {/* Only when the gateway told us where home IS. `home` is additive on
            `/api/fs/default-cwd`, so an older backend leaves it empty and the
            button is simply absent — better than one that roots the tree at ''. */}
        {home && (
          <Tip label={r.goHome}>
            <Button
              aria-label={r.goHome}
              className={HEADER_ACTION_LABEL_REVEAL}
              size="icon-xs"
              variant="ghost"
              {...homeTap}
            >
              <Codicon name="home" size="0.8125rem" />
            </Button>
          </Tip>
        )}
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

      {trimmed ? (
        <FilterResults
          cwd={cwd}
          emptyLabel={search.source === 'local' && search.available === false ? r.filterNoMatches : r.searchNoMatches}
          hits={search.hits}
          onOpen={openHit}
          selectedIndex={selectedIndex}
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

      {/* Docked at the BOTTOM, on every platform — scrolling a deep tree with a
          thumb is the worst part of every mobile IDE, and a desktop tree with no
          filter at all is not much better.

          Rule 32 and the soft keyboard: this needs NO `--keyboard-inset`. The
          rule is for `fixed` and portalled surfaces, and this bar is in normal
          flow inside the mobile shell — `app/shell/mobile-workspace.tsx` is
          itself the fixed surface, already sized to the VISIBLE rectangle via
          `--visual-viewport-height` / `--visual-viewport-top`, and AGENTS.md is
          explicit that anything in flow inside such a shell is handled for
          free and that shells must not double-lift. The bottom safe area is the
          tab bar's below us, for the same reason. Adding an inset here would
          lift the bar twice and leave a dead band. */}
      <div
        className="shrink-0 border-t border-(--ui-stroke-secondary) px-2 py-1"
        // Keydown, not a SearchField prop: the events bubble from the input and
        // this keeps the shared field free of one caller's navigation model.
        onKeyDown={handleKeyDown}
      >
        <SearchField
          aria-label={searchLabel}
          containerClassName="w-full"
          loading={search.loading}
          onChange={value => {
            setQuery(value)
            setSelected(-1)
          }}
          onClear={() => {
            setQuery('')
            setSelected(-1)
          }}
          placeholder={searchLabel}
          value={query}
        />
      </div>
    </div>
  )
}

/** Flat matches, files and folders alike. Flat beats a filtered tree: the answer
 *  is one tap away instead of behind the disclosure chain that led to it, and
 *  the gateway's ranker returns paths from folders that were never expanded, so
 *  there is no chain to show in the first place. Tapping a folder returns to the
 *  tree with that folder revealed. */
function FilterResults({
  cwd,
  emptyLabel,
  hits,
  onOpen,
  selectedIndex
}: {
  cwd: string
  emptyLabel: string
  hits: FileSearchHit[]
  onOpen: (hit: FileSearchHit) => void
  selectedIndex: number
}) {
  if (hits.length === 0) {
    return <PaneEmptyState label={emptyLabel} />
  }

  return (
    // A listbox, because that is what ↑/↓/Enter make it: without the role the
    // rows' `aria-selected` describes nothing a screen reader can act on.
    <div className="min-h-0 flex-1 overflow-y-auto" role="listbox">
      {hits.map((hit, index) => (
        <FilterResultRow
          cwd={cwd}
          hit={hit}
          key={hit.path}
          onOpen={onOpen}
          parent={parentLabel(hit.path, cwd)}
          selected={index === selectedIndex}
        />
      ))}
    </div>
  )
}

function FilterResultRow({
  cwd,
  hit,
  onOpen,
  parent,
  selected
}: {
  cwd: string
  hit: FileSearchHit
  onOpen: (hit: FileSearchHit) => void
  parent: string
  selected: boolean
}) {
  const ref = useRef<HTMLButtonElement>(null)
  // Rule 31: a finger's tap is resolved here rather than waiting on the
  // engine's click verdict, which it withholds for a quick jab inside a
  // scrollable list.
  const tap = useTapHandlers(() => onOpen(hit))

  useEffect(() => {
    if (selected) {
      ref.current?.scrollIntoView({ block: 'nearest' })
    }
  }, [selected])

  const row = (
    <button
      aria-selected={selected}
      className={cn(
        'flex min-h-11 w-full items-center gap-2 px-3 text-start',
        // The same size the tree row reads at (files/tree.tsx), mobile branch
        // included. A search hit and a tree row are the same object seen two
        // ways; they had no business being set in two different sizes.
        IS_MOBILE ? 'text-sm leading-normal' : 'text-xs',
        selected && 'bg-(--ui-control-hover-background)'
      )}
      ref={ref}
      role="option"
      type="button"
      {...tap}
    >
      <Codicon
        className="shrink-0 text-(--ui-text-tertiary)"
        name={hit.isDirectory ? 'folder' : 'file'}
        size="0.95rem"
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-foreground">{hit.name}</span>
        {/* One step under the name, the same step the review tree puts its own
            secondary path line at (review/file-tree.tsx) — not a literal picked
            for this one row. */}
        {parent && <span className="truncate text-[0.68rem] text-(--ui-text-tertiary)">{parent}</span>}
      </span>
    </button>
  )

  // Same menu as the tree, from the same `fileEntryMenuItems` definition, and
  // the same phone rule: no right-click trigger where Radix would arm a 700ms
  // long-press against the tap handler above. `relativeTo` is what makes Copy
  // Relative Path appear; `isDirectory` is what decides the folder-only rows.
  if (IS_MOBILE) {
    return row
  }

  return (
    <FileEntryContextMenu isDirectory={hit.isDirectory} name={hit.name} path={hit.path} relativeTo={cwd}>
      {row}
    </FileEntryContextMenu>
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
      <SidebarPanelLabel className="ps-0 text-(--ui-text-quaternary)">{label}</SidebarPanelLabel>
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
