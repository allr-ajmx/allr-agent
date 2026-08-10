import { cva, type VariantProps } from 'class-variance-authority'
import { useEffect, useRef, useState } from 'react'

import { Codicon } from '@/components/ui/codicon'
import { DiffCount } from '@/components/ui/diff-count'
import type { HermesReviewFile } from '@/global'
import { useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import { cn } from '@/lib/utils'

// One changed file, as a touch row. (MJXHRM-323 Review Row + Diff)

export const mobileReviewRowVariants = cva(
  'relative flex min-h-[44px] touch-pan-y items-center gap-2 bg-(--ui-sidebar-surface-background) px-3 py-1.5 select-none',
  {
    variants: {
      selected: {
        true: 'bg-(--ui-row-active-background)',
        false: ''
      },
      dragging: {
        true: '',
        false: 'transition-transform duration-150'
      }
    },
    defaultVariants: {
      selected: false,
      dragging: false
    }
  }
)

export type MobileReviewRowVariantProps = VariantProps<typeof mobileReviewRowVariants>

/** Past this much horizontal travel the gesture commits on release. */
const COMMIT_PX = 64
/** Rubber-band stop, so the row can't be dragged off its own list. */
const MAX_PX = 96
/** Below this the gesture hasn't declared itself and the list still owns it. */
const AXIS_LOCK_PX = 8
const LONG_PRESS_MS = 450

type Armed = 'none' | 'revert' | 'stage'

interface MobileReviewRowProps {
  file: HermesReviewFile
  onLongPress: () => void
  onOpen: () => void
  onRevert: () => void
  onToggleStage: () => void
  selected: boolean
  viewed: boolean
}

// Per git status letter: the same tinted glyph vocabulary as the desktop tree.
const STATUS_GLYPH: Record<string, { icon: string; tone: string }> = {
  A: { icon: 'diff-added', tone: 'text-(--ui-green)' },
  C: { icon: 'diff-added', tone: 'text-(--ui-green)' },
  D: { icon: 'diff-removed', tone: 'text-(--ui-red)' },
  M: { icon: 'diff-modified', tone: 'text-amber-500/85' },
  R: { icon: 'diff-renamed', tone: 'text-sky-500/85' },
  U: { icon: 'warning', tone: 'text-(--ui-red)' },
  '?': { icon: 'diff-added', tone: 'text-muted-foreground/60' }
}

/** Split `a/b/c.ts` into the name and its parent dir — the name must never be
 *  the part that gets truncated. */
function splitPath(path: string): { dir: string; name: string } {
  const index = path.lastIndexOf('/')

  return index === -1 ? { dir: '', name: path } : { dir: path.slice(0, index), name: path.slice(index + 1) }
}

export function MobileReviewRow({
  file,
  onLongPress,
  onOpen,
  onRevert,
  onToggleStage,
  selected,
  viewed
}: MobileReviewRowProps) {
  const { t } = useI18n()
  const c = t.statusStack.coding
  const [dx, setDx] = useState(0)
  const [armed, setArmed] = useState<Armed>('none')
  const [dragging, setDragging] = useState(false)

  const gesture = useRef<null | {
    axis: 'none' | 'x' | 'y'
    longPress: null | ReturnType<typeof setTimeout>
    pointerId: number
    x: number
    y: number
  }>(null)

  // A swipe or a long-press is still followed by a synthetic click. Opening the
  // diff after the user just reverted the file would be actively wrong, so the
  // gesture claims the click that follows it.
  const swallowClick = useRef(false)

  const { dir, name } = splitPath(file.path)
  const glyph = STATUS_GLYPH[file.status] ?? STATUS_GLYPH.M

  const clearLongPress = () => {
    if (gesture.current?.longPress) {
      clearTimeout(gesture.current.longPress)
      gesture.current.longPress = null
    }
  }

  useEffect(() => clearLongPress, [])

  const reset = () => {
    clearLongPress()
    gesture.current = null
    setDx(0)
    setArmed('none')
    setDragging(false)
  }

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    // Mouse users have the context menu and the desktop pane; this whole gesture
    // layer is for touch/pen only, so a stray click-drag never arms an action.
    if (event.pointerType === 'mouse') {
      return
    }

    gesture.current = {
      axis: 'none',
      longPress: setTimeout(() => {
        // A long press that never moved: open the menu and swallow the gesture so
        // the release doesn't also register as a tap.
        if (gesture.current && gesture.current.axis === 'none') {
          void triggerHaptic('selection')
          swallowClick.current = true
          onLongPress()
          reset()
        }
      }, LONG_PRESS_MS),
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY
    }
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const state = gesture.current

    if (!state || state.pointerId !== event.pointerId) {
      return
    }

    const moveX = event.clientX - state.x
    const moveY = event.clientY - state.y

    if (state.axis === 'none') {
      if (Math.abs(moveX) < AXIS_LOCK_PX && Math.abs(moveY) < AXIS_LOCK_PX) {
        return
      }

      clearLongPress()

      // Vertical wins ties: scrolling the list is the far more common intent, and
      // stealing it would make the list feel broken.
      state.axis = Math.abs(moveX) > Math.abs(moveY) ? 'x' : 'y'

      if (state.axis === 'x') {
        event.currentTarget.setPointerCapture(event.pointerId)
        setDragging(true)
      }
    }

    if (state.axis !== 'x') {
      return
    }

    const clamped = Math.max(-MAX_PX, Math.min(MAX_PX, moveX))
    setDx(clamped)

    const next: Armed = clamped >= COMMIT_PX ? 'stage' : clamped <= -COMMIT_PX ? 'revert' : 'none'

    if (next !== armed) {
      setArmed(next)

      // Fires on the threshold, not on release: the confirmation has to land
      // while the finger is still down, or the gesture feels unacknowledged.
      if (next !== 'none') {
        void triggerHaptic('selection')
      }
    }
  }

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const state = gesture.current

    if (!state || state.pointerId !== event.pointerId) {
      return
    }

    const committed = state.axis === 'x' ? armed : 'none'

    if (state.axis === 'x') {
      swallowClick.current = true
    }

    reset()

    if (committed === 'stage') {
      onToggleStage()
    } else if (committed === 'revert') {
      onRevert()
    }
  }

  // Opening the diff runs off the click, not off pointerup, so a mouse (dev on a
  // narrow window) and a finger take exactly the same path.
  const onClick = () => {
    if (swallowClick.current) {
      swallowClick.current = false

      return
    }

    onOpen()
  }

  return (
    <div className="relative overflow-hidden">
      {/* Action backdrops. Each is revealed by the row sliding off it, and only
          tints to full once the gesture is past the commit threshold — so the
          colour itself is the "let go now" signal. */}
      <div
        className={cn(
          'absolute inset-y-0 left-0 flex w-24 items-center justify-start pl-4 transition-colors',
          armed === 'stage' ? 'bg-(--ui-green)/25 text-(--ui-green)' : 'bg-(--ui-green)/10 text-(--ui-green)/60'
        )}
      >
        <Codicon name={file.staged ? 'remove' : 'add'} size="1.1rem" />
      </div>
      <div
        className={cn(
          'absolute inset-y-0 right-0 flex w-24 items-center justify-end pr-4 transition-colors',
          armed === 'revert' ? 'bg-(--ui-red)/25 text-(--ui-red)' : 'bg-(--ui-red)/10 text-(--ui-red)/60'
        )}
      >
        <Codicon name="discard" size="1.1rem" />
      </div>

      <div
        aria-selected={selected}
        className={mobileReviewRowVariants({ selected, dragging })}
        data-slot="mobile-review-row"
        data-state={selected ? 'selected' : 'default'}
        onClick={onClick}
        onContextMenu={event => {
          // Long-press on a touch device also raises the platform context menu;
          // ours already opened, so suppress the duplicate.
          event.preventDefault()
        }}
        onPointerCancel={reset}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        role="button"
        style={{ transform: `translateX(${dx}px)` }}
        tabIndex={0}
      >
        <Codicon className={cn('shrink-0', glyph.tone)} name={glyph.icon} size="0.95rem" />

        <span className="flex min-w-0 flex-1 flex-col">
          <span className={cn('truncate text-sm', viewed ? 'text-muted-foreground' : 'text-foreground')}>{name}</span>
          {dir && <span className="truncate text-[0.7rem] text-(--ui-text-tertiary)">{dir}</span>}
        </span>

        <DiffCount added={file.added} className="shrink-0 text-[0.7rem]" removed={file.removed} />

        {file.staged && (
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-(--ui-green)/70" title={c.staged} />
        )}
        {viewed && <Codicon className="shrink-0 text-(--ui-green)/80" name="check" size="0.9rem" />}
      </div>
    </div>
  )
}
