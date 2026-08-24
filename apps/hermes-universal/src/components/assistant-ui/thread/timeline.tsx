import { useAuiState } from '@assistant-ui/react'
import { type FC, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { queryVisible } from '@/components/pane-shell/pane-visibility'
import { triggerHaptic } from '@/lib/haptics'
import { createLongPress } from '@/lib/long-press'
import { rafCoalesce } from '@/lib/raf-coalesce'
import { cn } from '@/lib/utils'
import { requestScrollToTurn } from '@/store/thread-scroll'

import {
  activeTimelineIndex,
  deriveTimelineEntries,
  type TimelineEntry,
  type TimelineSourceMessage
} from './timeline-data'
import { resolveScrub } from './timeline-scrub'
import { turnStartElement } from './turn-scroll'

const MIN_ENTRIES = 4
const VIEWPORT = '[data-slot="aui_thread-viewport"]'
const HOVER_CLOSE_MS = 140

// Touch scrub. The rail is built on hover — the popover opens on mouse-enter and
// each tick lights its row the same way — so on a phone the preview list never
// appeared and a tap on a 2px tick jumped blind. A hold opens the list, a drag
// picks from it, and letting go goes there.
//
// The drag is RELATIVE, the way the composer's bubble carousel is: it starts on
// the turn you are already reading and moves a fixed distance per turn from
// there (see `timeline-scrub.ts`). Picking the nearest tick to the finger
// instead made 8px — one tick's height — a whole turn, and capped the gesture's
// reach at the strip's own height.
const SCRUB_LONG_PRESS_MS = 280
const SCRUB_MOVE_TOLERANCE_PX = 12

const ROW_CLASS =
  'row-hover relative flex w-full min-w-0 max-w-full select-none overflow-hidden rounded-md px-2 py-1 text-start outline-hidden'

// Surface (border-color/bg/shadow/blur) comes from the shared
// `[data-slot='thread-timeline-popover']` rule in styles.css, so it's 1:1 with
// the dropdown/select/dialog menus. We only own layout + the border/radius here.
const POPOVER_SHELL =
  'absolute end-full top-1/2 z-50 max-h-[min(22rem,calc(100vh-8rem))] w-80 max-w-[min(20rem,calc(100vw-2rem))] -translate-y-1/2 overflow-x-hidden overflow-y-auto overscroll-contain rounded-lg border p-1 text-popover-foreground transition-[opacity,transform] duration-100 ease-out group-hover/timeline:transition-none'

function userPromptText(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }

  if (!Array.isArray(content)) {
    return ''
  }

  let out = ''

  for (const part of content) {
    if (typeof part === 'string') {
      out += part

      continue
    }

    if (!part || typeof part !== 'object') {
      continue
    }

    const row = part as { text?: unknown; type?: unknown }

    if ((!row.type || row.type === 'text') && typeof row.text === 'string') {
      out += row.text
    }
  }

  return out
}

/** Index-keyed ref-array setter — `ref={listRef(refs, i)}`. */
const listRef =
  <T,>(refs: React.RefObject<(T | null)[]>, index: number) =>
  (node: T | null) => {
    refs.current[index] = node
  }

/** Mouse enter/leave pair forwarding `on` to the shared paint(). */
const hoverProps = (index: number, paint: (index: number, on: boolean) => void) => ({
  onMouseEnter: () => paint(index, true),
  onMouseLeave: () => paint(index, false)
})

/** Right-edge prompt rail — hover previews, click to jump. ≥4 user turns only. */
export const ThreadTimeline: FC<{ sessionKey?: null | string }> = ({ sessionKey }) => {
  const sourceSignature = useAuiState(s => {
    const rows: TimelineSourceMessage[] = []

    for (const message of s.thread.messages) {
      if (message.role !== 'user') {
        continue
      }

      rows.push({ id: message.id, role: 'user', text: userPromptText(message.content) })
    }

    return JSON.stringify(rows)
  })

  const entries = useMemo(
    () => deriveTimelineEntries(JSON.parse(sourceSignature) as TimelineSourceMessage[]),
    [sourceSignature]
  )

  const [activeIndex, setActiveIndex] = useState(0)
  const [open, setOpen] = useState(false)
  const closeTimerRef = useRef<number | undefined>(undefined)

  // Hover sync lives on the DOM, not in React state — the tick and its popover
  // row are siblings in different subtrees, so a shared index-keyed paint() lights
  // both without a re-render (and without coupling them through a parent atom).
  const tickRefs = useRef<(HTMLSpanElement | null)[]>([])
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([])

  // Hover sync: light the tick + its popover row, and scroll that row into view
  // when the list overflows so the hovered prompt is always visible.
  const paint = useCallback((index: number, on: boolean) => {
    const tick = tickRefs.current[index]

    if (tick) {
      tick.style.opacity = on ? '1' : ''
    }

    const row = rowRefs.current[index]
    row?.classList.toggle('bg-(--ui-row-hover-background)', on)

    if (on) {
      row?.scrollIntoView({ block: 'nearest' })
    }
  }, [])

  const keepOpen = useCallback(() => {
    window.clearTimeout(closeTimerRef.current)
    setOpen(true)
  }, [])

  const closeSoon = useCallback(() => {
    window.clearTimeout(closeTimerRef.current)
    closeTimerRef.current = window.setTimeout(() => setOpen(false), HOVER_CLOSE_MS)
  }, [])

  useEffect(() => () => window.clearTimeout(closeTimerRef.current), [])

  // ── Touch scrub ───────────────────────────────────────────────────────────
  // The index currently under the finger, or null when not scrubbing. A ref, not
  // state: it drives the same DOM-level `paint()` the hover path uses, so a drag
  // costs no renders.
  const scrubIndexRef = useRef<null | number>(null)
  const ticksRef = useRef<HTMLDivElement | null>(null)
  // Set when a scrub ends, so the `pointerup` that ended it doesn't also fire the
  // tick's own onClick and jump somewhere else.
  const scrubbedRef = useRef(false)
  // Where the hold engaged, and on which entry. Every move is measured from
  // here — that is what makes the mapping relative.
  const scrubOriginRef = useRef<null | { index: number; y: number }>(null)
  // Whether the finger is currently past an end stop, so the "nothing further
  // along" buzz fires on the crossing rather than every frame beyond it.
  const endStoppedRef = useRef(false)

  // Read through refs rather than closed over, so `applyScrub` stays stable: the
  // rAF coalescer is built from it, and rebuilding that mid-gesture (a streamed
  // message changes `entries`) would drop the pending frame.
  const activeIndexRef = useRef(activeIndex)
  const entryCountRef = useRef(entries.length)

  activeIndexRef.current = activeIndex
  entryCountRef.current = entries.length

  const jumpTo = useCallback(
    (id: string) => {
      void triggerHaptic('selection')
      // The transcript that owns this key does the work — it is the only thing
      // that can mount a turn the render budget has hidden, and the only thing
      // that can escape stick-to-bottom to reach one. See `store/thread-scroll`.
      requestScrollToTurn(sessionKey, id)
    },
    [sessionKey]
  )

  const applyScrub = useCallback(
    ({ y }: { y: number }) => {
      const origin = scrubOriginRef.current

      if (!origin) {
        return
      }

      const scrub = resolveScrub(origin.index, y - origin.y, entryCountRef.current)

      if (scrub.atEndStop !== endStoppedRef.current) {
        endStoppedRef.current = scrub.atEndStop

        // The rail has no track to rubber-band, so this buzz is the only way it
        // can say there is nothing further in that direction.
        if (scrub.atEndStop) {
          void triggerHaptic('warning')
        }
      }

      if (scrubIndexRef.current === scrub.index) {
        return
      }

      if (scrubIndexRef.current !== null) {
        paint(scrubIndexRef.current, false)
      }

      scrubIndexRef.current = scrub.index
      paint(scrub.index, true)
      void triggerHaptic('selection')
    },
    [paint]
  )

  const mover = useMemo(() => rafCoalesce(applyScrub), [applyScrub])

  // Seeds the gesture on the turn the user is already reading, not on whichever
  // tick the thumb happened to land on — the same reason the bubble row bases
  // its drag on the ACTIVE bubble rather than the one under the press.
  const beginScrub = useCallback(
    (y: number) => {
      const index = activeIndexRef.current

      scrubOriginRef.current = { index, y }
      endStoppedRef.current = false
      scrubIndexRef.current = index
      paint(index, true)
    },
    [paint]
  )

  // The long press is built once, so it reads the live callback through a ref
  // rather than closing over the first render's.
  const beginScrubRef = useRef(beginScrub)
  beginScrubRef.current = beginScrub

  const pickupIdRef = useRef<null | number>(null)

  const pickup = useRef(
    createLongPress({
      moveTolerancePx: SCRUB_MOVE_TOLERANCE_PX,
      ms: SCRUB_LONG_PRESS_MS,
      onFire: ({ y }) => {
        if (pickupIdRef.current === null) {
          return
        }

        setOpen(true)
        void triggerHaptic('warning')
        // Capture so a finger that wanders off the 31px rail keeps scrubbing —
        // which is what gives a 32px-per-turn pitch unlimited reach.
        ticksRef.current?.setPointerCapture?.(pickupIdRef.current)
        beginScrubRef.current(y)
      }
    })
  ).current

  const endScrub = useCallback(
    (jump: boolean) => {
      const index = scrubIndexRef.current

      if (index === null) {
        return
      }

      paint(index, false)
      scrubIndexRef.current = null
      // Cleared so a `pointercancel` arriving after a `pointerup` can't re-apply
      // the coalescer's last value — `finish()` commits `pending` but does not
      // clear it, and `applyScrub` bails without an origin.
      scrubOriginRef.current = null
      endStoppedRef.current = false
      scrubbedRef.current = true
      setOpen(false)

      const entry = jump ? entries[index] : undefined

      if (entry) {
        jumpTo(entry.id)
      }
    },
    [entries, jumpTo, paint]
  )

  useEffect(() => {
    const viewport = queryVisible<HTMLElement>(VIEWPORT)

    if (!viewport || entries.length === 0) {
      return
    }

    let raf = 0

    const compute = () => {
      raf = 0

      const top = viewport.getBoundingClientRect().top

      const offsets = entries.map(entry => {
        const node = viewport.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(entry.id)}"]`)

        // The TURN, not the bubble. `[data-message-id]` is on the sticky human
        // bubble, which reads `--sticky-human-top` for as long as its turn is on
        // screen — so every partly-visible turn measured as "at the top" and the
        // lit tick disagreed with where a jump would actually land.
        return node ? turnStartElement(node).getBoundingClientRect().top - top : null
      })

      const next = activeTimelineIndex(offsets)

      setActiveIndex(prev => (prev === next ? prev : next))
    }

    const onScroll = () => {
      if (!raf) {
        raf = requestAnimationFrame(compute)
      }
    }

    // Initial compute rides the same rAF batching as scroll. A sync call here
    // reads getBoundingClientRect for every user message while other commit
    // effects are still writing styles — on a session switch that interleaving
    // forces a full reflow per read on a large transcript. One rAF later the
    // reads batch into a single layout pass, and back-to-back entries updates
    // (prefetch paint, then resume reconcile) coalesce into one compute.
    onScroll()
    viewport.addEventListener('scroll', onScroll, { passive: true })

    return () => {
      viewport.removeEventListener('scroll', onScroll)

      if (raf) {
        cancelAnimationFrame(raf)
      }
    }
  }, [entries])

  if (entries.length < MIN_ENTRIES) {
    return null
  }

  return (
    <div
      aria-label="Conversation timeline"
      className="group/timeline pointer-events-auto absolute end-0 top-1/2 z-40 flex -translate-y-1/2 flex-col items-end"
      data-slot="thread-timeline"
      data-suppress-pane-reveal=""
      onMouseEnter={keepOpen}
      onMouseLeave={closeSoon}
      role="navigation"
    >
      <TimelineTicks
        activeIndex={activeIndex}
        containerRef={ticksRef}
        entries={entries}
        onHover={paint}
        onJump={id => {
          // The pointerup that ended a scrub also lands here; the scrub already
          // jumped to what the finger chose, which is not what it is over.
          if (scrubbedRef.current) {
            scrubbedRef.current = false

            return
          }

          jumpTo(id)
        }}
        onPointerCancel={() => {
          pickup.cancel()
          pickupIdRef.current = null
          mover.finish()
          endScrub(false)
        }}
        onPointerDown={event => {
          // A mouse keeps hover-to-preview and click-to-jump exactly as they were.
          if (event.pointerType === 'mouse') {
            return
          }

          pickupIdRef.current = event.pointerId
          pickup.down(event.clientX, event.clientY)
        }}
        onPointerMove={event => {
          if (scrubIndexRef.current !== null) {
            // Coalesced to one apply per frame, as the bubble row does.
            mover.push({ y: event.clientY })

            return
          }

          // NOT coalesced: the long press's movement tolerance has to see the
          // raw stream, or how far the finger wandered would depend on how many
          // frames the queue happened to run.
          pickup.move(event.clientX, event.clientY)
        }}
        onPointerUp={() => {
          pickup.up()
          pickupIdRef.current = null
          // Commit the last pending frame BEFORE the index is read.
          mover.finish()
          endScrub(true)
        }}
        tickRefs={tickRefs}
      />
      <TimelinePopover
        activeIndex={activeIndex}
        entries={entries}
        onHover={paint}
        onJump={jumpTo}
        open={open}
        rowRefs={rowRefs}
      />
    </div>
  )
}

const TimelinePopover: FC<{
  activeIndex: number
  entries: TimelineEntry[]
  onHover: (index: number, on: boolean) => void
  onJump: (id: string) => void
  open: boolean
  rowRefs: React.RefObject<(HTMLButtonElement | null)[]>
}> = ({ activeIndex, entries, onHover, onJump, open, rowRefs }) => (
  <div
    className={cn(
      POPOVER_SHELL,
      open ? 'pointer-events-auto opacity-100 translate-x-0' : 'pointer-events-none translate-x-1 opacity-0'
    )}
    data-slot="thread-timeline-popover"
  >
    {entries.map((entry, index) => (
      <button
        aria-label={entry.preview}
        className={cn(ROW_CLASS, index === activeIndex && 'bg-(--ui-row-active-background) text-foreground')}
        key={entry.id}
        onClick={() => onJump(entry.id)}
        ref={listRef(rowRefs, index)}
        type="button"
        {...hoverProps(index, onHover)}
      >
        <span className="block w-full min-w-0 truncate font-medium leading-snug text-foreground">{entry.preview}</span>
      </button>
    ))}
  </div>
)

const TimelineTicks: FC<{
  activeIndex: number
  containerRef: React.RefObject<HTMLDivElement | null>
  entries: TimelineEntry[]
  onHover: (index: number, on: boolean) => void
  onJump: (id: string) => void
  onPointerCancel: () => void
  onPointerDown: (event: React.PointerEvent) => void
  onPointerMove: (event: React.PointerEvent) => void
  onPointerUp: () => void
  tickRefs: React.RefObject<(HTMLSpanElement | null)[]>
}> = ({
  activeIndex,
  containerRef,
  entries,
  onHover,
  onJump,
  onPointerCancel,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  tickRefs
}) => (
  <div
    // `touch-none` on a coarse pointer: `touch-action` is latched when the
    // browser decides what a gesture is, so claiming it once the hold fires
    // would be too late and the scroller would take the drag. The cost is that
    // a scroll starting inside this ~31px strip doesn't scroll — acceptable on
    // the one control whose whole purpose is being dragged along.
    className="flex flex-col items-end py-1 coarse:touch-none"
    data-slot="thread-timeline-ticks"
    onPointerCancel={onPointerCancel}
    onPointerDown={onPointerDown}
    onPointerMove={onPointerMove}
    onPointerUp={onPointerUp}
    ref={containerRef}
  >
    {entries.map((entry, index) => (
      <button
        aria-label={entry.preview}
        className="flex h-2 w-7 cursor-pointer items-center justify-end pe-1"
        key={entry.id}
        onClick={() => onJump(entry.id)}
        type="button"
        {...hoverProps(index, onHover)}
      >
        <span
          className={cn(
            'block h-px w-3 transition-opacity duration-100 ease-out',
            index === activeIndex ? 'bg-(--theme-primary)' : 'dither text-(--ui-text-quaternary) opacity-70'
          )}
          ref={listRef(tickRefs, index)}
        />
      </button>
    ))}
  </div>
)
