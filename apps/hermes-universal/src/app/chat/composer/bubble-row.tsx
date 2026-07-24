import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { useI18n } from '@/i18n'
import { sessionTitle } from '@/lib/chat-runtime'
import { triggerHaptic } from '@/lib/haptics'
import { MessageCircle } from '@/lib/icons'
import { rafCoalesce } from '@/lib/raf-coalesce'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import { $chatBubbles, type ChatBubble, removeBubble, switchToBubble } from '@/store/chat-bubbles'
import { $activeStoredSessionId, $sessions, $unreadFinishedSessionIds, $workingSessionIds } from '@/store/session'

// Distance up (px) before a held bubble arms for close. The pointer must also
// travel more vertically than horizontally, so a diagonal swipe still switches
// rather than closes (same discriminator as the composer pop-out peel gesture).
const UP_CLOSE_PX = 44

interface GestureState {
  startX: number
  startY: number
  base: number
  bubbles: ChatBubble[]
  peeked: number
  armed: boolean
}

interface Preview {
  peeked: number
  closeArmed: boolean
}

/**
 * MOBILE parallel-chat CAROUSEL, mounted just above the composer (outside its
 * box). The active chat is pinned to the horizontal center; the others fan out
 * left/right. Press a bubble to reveal its title (a tooltip above the row, shown
 * only while the press is active); drag left/right to slide the strip and release
 * to switch (the new active animates back to center); drag up to arm (red) and
 * release to close it (non-destructive — see store/chat-bubbles). Hidden until
 * there are 2+ chats.
 */
export function BubbleRow() {
  const { t } = useI18n()
  const bubbles = useStore($chatBubbles)
  const activeId = useStore($activeStoredSessionId)
  const sessions = useStore($sessions)
  const unread = useStore($unreadFinishedSessionIds)
  const working = useStore($workingSessionIds)

  const activeIndex = bubbles.findIndex(b => b.storedSessionId === activeId)

  const [preview, setPreview] = useState<null | Preview>(null)
  const [translate, setTranslate] = useState(0)

  const containerRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([])
  const centersRef = useRef<number[]>([])
  const containerCenterRef = useRef(0)
  const activeIndexRef = useRef(activeIndex)
  const stateRef = useRef<GestureState | null>(null)
  activeIndexRef.current = activeIndex

  const titleOf = useCallback(
    (bubble: ChatBubble | undefined): string => {
      if (!bubble || bubble.storedSessionId === null) {
        return t.sidebar.nav['new-session']
      }

      const session = sessions.find(s => s.id === bubble.storedSessionId)

      return session ? sessionTitle(session) : t.sidebar.nav['new-session']
    },
    [sessions, t]
  )

  // The translate that pins bubble `index` to the container center.
  const centerTranslate = useCallback(
    (index: number) => (index >= 0 ? containerCenterRef.current - (centersRef.current[index] ?? 0) : 0),
    []
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

    return best
  }, [])

  // Measure the (transform-neutral) layout center of every bubble; re-home the
  // strip on the active bubble whenever nothing is being dragged. Bubbles enlarge
  // via CSS scale (not layout width), so these centers stay stable mid-drag.
  const recompute = useCallback(() => {
    const container = containerRef.current

    if (!container) {
      return
    }

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

      // While armed for close, freeze the slide so the red bubble stays put.
      if (!armed) {
        const tx = st.base + dx
        setTranslate(tx)

        const peeked = peekedFor(tx)

        if (peeked !== st.peeked) {
          st.peeked = peeked
          void triggerHaptic('selection')
        }
      }

      setPreview({ closeArmed: armed, peeked: st.peeked })
    },
    [peekedFor]
  )

  const mover = useMemo(() => rafCoalesce(applyMove), [applyMove])

  const onMove = useCallback(
    (event: PointerEvent) => {
      if (!stateRef.current) {
        return
      }

      event.preventDefault()
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
      // on the new active bubble — nothing to snap to here.
      if (target) {
        removeBubble(target.storedSessionId)
      }

      return
    }

    if (target) {
      // No-op inside the store when it's already the active bubble.
      switchToBubble(target.storedSessionId)
    }

    // Animate the strip so the released bubble sits at center. When the switch
    // actually changes the active id this matches the layout effect's re-home;
    // when it was a no-op (released on the active) this un-does the drag offset.
    setTranslate(centerTranslate(st.peeked))
  }, [centerTranslate, mover, onMove])

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
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
        peeked: idx < 0 ? 0 : idx,
        startX: event.clientX,
        startY: event.clientY
      }
      setTranslate(base)
      setPreview({ closeArmed: false, peeked: idx < 0 ? 0 : idx })
      void triggerHaptic('selection')

      window.addEventListener('pointermove', onMove, { passive: false })
      window.addEventListener('pointerup', onEnd)
      window.addEventListener('pointercancel', onEnd)
    },
    [centerTranslate, onEnd, onMove, recompute]
  )

  // Only meaningful once parallel chats exist. (Hooks above run unconditionally.)
  if (bubbles.length < 2) {
    return null
  }

  const dragging = preview !== null
  // The bubble sitting at (or sliding into) center — enlarged + highlighted.
  const centeredIndex = preview ? preview.peeked : activeIndex
  const peekBubble = preview ? bubbles[preview.peeked] : null

  return (
    <div className="relative w-full select-none py-1" data-slot="bubble-row">
      {/* Title tooltip — above the centered bubble, only while a press is active. */}
      {dragging && (
        <div
          className={cn(
            'pointer-events-none absolute -top-9 left-1/2 z-10 max-w-[70%] -translate-x-1/2 truncate rounded-md px-2 py-0.5 text-[0.7rem] font-medium shadow-sm',
            preview?.closeArmed ? 'bg-destructive/15 text-destructive' : 'bg-(--ui-bg-chrome) text-(--ui-text-secondary)'
          )}
        >
          {preview?.closeArmed ? t.composer.bubbles.releaseToClose : titleOf(peekBubble ?? undefined)}
        </div>
      )}

      {/* Clip window — the track slides inside it; bubbles fan past the edges. */}
      <div className="relative w-full touch-none overflow-hidden" ref={containerRef}>
        <div
          className={cn('flex w-max items-center gap-2.5 will-change-transform', !dragging && 'transition-transform duration-300 ease-out')}
          ref={trackRef}
          style={{ transform: `translateX(${translate}px)` }}
        >
          {bubbles.map((bubble, index) => {
            const isCentered = index === centeredIndex
            const armed = isCentered && preview?.closeArmed
            const isUnread = bubble.storedSessionId !== null && unread.includes(bubble.storedSessionId)
            const isWorking = bubble.storedSessionId !== null && working.has(bubble.storedSessionId)

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
                onPointerDown={onPointerDown}
                ref={el => {
                  buttonRefs.current[index] = el
                }}
                type="button"
              >
                <MessageCircle size={18} />
                {(isUnread || isWorking) && (
                  <span
                    className={cn(
                      'absolute top-0.5 right-0.5 size-1.5 rounded-full',
                      isWorking ? 'bg-amber-400' : 'bg-(--ui-red)'
                    )}
                  />
                )}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
