import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'

import { useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import { MessageCircle, Plus } from '@/lib/icons'
import { rafCoalesce } from '@/lib/raf-coalesce'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import {
  $chatBubbles,
  bubbleRuntimeKey,
  type ChatBubble,
  newChatBubble,
  requestRemoveBubble,
  switchToBubble
} from '@/store/chat-bubbles'
import { $draftTitles, draftTitleIn } from '@/store/composer'
import { $activeStoredSessionId, refreshSessions } from '@/store/session'
import { chatTabTitle, useSessionRowLookup } from '@/store/session-lookup'

import { SessionStatusDot } from '../session-status-dot'

import { newSessionProgress, type NewSessionSide, resolveDrag, type TrackBounds } from './bubble-drag'

// Distance up (px) before a held bubble arms for close. The pointer must also
// travel more vertically than horizontally, so a diagonal swipe still switches
// rather than closes (same discriminator as the composer pop-out peel gesture).
const UP_CLOSE_PX = 44

// How far the pointer may wander and still count as a TAP. A tap is the one
// thing the row could not do: the gesture acts on whatever is centred, so a
// press on an off-centre bubble resolved to "switch to the chat you are already
// in". Small, because every larger movement is already a meaningful drag.
const TAP_SLOP_PX = 8

interface GestureState {
  startX: number
  startY: number
  base: number
  bubbles: ChatBubble[]
  peeked: number
  armed: boolean
  /** The bubble the press LANDED on, if any — the tap target, which is not the
   *  same thing as `peeked` (the bubble a drag has slid to the centre). Null for
   *  a press that started on empty track. */
  tapIndex: null | number
  /** Furthest the pointer has travelled from where it went down. Anything past
   *  `TAP_SLOP_PX` is a drag, and the tap target is forgotten. */
  moved: number
  /** Past the new-session commit threshold — tracked so the haptic fires once
   *  on the crossing rather than every frame beyond it. */
  newArmed: boolean
  /** Which end the gap was pulled open on. Read on release: the ghost the user
   *  watched grow is on this side, so the real bubble has to land there. */
  newSide: NewSessionSide | null
  /** Whether pulling past an end can produce anything, captured at press time.
   *  It cannot when the chat you are on IS the unsaved draft — there is no
   *  second draft to make — and arming a gesture that the store will refuse is
   *  how the row came to promise a new chat and then just switch you somewhere
   *  else. */
  canNew: boolean
}

interface Preview {
  peeked: number
  closeArmed: boolean
  /** Which empty side the new-session bubble is showing on, if any. */
  newSide: NewSessionSide | null
  newArmed: boolean
  /** 0 → 1 across reveal→commit, for growing the ghost in. */
  newProgress: number
}

/**
 * MOBILE parallel-chat CAROUSEL, mounted just above the composer (outside its
 * box). The active chat is pinned to the horizontal center; the others fan out
 * left/right.
 *
 * The whole row is the gesture surface — anywhere in it, dot or gap or the empty
 * track past the ends. TAP a bubble to switch straight to it; press to reveal the
 * centred chat's title (a tooltip above the row, shown only while the press is
 * active); drag left/right to slide the strip and release to switch (the new
 * active animates back to center); drag up to arm the centred bubble (red) and
 * release to close it (non-destructive — see store/chat-bubbles); drag out past
 * either end to open a new chat on that side. Hidden until there are 2+ chats.
 */
export function BubbleRow() {
  const { t } = useI18n()
  const bubbles = useStore($chatBubbles)
  const activeId = useStore($activeStoredSessionId)
  // The WIDE lookup, not a `$sessions.find(...)`. The recents page is
  // paginated, so a bubble for an older chat resolved to nothing: a title
  // permanently stuck on "Loading…" (MJXHRM-386's own symptom, which the tile
  // tab and the workspace tab were moved off this find for) and — now that the
  // shared status dot renders here — no project colour on its idle dot either.
  // The lookup form, because hooks cannot run inside the bubble `map`.
  const rowFor = useSessionRowLookup()

  // The active id arrives a beat after the persisted bubbles do, so on a cold
  // load `findIndex` is -1 for a moment. Centre the first bubble meanwhile —
  // `centerTranslate(-1)` is 0, which is not "no bubble centred" but "the strip
  // pinned to the left edge", and that is what the whole row looked like on
  // every fresh start.
  const foundIndex = bubbles.findIndex(b => b.storedSessionId === activeId)
  const activeIndex = foundIndex >= 0 ? foundIndex : 0

  const [preview, setPreview] = useState<null | Preview>(null)
  const [translate, setTranslate] = useState(0)

  const containerRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([])
  const centersRef = useRef<number[]>([])
  const containerCenterRef = useRef(0)
  const activeIndexRef = useRef(activeIndex)
  const stateRef = useRef<GestureState | null>(null)
  // How many bubbles are actually rendered. `buttonRefs` is an index-keyed array
  // that only ever grows: closing a bubble leaves React's `null` cleanup at the
  // tail, `recompute` measured it as a centre of 0, and that phantom centre
  // INVERTED `trackBounds` — its `min` became the container centre, past `max` —
  // which collapsed the drag range to a few px and let `peekedFor` pick an index
  // no bubble owns. That is the row that stops sliding after a close.
  const bubbleCountRef = useRef(bubbles.length)
  activeIndexRef.current = activeIndex
  bubbleCountRef.current = bubbles.length

  // The strip IS this phone's tab bar, so it names a chat the way a tab does —
  // including the draft, which is named after what has been typed into it (the
  // peek label is the only place a bubble says anything at all, so an unsent
  // message is the only thing that can tell the two blank ones apart).
  const draftTitles = useStore($draftTitles)

  const titleOf = useCallback(
    (bubble: ChatBubble | undefined): string => {
      // Only a bubble with no stored id is genuinely a new chat. An id we cannot
      // resolve is a loaded chat whose title has not arrived — saying "New
      // session" for it made every bubble claim to be one on a cold start.
      const storedSessionId = bubble?.storedSessionId ?? null

      return chatTabTitle({
        // `bubbleRuntimeKey(null)` is the live draft slice — the key the
        // composer stashes this chat's text under.
        draftTitle: storedSessionId ? undefined : draftTitleIn(draftTitles, bubbleRuntimeKey(null)),
        selected: storedSessionId,
        stored: rowFor(storedSessionId)
      })
    },
    [draftTitles, rowFor]
  )

  // Bubble titles come from the session list, and on a phone nothing else pulls
  // it — the sidebar is a separate surface that may never have been opened. So
  // the row asks for it when it holds ids it cannot name.
  const unresolved = bubbles.some(b => b.storedSessionId !== null && !rowFor(b.storedSessionId))

  useEffect(() => {
    if (unresolved) {
      void refreshSessions()
    }
    // Deliberately keyed on the flag, not the lists: this must fire when ids go
    // unresolved, not on every session-list update.
  }, [unresolved])

  // The translate that pins bubble `index` to the container center.
  const centerTranslate = useCallback(
    (index: number) => (index >= 0 ? containerCenterRef.current - (centersRef.current[index] ?? 0) : 0),
    []
  )

  // The translates that park the first and last bubble at the centre. Dragging
  // stops here: past it the strip has nothing left to show, and letting it keep
  // sliding is what made the highlight and the centred bubble disagree.
  const trackBounds = useCallback(
    (): TrackBounds => ({
      max: centerTranslate(0),
      min: centerTranslate(Math.max(0, centersRef.current.length - 1))
    }),
    [centerTranslate]
  )

  // The bubble nearest the center for a given track translate.
  const peekedFor = useCallback((tx: number) => {
    const centers = centersRef.current
    const target = containerCenterRef.current - tx
    let best = 0
    let bestDist = Number.POSITIVE_INFINITY

    centers.forEach((c, i) => {
      const dist = Math.abs(c - target)

      if (dist < bestDist) {
        bestDist = dist
        best = i
      }
    })

    // Never past the last bubble: `centers` is measured, and a frame where it is
    // shorter than the list (or empty, before the first layout effect) must
    // still answer an index the row can act on.
    return Math.min(best, Math.max(0, centers.length - 1))
  }, [])

  // The bubble under a pointer, or null on empty track. Measured off the live
  // rects rather than `centersRef`, so it is right under the centred bubble's
  // `scale-110` and mirrors for free in RTL.
  const indexAtPoint = useCallback((clientX: number) => {
    const buttons = buttonRefs.current

    for (let i = 0; i < bubbleCountRef.current; i++) {
      const rect = buttons[i]?.getBoundingClientRect()

      if (rect && clientX >= rect.left && clientX <= rect.right) {
        return i
      }
    }

    return null
  }, [])

  // Measure the (transform-neutral) layout center of every bubble; re-home the
  // strip on the active bubble whenever nothing is being dragged. Bubbles enlarge
  // via CSS scale (not layout width), so these centers stay stable mid-drag.
  const recompute = useCallback(() => {
    const container = containerRef.current

    if (!container) {
      return
    }

    // Trim first: everything past the live count is a closed bubble's leftover
    // slot, and measuring it writes a centre of 0 into the geometry every other
    // calculation here reads.
    buttonRefs.current.length = bubbleCountRef.current
    centersRef.current = buttonRefs.current.map(el => (el ? el.offsetLeft + el.offsetWidth / 2 : 0))
    containerCenterRef.current = container.clientWidth / 2

    if (!stateRef.current) {
      setTranslate(centerTranslate(activeIndexRef.current))
    }
  }, [centerTranslate])

  useLayoutEffect(() => {
    recompute()
  }, [recompute, bubbles.length, activeIndex])

  useEffect(() => {
    const container = containerRef.current

    if (!container || typeof ResizeObserver === 'undefined') {
      return
    }

    const ro = new ResizeObserver(() => recompute())
    ro.observe(container)

    return () => ro.disconnect()
  }, [recompute])

  const applyMove = useCallback(
    ({ x, y }: { x: number; y: number }) => {
      const st = stateRef.current

      if (!st) {
        return
      }

      const dx = x - st.startX
      const dy = y - st.startY
      const armed = -dy > UP_CLOSE_PX && -dy > Math.abs(dx)

      if (armed !== st.armed) {
        st.armed = armed

        if (armed) {
          void triggerHaptic('warning')
        }
      }

      // While armed for close, freeze the slide so the red bubble stays put —
      // and with it any new-session arming, so one gesture can't mean both.
      if (armed) {
        setPreview({ closeArmed: true, newArmed: false, newProgress: 0, newSide: null, peeked: st.peeked })

        return
      }

      const drag = resolveDrag(st.base + dx, trackBounds())
      setTranslate(drag.translate)

      // Peek from the CLAMPED translate: past the end stop there is no further
      // bubble, so the end one stays picked however hard you pull.
      const peeked = peekedFor(drag.clamped)

      if (peeked !== st.peeked) {
        st.peeked = peeked
        void triggerHaptic('selection')
      }

      // Overdragging still rubber-bands — that is what says "nothing further
      // along" — but with no ghost, no buzz and no arming when there is nothing
      // to create.
      const newSide = st.canNew ? drag.newSessionSide : null
      const newArmed = st.canNew && drag.newSessionArmed

      st.newSide = newSide

      if (newArmed !== st.newArmed) {
        st.newArmed = newArmed

        // Same cue the close gesture uses: "you have armed something, let go".
        if (newArmed) {
          void triggerHaptic('warning')
        }
      }

      setPreview({
        closeArmed: false,
        newArmed,
        newProgress: newSide ? newSessionProgress(drag.overshoot) : 0,
        newSide,
        peeked: st.peeked
      })
    },
    [peekedFor, trackBounds]
  )

  const mover = useMemo(() => rafCoalesce(applyMove), [applyMove])

  const onMove = useCallback(
    (event: PointerEvent) => {
      const st = stateRef.current

      if (!st) {
        return
      }

      event.preventDefault()
      // Measured HERE and not in the coalesced `applyMove`: whether this was a
      // tap must not depend on how many frames the rAF queue happened to run.
      st.moved = Math.max(st.moved, Math.hypot(event.clientX - st.startX, event.clientY - st.startY))
      mover.push({ x: event.clientX, y: event.clientY })
    },
    [mover]
  )

  const onEnd = useCallback(() => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onEnd)
    window.removeEventListener('pointercancel', onEnd)
    mover.finish()

    const st = stateRef.current
    stateRef.current = null
    setPreview(null)

    if (!st) {
      return
    }

    const target = st.bubbles[st.peeked]

    if (st.armed) {
      // Close removes a bubble; the list shrinks and the layout effect re-homes
      // on the new active bubble — nothing to snap to here. The REQUEST form:
      // a chat still working gets the same "Close running tab?" prompt the
      // desktop tile close has always shown, so the row shrinks only once the
      // answer is in (MJXHRM-390).
      if (target) {
        requestRemoveBubble(target.storedSessionId)
      }

      return
    }

    if (st.newArmed) {
      // Dragged out past the end of the strip and let go: the empty side you
      // pulled open becomes a new chat. Dragging back inside the threshold
      // before releasing falls through below instead, which lands on the end
      // bubble — so the gesture is reversible right up to the last moment.
      //
      // It joins the strip on the side the gap was pulled open on. The ghost
      // grew there and that is where the user is looking; appending to the far
      // end instead made the new chat appear behind them.
      newChatBubble(st.newSide ?? 'end')
      // Un-does the overdrag. The layout effect re-homes on the draft once the
      // list changes, but a call that only MOVES an existing draft bubble may
      // leave the length alone — so put the strip back either way.
      setTranslate(centerTranslate(st.peeked))

      return
    }

    // A TAP acts on the bubble under the thumb; a drag acts on whatever it slid
    // to the centre. Both then animate that bubble home, so the two gestures end
    // the same way and a tap is not a special case anyone has to learn.
    const tap = st.moved <= TAP_SLOP_PX ? st.tapIndex : null
    const index = tap ?? st.peeked
    const landing = tap === null ? target : st.bubbles[tap]

    if (landing) {
      // No-op inside the store when it's already the active bubble.
      switchToBubble(landing.storedSessionId)
    }

    // Animate the strip so the released bubble sits at center. When the switch
    // actually changes the active id this matches the layout effect's re-home;
    // when it was a no-op (released on the active) this un-does the drag offset.
    setTranslate(centerTranslate(index))
  }, [centerTranslate, mover, onMove])

  // Bound to the ROW, not to each bubble. The bubbles are 32px dots with 10px
  // gaps and empty track either side of them, so requiring the press to land on
  // one made the carousel a gesture you had to aim at: a swipe that started in a
  // gap did nothing, and the close gesture was unreachable unless your thumb
  // happened to be on the centred dot. The gesture never needed the bubble you
  // touched anyway — it slides the strip and acts on whatever is centred — so
  // anywhere in the row is a valid place to start it.
  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) {
        return
      }

      event.preventDefault()
      recompute()

      const idx = activeIndexRef.current
      const base = centerTranslate(idx)

      stateRef.current = {
        armed: false,
        base,
        bubbles: $chatBubbles.get(),
        // Read from the store, not from the render's `activeId`: the press is
        // the moment this is true or not.
        canNew: $activeStoredSessionId.get() !== null,
        moved: 0,
        newArmed: false,
        newSide: null,
        peeked: idx < 0 ? 0 : idx,
        startX: event.clientX,
        startY: event.clientY,
        // `peeked` stays on the ACTIVE bubble — that is drag state, and seeding
        // it from the tap target would make a drag that starts off-centre jump.
        tapIndex: indexAtPoint(event.clientX)
      }
      setTranslate(base)
      setPreview({
        closeArmed: false,
        newArmed: false,
        newProgress: 0,
        newSide: null,
        peeked: idx < 0 ? 0 : idx
      })
      void triggerHaptic('selection')

      window.addEventListener('pointermove', onMove, { passive: false })
      window.addEventListener('pointerup', onEnd)
      window.addEventListener('pointercancel', onEnd)
    },
    [centerTranslate, indexAtPoint, onEnd, onMove, recompute]
  )

  // Only meaningful once parallel chats exist. (Hooks above run unconditionally.)
  if (bubbles.length < 2) {
    return null
  }

  const dragging = preview !== null
  // The bubble sitting at (or sliding into) center — enlarged + highlighted.
  const centeredIndex = preview ? preview.peeked : activeIndex
  const peekBubble = preview ? bubbles[preview.peeked] : null
  // Only the side actually being pulled open shows a ghost; the other stays at 0.
  const progressFor = (side: NewSessionSide) => (preview?.newSide === side ? preview.newProgress : 0)

  return (
    <div className="relative w-full select-none" data-slot="bubble-row">
      {/* Title tooltip — above the centered bubble, only while a press is active. */}
      {dragging && (
        <div
          className={cn(
            // eslint-disable-next-line better-tailwindcss/no-restricted-classes -- centring, not an edge — pairs with a physical -translate-x-1/2, and start-1/2 would resolve to right:50% while the transform still pulled left
            'pointer-events-none absolute -top-9 left-1/2 z-10 max-w-[70%] -translate-x-1/2 truncate rounded-md px-2 py-0.5 text-[0.7rem] font-medium shadow-sm',
            preview?.closeArmed
              ? 'bg-destructive/15 text-destructive'
              : preview?.newArmed
                ? 'bg-primary/15 text-primary'
                : 'bg-(--ui-bg-chrome) text-(--ui-text-secondary)'
          )}
        >
          {preview?.closeArmed
            ? t.composer.bubbles.releaseToClose
            : preview?.newArmed
              ? t.composer.bubbles.releaseForNewChat
              : titleOf(peekBubble ?? undefined)}
        </div>
      )}

      {/* Clip window — the track slides inside it; bubbles fan past the edges.
          The vertical padding is what the centred bubble's `scale-110` needs:
          `overflow-hidden` clips both axes (CSS won't let one be `visible` while
          the other is `hidden`) and the strip must clip horizontally, so the
          enlarged bubble was being shaved top and bottom. The padding moved here
          off the wrapper, so the row's total height is unchanged. */}
      <div
        className="relative w-full touch-none overflow-hidden py-1"
        data-slot="bubble-track"
        onPointerDown={onPointerDown}
        ref={containerRef}
      >
        <div
          className={cn(
            'relative flex w-max items-center gap-2.5 will-change-transform',
            !dragging && 'transition-transform duration-300 ease-out'
          )}
          ref={trackRef}
          style={{ transform: `translateX(${translate}px)` }}
        >
          {/* The new-session bubbles flank the strip and are ABSOLUTE, not flex
              children: laid out they would shift every `offsetLeft` that
              `recompute` measures, moving the real bubbles to make room for
              something that is invisible almost all of the time. */}
          <NewSessionGhost armed={Boolean(preview?.newArmed)} progress={progressFor('start')} side="start" />
          <NewSessionGhost armed={Boolean(preview?.newArmed)} progress={progressFor('end')} side="end" />

          {bubbles.map((bubble, index) => {
            const isCentered = index === centeredIndex
            const armed = isCentered && preview?.closeArmed
            const session = rowFor(bubble.storedSessionId)

            return (
              <button
                aria-label={titleOf(bubble)}
                className={cn(
                  'relative flex size-8 shrink-0 touch-none items-center justify-center rounded-full transition-[transform,color,background-color] duration-200',
                  armed
                    ? 'scale-110 bg-destructive/15 text-destructive'
                    : isCentered
                      ? 'scale-110 bg-(--ui-bg-chrome) text-(--ui-text-primary)'
                      : 'scale-90 text-(--ui-text-tertiary)'
                )}
                key={bubble.storedSessionId ?? 'draft'}
                ref={el => {
                  buttonRefs.current[index] = el
                }}
                type="button"
              >
                <MessageCircle size={18} />
                {/* The SAME status dot the sidebar row, the pane tabs and the
                    switcher render — this badge used to paint amber for a
                    RUNNING turn and red for an unread one, which is the amber
                    every other surface reserves for "needs your input" and a
                    colour nothing else uses. A bubble is a session; it says
                    what a session says. */}
                <SessionStatusDot
                  className="absolute top-0.5 end-0.5"
                  session={session}
                  storedSessionId={bubble.storedSessionId}
                />
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/**
 * The bubble that appears in the empty space past the end of the strip, and
 * becomes a new chat if you let go there.
 *
 * It grows and solidifies across the reveal→commit span rather than popping in
 * at the end, so the commit point is something you watch approach instead of
 * something you are told about once you have passed it. Sized and offset to sit
 * exactly where the next real bubble would (`size-8` + the track's `gap-2.5`).
 */
function NewSessionGhost({ armed, progress, side }: { armed: boolean; progress: number; side: NewSessionSide }) {
  if (progress <= 0) {
    return null
  }

  return (
    <div
      aria-hidden
      className={cn(
        'pointer-events-none absolute top-1/2 flex size-8 items-center justify-center rounded-full',
        side === 'start' ? '-start-[2.625rem]' : '-end-[2.625rem]',
        armed ? 'bg-primary text-primary-foreground' : 'bg-primary/15 text-primary'
      )}
      style={{
        opacity: 0.5 + 0.5 * progress,
        // One inline transform: a Tailwind `-translate-y-1/2` would be replaced
        // by this rather than composed with it.
        transform: `translateY(-50%) scale(${0.7 + 0.4 * progress})`
      }}
    >
      <Plus size={18} />
    </div>
  )
}
