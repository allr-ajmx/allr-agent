// Landing on a turn, kept out of the rail that asks for it.
//
// Scrolling a transcript to a turn is three separate problems wearing one coat,
// and the rail used to solve none of them:
//
//   - WHERE a turn starts. `[data-message-id]` is on the human bubble, which is
//     `position: sticky`. Its containing block is the turn wrapper, so while
//     that turn is on screen the bubble is STUCK and its rect reads
//     `--sticky-human-top` (~3.7px) whatever the scroll position. Measuring it
//     to compute a jump gives a delta of ~0 — the jump that does nothing and
//     leaves you where you already were.
//   - HOW to get there. Not `behavior:'smooth'`: Chromium animates it
//     proportional to distance, so crossing a long thread crawls for seconds.
//   - Whether you ARRIVED. Off-screen turns carry a `contain-intrinsic-size`
//     ESTIMATE until they paint, so a long jump is computed against guesses and
//     lands near, not on.

import { pendingMediaCount } from '@/lib/media'

/** The turn wrapper's slot. Exported so the list renders the same string this
 *  module queries — the attribute and its only reader in one place. */
export const TURN_PAIR_SLOT = 'aui_turn-pair'

/** Viewport left above a landed turn. Deliberately under `activeTimelineIndex`'s
 *  8px slack: at 8 a sub-pixel rounding after the jump put the turn just outside
 *  the slack and the rail lit the PREVIOUS tick. */
export const TURN_TOP_MARGIN_PX = 4

/** Fixed-duration jump. Feels the same near or far, which is the whole reason
 *  this is hand-rolled rather than `behavior:'smooth'`. */
export const JUMP_DURATION_MS = 170

/** How long the correction pass may keep chasing a moving target before it
 *  accepts where it is. An escape hatch, not a settle condition. */
export const LANDING_CAP_MS = 600

/**
 * The non-sticky element a turn actually starts at.
 *
 * Standalone messages (anything not led by a human prompt) get no wrapper, so
 * the node itself is the honest answer for them.
 */
export function turnStartElement(node: HTMLElement): HTMLElement {
  return node.closest<HTMLElement>(`[data-slot="${TURN_PAIR_SLOT}"]`) ?? node
}

/** The scrollTop that puts `turnTop` exactly `margin` px below `viewportTop`. */
export function turnScrollTop({
  margin,
  scrollTop,
  turnTop,
  viewportTop
}: {
  margin: number
  scrollTop: number
  turnTop: number
  viewportTop: number
}): number {
  return Math.max(0, scrollTop + (turnTop - viewportTop) - margin)
}

export interface LandingState {
  /** Px the turn's top is still away from where it belongs. */
  deltaPx: number
  elapsedMs: number
  pendingMedia: number
  stableFrames: number
}

/**
 * Is the landing done?
 *
 * Three signals rather than one, for the same reason `consolidationVerdict`
 * takes three: a transcript whose images are still resolving holds still for a
 * frame at the wrong offset, and distance alone reads that as arrival.
 */
export function landingVerdict(state: LandingState): 'correct' | 'settled' | 'timeout' {
  if (Math.abs(state.deltaPx) < 1 && state.stableFrames >= 2 && state.pendingMedia === 0) {
    return 'settled'
  }

  if (state.elapsedMs >= LANDING_CAP_MS) {
    return 'timeout'
  }

  return 'correct'
}

/**
 * Put `turn` at the top of `viewport`, then hold it there while the rows around
 * it resolve their real heights.
 *
 * The rAF handle is owned by the returned canceller rather than living at module
 * scope: several transcripts can be mounted at once (a grid split), and a shared
 * handle meant one pane's jump cancelled another's mid-flight.
 */
export function scrollTurnToTop(
  viewport: HTMLElement,
  turn: HTMLElement,
  { margin = TURN_TOP_MARGIN_PX, onSettled }: { margin?: number; onSettled?: () => void } = {}
): () => void {
  let raf = 0
  let done = false

  const offset = () => turn.getBoundingClientRect().top - viewport.getBoundingClientRect().top - margin

  const finish = () => {
    done = true
    onSettled?.()
  }

  const startedAt = performance.now()
  const from = viewport.scrollTop

  const delta =
    turnScrollTop({
      margin,
      scrollTop: from,
      turnTop: turn.getBoundingClientRect().top,
      viewportTop: viewport.getBoundingClientRect().top
    }) - from

  const ease = (t: number) => 1 - (1 - t) ** 3 // easeOutCubic

  let stableFrames = 0

  // Phase two: the turn is roughly in place, but every row that just painted
  // may have replaced a `contain-intrinsic-size` guess with its real height and
  // moved it again. Corrections are INSTANT — the user is already looking at
  // the right neighbourhood, and animating a 40px estimate error reads as the
  // view sliding away on its own.
  const correct = () => {
    if (done) {
      return
    }

    const deltaPx = offset()

    const verdict = landingVerdict({
      deltaPx,
      elapsedMs: performance.now() - startedAt,
      pendingMedia: pendingMediaCount(),
      stableFrames
    })

    if (verdict !== 'correct') {
      finish()

      return
    }

    if (Math.abs(deltaPx) < 1) {
      stableFrames += 1
    } else {
      stableFrames = 0
      viewport.scrollTop += deltaPx
    }

    raf = requestAnimationFrame(correct)
  }

  const step = (now: number) => {
    if (done) {
      return
    }

    const progress = Math.min(1, (now - startedAt) / JUMP_DURATION_MS)
    viewport.scrollTop = from + delta * ease(progress)

    raf = requestAnimationFrame(progress < 1 ? step : correct)
  }

  // A jump of nothing still runs the correction pass: "already there" is exactly
  // the case where the target was measured off an estimate.
  raf = requestAnimationFrame(Math.abs(delta) < 2 ? correct : step)

  return () => {
    if (done) {
      return
    }

    done = true
    cancelAnimationFrame(raf)
  }
}
