import { useAuiState } from '@assistant-ui/react'
import { type FC, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { queryVisible } from '@/components/pane-shell/pane-visibility'
import { triggerHaptic } from '@/lib/haptics'
import { createLongPress } from '@/lib/long-press'
import { cn } from '@/lib/utils'

import {
  activeTimelineIndex,
  deriveTimelineEntries,
  type TimelineEntry,
  type TimelineSourceMessage
} from './timeline-data'

const MIN_ENTRIES = 4
const VIEWPORT = '[data-slot="aui_thread-viewport"]'
const HOVER_CLOSE_MS = 140

// Touch scrub. The rail is built on hover — the popover opens on mouse-enter and
// each tick lights its row the same way — so on a phone the preview list never
// appeared and a tap on a 2px tick jumped blind. A hold opens the list, a drag
// picks from it, and letting go goes there.
const SCRUB_LONG_PRESS_MS = 280
const SCRUB_MOVE_TOLERANCE_PX = 12

const ROW_CLASS =
  'row-hover relative flex w-full min-w-0 max-w-full select-none overflow-hidden rounded-md px-2 py-1 text-left outline-hidden'

// Surface (border-color/bg/shadow/blur) comes from the shared
// `[data-slot='thread-timeline-popover']` rule in styles.css, so it's 1:1 with
// the dropdown/select/dialog menus. We only own layout + the border/radius here.
const POPOVER_SHELL =
  'absolute right-full top-1/2 z-50 max-h-[min(22rem,calc(100vh-8rem))] w-80 max-w-[min(20rem,calc(100vw-2rem))] -translate-y-1/2 overflow-x-hidden overflow-y-auto overscroll-contain rounded-lg border p-1 text-popover-foreground transition-[opacity,transform] duration-100 ease-out group-hover/timeline:transition-none'

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

// Constant-duration jump (eased), NOT native `behavior:'smooth'` — Chromium's
// smooth scroll animates proportional to distance, so jumping across a long
// thread crawls for seconds. A fixed ~260ms feels instant near or far. A
// shared rAF handle cancels a prior jump so rapid tick clicks don't fight.
let jumpRaf = 0

function jumpScroll(viewport: HTMLElement, top: number, duration = 170): void {
  cancelAnimationFrame(jumpRaf)
  const start = viewport.scrollTop
  const delta = top - start

  if (Math.abs(delta) < 2) {
    viewport.scrollTop = top

    return
  }

  const t0 = performance.now()
  const ease = (t: number) => 1 - (1 - t) ** 3 // easeOutCubic

  const step = (now: number) => {
    const p = Math.min(1, (now - t0) / duration)
    viewport.scrollTop = start + delta * ease(p)

    if (p < 1) {
      jumpRaf = requestAnimationFrame(step)
    }
  }

  jumpRaf = requestAnimationFrame(step)
}

function scrollToPrompt(id: string) {
  const viewport = queryVisible<HTMLElement>(VIEWPORT)
  const node = viewport?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`)

  if (!viewport || !node) {
    return
  }

  const top = viewport.scrollTop + (node.getBoundingClientRect().top - viewport.getBoundingClientRect().top) - 8

  triggerHaptic('selection')
  jumpScroll(viewport, Math.max(0, top))
}

/** Right-edge prompt rail — hover previews, click to jump. ≥4 user turns only. */
export const ThreadTimeline: FC = () => {
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

  /** The tick whose midpoint is nearest a viewport y. */
  const tickAt = useCallback((clientY: number): number => {
    let best = 0
    let bestDistance = Number.POSITIVE_INFINITY

    tickRefs.current.forEach((node, index) => {
      if (!node) {
        return
      }

      const rect = node.getBoundingClientRect()
      const distance = Math.abs((rect.top + rect.bottom) / 2 - clientY)

      if (distance < bestDistance) {
        bestDistance = distance
        best = index
      }
    })

    return best
  }, [])

  const scrubTo = useCallback(
    (clientY: number) => {
      const next = tickAt(clientY)

      if (scrubIndexRef.current === next) {
        return
      }

      if (scrubIndexRef.current !== null) {
        paint(scrubIndexRef.current, false)
      }

      scrubIndexRef.current = next
      paint(next, true)
      void triggerHaptic('selection')
    },
    [paint, tickAt]
  )

  // The long press is built once, so it reads the live callback through a ref
  // rather than closing over the first render's.
  const scrubToRef = useRef(scrubTo)
  scrubToRef.current = scrubTo

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
        // Capture so a finger that wanders off the 31px rail keeps scrubbing.
        ticksRef.current?.setPointerCapture?.(pickupIdRef.current)
        scrubToRef.current(y)
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
      scrubbedRef.current = true
      setOpen(false)

      const entry = jump ? entries[index] : undefined

      if (entry) {
        scrollToPrompt(entry.id)
      }
    },
    [entries, paint]
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

        return node ? node.getBoundingClientRect().top - top : null
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
      className="group/timeline pointer-events-auto absolute right-0 top-1/2 z-40 flex -translate-y-1/2 flex-col items-end"
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

          scrollToPrompt(id)
        }}
        onPointerCancel={() => {
          pickup.cancel()
          pickupIdRef.current = null
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
            scrubToRef.current(event.clientY)

            return
          }

          pickup.move(event.clientX, event.clientY)
        }}
        onPointerUp={() => {
          pickup.up()
          pickupIdRef.current = null
          endScrub(true)
        }}
        tickRefs={tickRefs}
      />
      <TimelinePopover
        activeIndex={activeIndex}
        entries={entries}
        onHover={paint}
        onJump={scrollToPrompt}
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
        className="flex h-2 w-7 cursor-pointer items-center justify-end pr-1"
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
