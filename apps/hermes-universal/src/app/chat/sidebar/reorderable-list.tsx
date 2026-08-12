import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import type * as React from 'react'

import { TAP_SLOP_PX } from '@/lib/touch'

// Sidebar reordering is a strictly vertical list. Ported verbatim from desktop
// `app/chat/sidebar/reorderable-list.tsx`.
const reorderAutoScroll = { threshold: { x: 0, y: 0.2 } }

// MODULE-LEVEL, and load-bearing (MJXHRM-383). `useSensor` memoizes on
// `[sensor, options]`, `useSensors` on the descriptors it is handed, and
// `useDraggable` derives its synthetic `listeners` from that array. Built as
// fresh object literals inside the component, every render of this list minted a
// new sensor array → a new DndContext value → a NEW `onPointerDown` for every
// row. That lands in `dragHandleProps`, which `rowPropsEqual` compares, so
// `SidebarSessionRow`'s memo could never bail in the sortable path — which is
// the default Recents list and the Pinned list. Rows repainted on every write to
// any of the ~30 stores `sidebar-content` subscribes to, no matter how stable
// the handlers above them were.
const reorderPointerSensorOptions = { activationConstraint: { distance: TAP_SLOP_PX } }
const reorderKeyboardSensorOptions = { coordinateGetter: sortableKeyboardCoordinates }

export function ReorderableList({
  children,
  ids,
  onReorder
}: {
  children: React.ReactNode
  ids: string[]
  onReorder: (ids: string[]) => void
}) {
  // dnd-kit's DEFAULT PointerSensor has no activation constraint: the first
  // pointermove starts a reorder. That is survivable with a mouse and not with a
  // thumb — and the grab handle is `touch-none`, so a touch landing on it could
  // neither scroll the list nor stay a tap. This used to take a `sensors` prop
  // threaded down from `sessions-section`, which nothing ever passed.
  const sensors = useSensors(
    useSensor(PointerSensor, reorderPointerSensorOptions),
    useSensor(KeyboardSensor, reorderKeyboardSensorOptions)
  )

  const handleDragEnd = ({ activatorEvent, active, over }: DragEndEvent) => {
    if (!(activatorEvent instanceof KeyboardEvent)) {
      ;(document.activeElement as HTMLElement | null)?.blur()
    }

    if (!over || active.id === over.id) {
      return
    }

    const from = ids.indexOf(String(active.id))
    const to = ids.indexOf(String(over.id))

    if (from >= 0 && to >= 0) {
      onReorder(arrayMove(ids, from, to))
    }
  }

  return (
    <DndContext
      autoScroll={reorderAutoScroll}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
      sensors={sensors}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        {children}
      </SortableContext>
    </DndContext>
  )
}

export function useSortableBindings(id: string) {
  const { attributes, isDragging, listeners, setNodeRef, transform, transition } = useSortable({ id })

  return {
    dragging: isDragging,
    dragHandleProps: { ...attributes, ...listeners },
    ref: setNodeRef,
    reorderable: true as const,
    style: {
      // Uniform vertical list: only ever translate on Y.
      transform: transform ? `translate3d(0px, ${transform.y}px, 0)` : undefined,
      transition: isDragging ? undefined : transition,
      willChange: isDragging ? 'transform' : undefined
    }
  }
}
