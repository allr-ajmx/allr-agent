import { useStore } from '@nanostores/react'
import {
  createContext,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { type NodeApi, type NodeRendererProps, type RowRendererProps, Tree, type TreeApi } from 'react-arborist'

import { TreeSkeleton } from '@/components/chat/skeletons'
import { Codicon } from '@/components/ui/codicon'
import { useResizeObserver } from '@/hooks/use-resize-observer'
import { IS_MOBILE } from '@/lib/platform'
import { createTap, isCoarsePointer } from '@/lib/touch'
import { cn } from '@/lib/utils'
import { $repoChangeByPath, type RepoChangeKind } from '@/store/coding-status'
import { useDisplayPath } from '@/store/display-home'
import { $renamingPath, beginInlineRename } from '@/store/file-actions'
import { $revealInTreeRequest } from '@/store/layout'

import { FileEntryActionsMenu, FileEntryContextMenu, InlineRenameInput, isRenameShortcut } from '../file-actions'

import { getFileTreeDndManager } from './dnd-manager'
import type { TreeNode } from './use-project-tree'

// 22px rows are a mouse target. On touch the row IS the hit area (there are no
// hover affordances to aim at), so it gets the platform minimum, and the indent
// grows with it so nesting still reads at that scale.
const ROW_HEIGHT = IS_MOBILE ? 44 : 22
const INDENT = IS_MOBILE ? 14 : 10
/** Fixed base inset (`px-6.5`) layered on top of arborist's depth indent. */
const TREE_ROW_INSET = '17px'

function withTreeInset(paddingLeft: number | string | undefined): string {
  if (typeof paddingLeft === 'number') {
    return `calc(${paddingLeft}px + ${TREE_ROW_INSET})`
  }

  if (!paddingLeft) {
    return TREE_ROW_INSET
  }

  return `calc(${paddingLeft} + ${TREE_ROW_INSET})`
}

interface ProjectTreeProps {
  collapseNonce: number
  cwd: string
  data: TreeNode[]
  onActivateFile: (path: string) => void
  onActivateFolder: (path: string) => void
  onLoadChildren: (id: string) => void | Promise<void>
  onNodeOpenChange: (id: string, open: boolean) => void
  onPreviewFile?: (path: string) => void
  openState: Record<string, boolean>
}

export function ProjectTree({
  collapseNonce,
  cwd,
  data,
  onActivateFile,
  onActivateFolder,
  onLoadChildren,
  onNodeOpenChange,
  onPreviewFile,
  openState
}: ProjectTreeProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const treeRef = useRef<TreeApi<TreeNode> | null>(null)
  // HEIGHT ONLY, and that is the whole point. The virtualized list needs a
  // pixel height to know how many rows to mount; its WIDTH it only ever passes
  // through to CSS (`react-arborist` types it `number | string` and never does
  // arithmetic on it), and the row renderer below already pins `width: 100%`.
  //
  // Holding width in state made every horizontal resize a re-render of the
  // whole tree. Measured on a right-sidebar sash drag: 174 commits of this one
  // pane, 1476ms of React, ~97% of every pane commit in the capture — against
  // 3 for `sessions` and 2 for `chat`. A horizontal drag now changes nothing
  // this component reads, so it does not re-render at all.
  const [height, setHeight] = useState(0)
  const changeByPath = useStore($repoChangeByPath)

  const syncTreeSize = useCallback((entries: readonly ResizeObserverEntry[]) => {
    const el = containerRef.current

    if (!el) {
      return
    }

    // From the entry when the observer already computed it; inside RO timing
    // the fallback read is cheap anyway, but free is cheaper.
    const next = entries.find(entry => entry.target === el)?.contentRect?.height ?? el.getBoundingClientRect().height

    setHeight(prev => (prev === next ? prev : next))
  }, [])

  useResizeObserver(syncTreeSize, containerRef)

  const handleToggle = useCallback(
    (id: string) => {
      const node = treeRef.current?.get(id)

      if (!node) {
        return
      }

      onNodeOpenChange(id, node.isOpen)

      if (node.isOpen && node.data?.isDirectory && node.data.children === undefined) {
        void onLoadChildren(id)
      }
    },
    [onLoadChildren, onNodeOpenChange]
  )

  // "Reveal in side bar": expand each ancestor folder top-down (lazy-loading its
  // children first so the node exists), then select + scroll to the target. The
  // pane is opened by the caller; this drives the tree to the file.
  const revealNode = useCallback(
    async (absPath: string) => {
      const root = cwd.replace(/[\\/]+$/, '')
      const target = absPath.replace(/[\\/]+$/, '')
      const rel = target.startsWith(root) ? target.slice(root.length).replace(/^[\\/]+/, '') : ''
      const segments = rel.split(/[\\/]/).filter(Boolean)

      let acc = root

      for (let i = 0; i < segments.length - 1; i += 1) {
        acc = `${acc}/${segments[i]}`
        const node = treeRef.current?.get(acc)

        if (node?.data?.isDirectory && node.data.children === undefined) {
          await onLoadChildren(acc)
        }

        onNodeOpenChange(acc, true)
        treeRef.current?.open(acc)
        await new Promise(resolve => requestAnimationFrame(() => resolve(undefined)))
      }

      treeRef.current?.select(target)
      // 'start' lands the file at/near the top (instant — arborist sets scrollTop
      // directly, no smooth scroll).
      treeRef.current?.scrollTo(target, 'start')
    },
    [cwd, onLoadChildren, onNodeOpenChange]
  )

  useEffect(
    () =>
      $revealInTreeRequest.subscribe(path => {
        if (!path) {
          return
        }

        $revealInTreeRequest.set(null)
        void revealNode(path)
      }),
    [revealNode]
  )

  // THE open-on-tap path, and the only one. It runs from `node.activate()`,
  // which the row container calls on a mouse click (via `node.handleClick`) and
  // on a finger tap (via the pointer gesture — see ProjectTreeRowContainer).
  //
  // Coarse pointers only. A finger has no double-click idiom, so one tap has to
  // open; a mouse keeps select-then-double-click, where a single click is how
  // you pick a row to rename or drag, and `onDoubleClick` on the row opens.
  // Gated on the LIVE media query rather than `IS_MOBILE`: that const is frozen
  // at first import (and deliberately never tags a touchscreen laptop), so it is
  // the wrong question for "what is touching this row".
  //
  // Suppressed for the row being renamed so the context-menu "Rename" (and the
  // click that falls through as its menu closes) can't open the preview instead.
  const handleActivate = useCallback(
    (node: NodeApi<TreeNode>) => {
      if (!node.data || node.data.isDirectory || node.data.placeholder || !isCoarsePointer()) {
        return
      }

      if ($renamingPath.get() !== node.data.id) {
        onPreviewFile?.(node.data.id)
      }
    },
    [onPreviewFile]
  )

  // F2 / Enter on the selected row begins an inline rename. Capture-phase so it
  // beats arborist's own Enter-to-activate; skipped while an edit is in progress
  // (the editor input owns Enter/Esc then) and for placeholder rows.
  const handleRenameShortcut = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!isRenameShortcut(event) || $renamingPath.get()) {
      return
    }

    const node = treeRef.current?.selectedNodes?.[0]

    if (!node?.data || node.data.placeholder) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    beginInlineRename(node.data.id)
  }, [])

  // Everything the row renderer needs that is NOT arborist's own node props.
  // It travels by context rather than by closure for one reason, and it is the
  // whole of MJXHRM's "the menu vanishes" bug: `props.children` IS the node
  // renderer's ELEMENT TYPE (`tree.renderNode`, react-arborist
  // row-container.js:61). An inline `{props => <ProjectTreeRow …/>}` is a new
  // function identity on every render of this component, so every re-render
  // handed React a different type for every visible row — which React can only
  // service by UNMOUNTING each row and mounting a replacement. Each row carries
  // two Radix roots; unmounting one closes its menu, mid-`onSelect` if that is
  // when the re-render landed. A module-level component keeps the type constant,
  // so a re-render updates the rows in place and an open menu survives it.
  const rowContext = useMemo(
    () => ({
      changeByPath,
      onAttachFile: onActivateFile,
      onAttachFolder: onActivateFolder,
      onPreviewFile,
      relativeTo: cwd
    }),
    [changeByPath, cwd, onActivateFile, onActivateFolder, onPreviewFile]
  )

  return (
    <div className="min-h-0 flex-1 overflow-hidden" onKeyDownCapture={handleRenameShortcut} ref={containerRef}>
      {height > 0 ? (
        <ProjectTreeRowContext.Provider value={rowContext}>
          <Tree<TreeNode>
            childrenAccessor={node => (node?.isDirectory ? (node.children ?? []) : null)}
            data={data}
            disableDrag
            disableDrop
            disableEdit
            dndManager={getFileTreeDndManager()}
            height={height}
            indent={INDENT}
            initialOpenState={openState}
            key={`${cwd}:${collapseNonce}`}
            onActivate={handleActivate}
            onToggle={handleToggle}
            openByDefault={false}
            padding={0}
            ref={treeRef}
            renderRow={ProjectTreeRowContainer}
            rowHeight={ROW_HEIGHT}
            // CSS, not a measured pixel count — see the height-only note above.
            width="100%"
          >
            {ProjectTreeNodeRenderer}
          </Tree>
        </ProjectTreeRowContext.Provider>
      ) : (
        <TreeSizingState />
      )}
    </div>
  )
}

interface ProjectTreeRowContextValue {
  changeByPath: Map<string, RepoChangeKind>
  onAttachFile: (path: string) => void
  onAttachFolder: (path: string) => void
  onPreviewFile?: (path: string) => void
  relativeTo?: null | string
}

const EMPTY_CHANGES: Map<string, RepoChangeKind> = new Map()

const ProjectTreeRowContext = createContext<ProjectTreeRowContextValue>({
  changeByPath: EMPTY_CHANGES,
  onAttachFile: () => {},
  onAttachFolder: () => {}
})

/** The node renderer, as a STABLE component type — see `rowContext` above for
 *  why that identity is load-bearing rather than a micro-optimisation. */
function ProjectTreeNodeRenderer(props: NodeRendererProps<TreeNode>) {
  const { changeByPath, ...rest } = useContext(ProjectTreeRowContext)

  return (
    <ProjectTreeRow
      {...props}
      {...rest}
      changeKind={props.node.data ? changeByPath.get(props.node.data.id) : undefined}
    />
  )
}

function TreeSizingState() {
  return <TreeSkeleton />
}

// arborist's default row hardcodes `min-width: max-content` (so a highlight can
// span horizontally-scrolled content), which grows the row to its full name
// width and defeats the inner `truncate`. We don't scroll sideways — pin the row
// to the viewport so long names ellipsize instead of clipping at the pane edge.
//
// This container, not the presentational row inside it, is the element arborist
// sizes to the full row rect, so it owns activation: `node.handleClick` selects
// and activates, and `onActivate` is where opening lives. Nothing here closes
// over a callback — a `renderRow` whose identity moves makes arborist unmount
// and rebuild every visible row, and doing that to the rows under a finger that
// is still touching one is how a tap ends up tearing out the Radix menus each
// row carries.
//
// A FINGER does not go through `click` at all. On a touch screen `click` is not
// an event the page receives, it is a verdict the engine reaches after ruling
// out a scroll and a drag — and for a row inside a scrollable virtualized list
// the Android WebView routinely rules against a quick jab, which is why a short
// tap did nothing here while a slower, stationary press worked. `createTap`
// reads `pointerup` directly and takes the engine out of the decision; the
// capture-phase guard below then kills the synthetic click if one does arrive,
// so a tap can never both tap and click. A mouse never arms the gesture and its
// native click path is untouched.
function ProjectTreeRowContainer({ attrs, children, innerRef, node }: RowRendererProps<TreeNode>) {
  // The node instance is rebuilt on every tree state change; the gesture is not.
  const nodeRef = useRef(node)

  nodeRef.current = node

  const tapRef = useRef<null | ReturnType<typeof createTap>>(null)

  if (!tapRef.current) {
    tapRef.current = createTap({
      onTap: () => {
        const current = nodeRef.current

        if (!current.data || current.data.placeholder || $renamingPath.get() === current.data.id) {
          return
        }

        current.select()

        // A folder expands and a file opens — the two halves of what a click
        // means here, which on the mouse path are split between `handleClick`
        // (select + activate) and the inner row (toggle).
        if (current.data.isDirectory) {
          current.toggle()
        } else {
          current.activate()
        }
      }
    })
  }

  const tap = tapRef.current

  return (
    <div
      {...attrs}
      onClick={node.handleClick}
      onClickCapture={event => {
        // Capture phase, so this also spares the inner row's handler: the tap
        // already resolved this gesture.
        if (tap.fired()) {
          event.stopPropagation()
        }
      }}
      onFocus={e => e.stopPropagation()}
      onPointerCancel={tap.cancel}
      onPointerDown={tap.down}
      onPointerMove={tap.move}
      onPointerUp={tap.up}
      ref={innerRef}
      style={{ ...attrs.style, minWidth: 0, width: '100%' }}
    >
      {children}
    </div>
  )
}

const CHANGE_TINT: Record<RepoChangeKind, string> = {
  added: 'text-(--ui-green)',
  conflicted: 'text-(--ui-red)',
  modified: 'text-(--ui-yellow)'
}

function ProjectTreeRow({
  changeKind,
  dragHandle,
  node,
  onAttachFile,
  onAttachFolder,
  onPreviewFile,
  relativeTo,
  style
}: NodeRendererProps<TreeNode> & {
  changeKind?: RepoChangeKind
  onAttachFile: (path: string) => void
  onAttachFolder: (path: string) => void
  onPreviewFile?: (path: string) => void
  relativeTo?: null | string
}) {
  const renamingPath = useStore($renamingPath)
  // The row's tooltip is the node's ABSOLUTE path on the GATEWAY's filesystem —
  // this tree is served by `/api/fs`, not by this client's disk (MJXHRM-394).
  const displayPath = useDisplayPath()

  if (!node.data) {
    return <div style={style} />
  }

  const isFolder = node.data.isDirectory
  const isPlaceholder = Boolean(node.data.placeholder)
  const isErrorPlaceholder = node.data.placeholder === 'error'
  const editing = !isPlaceholder && renamingPath === node.data.id

  // The row's CONTENT, and the right-click trigger — deliberately not the row
  // element itself, so that `FileEntryActionsMenu` below is this trigger's
  // SIBLING rather than its descendant. Two Radix roots on one element share a
  // pointer stream: the context trigger installs its own pointerdown/move/up for
  // a 700ms long-press, and the kebab only ever stopped propagation at
  // `pointerdown`, so the trigger kept seeing the rest of the gesture.
  //
  // `absolute inset-0` rather than an in-flow `flex-1`, and that is the whole
  // point: in flow it would end where the kebab begins, leaving the row's last
  // ~32px — the far right edge people habitually aim at — with no right-click at
  // all. Filling the row keeps the trigger the full width while the kebab, which
  // comes later in DOM order and is positioned, still paints and hits above it.
  // The trailing padding reserves the kebab's own width so a long name
  // ellipsizes before it instead of running underneath.
  const label = (
    <div
      className={cn('absolute inset-0 flex items-center', IS_MOBILE ? 'gap-2 pe-14' : 'gap-1 pe-8')}
      style={{ paddingLeft: withTreeInset(style.paddingLeft) }}
    >
      {/* No chevron column — the folder icon (open/closed) already carries the
          expand state, so the extra glyph was pure noise. */}
      <span aria-hidden className="flex w-3.5 items-center justify-center text-(--ui-text-tertiary)">
        {isPlaceholder && !isErrorPlaceholder ? (
          <Codicon name="loading" size="0.75rem" spinning />
        ) : isErrorPlaceholder ? (
          <Codicon name="warning" size="0.75rem" />
        ) : isFolder ? (
          <Codicon name={node.isOpen ? 'folder-opened' : 'folder'} size="0.875rem" />
        ) : (
          <Codicon name="file" size="0.875rem" />
        )}
      </span>
      {editing ? (
        <InlineRenameInput name={node.data.name} path={node.data.id} />
      ) : (
        // Git decoration (VS Code-style): tint changed files; the explicit color
        // wins over the row's hover/selected text color, so it persists.
        <span className={cn('min-w-0 flex-1 truncate', changeKind && CHANGE_TINT[changeKind])}>{node.data.name}</span>
      )}
    </div>
  )

  return (
    <div
      aria-expanded={isFolder ? node.isOpen : undefined}
      aria-selected={node.isSelected}
      className={cn(
        'group/row row-hover relative flex h-full select-none items-center border border-transparent font-normal leading-(--file-tree-row-height) text-(--ui-text-secondary) hover:text-foreground',
        IS_MOBILE ? 'text-sm leading-normal' : 'text-xs',
        node.isSelected && 'bg-(--ui-row-active-background) text-foreground',
        isPlaceholder && 'pointer-events-none italic text-muted-foreground/70'
      )}
      // Never on a phone. The tree's drag layer is react-dnd's HTML5Backend
      // (files/dnd-manager.ts), which has no touch path at all — so `draggable`
      // there buys nothing and costs the gesture engine one more thing to weigh
      // against "this was a tap" on every press.
      draggable={!IS_MOBILE && !isPlaceholder && !editing}
      onClick={event => {
        // Read the rename atom LIVE (not the render closure): the fall-through
        // click from a context-menu close can fire before the editing re-render
        // commits, so a stale closure would still select/activate and yank focus.
        if (isPlaceholder || $renamingPath.get() === node.data.id) {
          event.stopPropagation()

          return
        }

        if (event.shiftKey) {
          event.stopPropagation()
          ;(isFolder ? onAttachFolder : onAttachFile)(node.data.id)

          return
        }

        // Everything else FALLS THROUGH to the row container, which is the
        // element arborist sizes to the whole row and the single place selection
        // and activation live. This handler used to stop propagation
        // unconditionally, which meant the container's click — and with it
        // `onActivate`, the open — only ever ran for the sliver of row this div
        // did not cover.
        //
        // A folder still toggles here: `handleClick` selects and activates but
        // never toggles, and expanding is what a tap on a folder means.
        if (isFolder) {
          node.toggle()
        }
      }}
      onDoubleClick={event => {
        event.stopPropagation()

        if (!isFolder && !isPlaceholder && $renamingPath.get() !== node.data.id) {
          onPreviewFile?.(node.data.id)
        }
      }}
      onDragStart={event => {
        if (isPlaceholder || $renamingPath.get() === node.data.id) {
          event.preventDefault()

          return
        }

        const payload = JSON.stringify([{ isDirectory: isFolder, path: node.data.id }])

        event.dataTransfer.effectAllowed = 'copy'
        event.dataTransfer.setData('application/x-hermes-paths', payload)
        event.dataTransfer.setData('text/plain', node.data.id)
      }}
      ref={dragHandle}
      title={displayPath(node.data.id)}
    >
      {/* No context menu on a phone. Radix's trigger arms a 700ms touch
          long-press of its own, which is the third thing competing for the same
          press — and it is redundant there, because the kebab beside it exists
          precisely so these actions have a touch path. Right-click keeps it on
          every pointer that has one. */}
      {isPlaceholder || IS_MOBILE ? (
        label
      ) : (
        <FileEntryContextMenu isDirectory={isFolder} name={node.data.name} path={node.data.id} relativeTo={relativeTo}>
          {label}
        </FileEntryContextMenu>
      )}
      {/* The context menu beside it is right-click only, so without this the
          row's actions have no touch path at all. Rendered for every row so the
          column width is stable; it is the visibility that varies. */}
      {!editing && !isPlaceholder && (
        <FileEntryActionsMenu
          // The row's only IN-FLOW child, so `ms-auto` is what puts it at the
          // end; `relative` is what puts it above the absolutely-positioned
          // trigger it shares the row with (both are positioned, so DOM order
          // decides, and it comes second).
          className="relative ms-auto me-3"
          isDirectory={isFolder}
          name={node.data.name}
          path={node.data.id}
          relativeTo={relativeTo}
        />
      )}
    </div>
  )
}
