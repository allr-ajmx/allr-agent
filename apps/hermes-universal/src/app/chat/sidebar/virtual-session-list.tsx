import { useSortable } from '@dnd-kit/sortable'
import { useVirtualizer } from '@tanstack/react-virtual'
import { type FC, type ReactNode, useCallback, useRef } from 'react'

import { cn } from '@/lib/utils'
import { sessionPinId } from '@/store/session'
import type { SessionInfo } from '@/types/hermes'

import { SidebarSessionRow } from './session-row'

// Virtualized flat session list (ported/adapted from desktop
// `virtual-session-list.tsx`). Universal has no branch tree, so entries are plain
// SessionInfo. When `sortable`, the caller wraps this in a ReorderableList that
// owns the DndContext/SortableContext; the rows consume it via useSortable.

interface VirtualSessionListProps {
  activeSessionId: null | string
  className?: string
  /** Rendered inside the scroller, below the last row (e.g. the load-more row). */
  footer?: ReactNode
  sessions: SessionInfo[]
  onArchiveSession: (sessionId: string) => void
  onDeleteSession: (sessionId: string) => void
  onResumeSession: (sessionId: string) => void
  onTogglePin: (pinId: string) => void
  pinned: boolean
  sortable: boolean
  workingSessionIdSet: Set<string>
}

const ROW_ESTIMATE_PX = 28
const OVERSCAN_ROWS = 12

export const VirtualSessionList: FC<VirtualSessionListProps> = ({
  activeSessionId,
  className,
  footer,
  sessions,
  onArchiveSession,
  onDeleteSession,
  onResumeSession,
  onTogglePin,
  pinned,
  sortable,
  workingSessionIdSet
}) => {
  const scrollerRef = useRef<HTMLDivElement | null>(null)

  const virtualizer = useVirtualizer({
    count: sessions.length,
    estimateSize: () => ROW_ESTIMATE_PX,
    getItemKey: index => sessions[index]?.id ?? index,
    getScrollElement: () => scrollerRef.current,
    initialRect: { height: 600, width: 240 },
    overscan: OVERSCAN_ROWS
  })

  const virtualItems = virtualizer.getVirtualItems()
  const totalSize = virtualizer.getTotalSize()
  const paddingTop = virtualItems[0]?.start ?? 0
  const paddingBottom = Math.max(0, totalSize - (virtualItems[virtualItems.length - 1]?.end ?? 0))

  const rows = virtualItems.map(virtualItem => {
    const session = sessions[virtualItem.index]

    if (!session) {
      return null
    }

    const commonProps = {
      isPinned: pinned,
      isSelected: session.id === activeSessionId,
      isWorking: workingSessionIdSet.has(session.id),
      onArchive: () => onArchiveSession(session.id),
      onDelete: () => onDeleteSession(session.id),
      onPin: () => onTogglePin(sessionPinId(session)),
      onResume: () => onResumeSession(session.id)
    }

    return sortable ? (
      <VirtualSortableRow
        index={virtualItem.index}
        key={session.id}
        measureRef={virtualizer.measureElement}
        rowProps={commonProps}
        session={session}
      />
    ) : (
      <SidebarSessionRow
        {...commonProps}
        data-index={virtualItem.index}
        key={session.id}
        ref={virtualizer.measureElement}
        session={session}
      />
    )
  })

  return (
    <div
      className={cn('relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain', className)}
      ref={scrollerRef}
    >
      <div className="grid gap-px" style={{ paddingBottom: `${paddingBottom}px`, paddingTop: `${paddingTop}px` }}>
        {rows}
      </div>
      {footer}
    </div>
  )
}

interface VirtualSortableRowProps {
  index: number
  measureRef: (node: Element | null) => void
  rowProps: {
    isPinned: boolean
    isSelected: boolean
    isWorking: boolean
    onArchive: () => void
    onDelete: () => void
    onPin: () => void
    onResume: () => void
  }
  session: SessionInfo
}

function VirtualSortableRow({ index, measureRef, rowProps, session }: VirtualSortableRowProps) {
  const { attributes, isDragging, listeners, setNodeRef, transform, transition } = useSortable({ id: session.id })

  const refMerged = useCallback(
    (node: HTMLDivElement | null) => {
      setNodeRef(node)
      measureRef(node)
    },
    [measureRef, setNodeRef]
  )

  return (
    <SidebarSessionRow
      {...rowProps}
      data-index={index}
      dragging={isDragging}
      dragHandleProps={{ ...attributes, ...listeners }}
      ref={refMerged}
      reorderable
      session={session}
      style={{
        transform: transform ? `translate3d(0px, ${transform.y}px, 0)` : undefined,
        transition: isDragging ? undefined : transition
      }}
    />
  )
}
