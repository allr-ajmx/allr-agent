/**
 * Frame-timing maths for the FPS HUD, kept separate from the DOM so it can be
 * tested — the numbers are the whole product, and an FPS readout that is subtly
 * wrong is worse than none.
 *
 * WHY NOT JUST AVERAGE FPS
 *
 * A second that renders 59 frames at 16 ms and one at 200 ms averages to ~55 fps
 * and reads as fine. It is not fine: the user saw a visible hitch. Average frame
 * rate is the number that hides exactly the defect anyone opens an FPS HUD to
 * find. So the meter reports the shape of the window, not just its mean —
 * worst frame, p95, and a count of frames over budget.
 */

/** A frame this long is a visible hitch, and is also the `longtask` threshold,
 *  so the two counters in the HUD are directly comparable. */
export const LONG_FRAME_MS = 50

export interface FrameStats {
  /** Frames per second across the window — the reciprocal of the MEAN frame
   *  time, so a single long frame drags it down exactly as much as it should. */
  fps: number
  /** Longest frame in the window. The jank number. */
  worstMs: number
  /** 95th-percentile frame time — a hitch that recurs shows up here while the
   *  worst-frame reading could still be a one-off. */
  p95Ms: number
  /** Frames over `LONG_FRAME_MS` in the window. */
  longFrames: number
  sampleCount: number
}

const EMPTY: FrameStats = { fps: 0, longFrames: 0, p95Ms: 0, sampleCount: 0, worstMs: 0 }

/** Percentile of an ALREADY SORTED ascending array, nearest-rank. */
function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) {
    return 0
  }

  const rank = Math.ceil(fraction * sorted.length) - 1

  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)]
}

export function summarize(durations: readonly number[]): FrameStats {
  if (durations.length === 0) {
    return EMPTY
  }

  let total = 0
  let worst = 0
  let longFrames = 0

  for (const ms of durations) {
    total += ms

    if (ms > worst) {
      worst = ms
    }

    if (ms >= LONG_FRAME_MS) {
      longFrames += 1
    }
  }

  const mean = total / durations.length

  return {
    // A zero or negative mean can only come from a clock that didn't move
    // between callbacks; reporting Infinity fps would be worse than reporting 0.
    fps: mean > 0 ? 1000 / mean : 0,
    longFrames,
    p95Ms: percentile([...durations].sort((a, b) => a - b), 0.95),
    sampleCount: durations.length,
    worstMs: worst
  }
}

/**
 * A fixed-size ring of recent frame durations.
 *
 * Fixed-size because the alternative — accumulate and reset every tick — makes
 * the readout flicker between windows and loses a hitch the instant the window
 * rolls. A rolling window keeps a stutter on screen long enough to read it.
 */
export class FrameMeter {
  private readonly ring: Float64Array
  private cursor = 0
  private filled = 0
  /** Fastest frame ever seen, used to infer the display's refresh rate. */
  private bestMs = Number.POSITIVE_INFINITY

  constructor(private readonly capacity = 120) {
    this.ring = new Float64Array(capacity)
  }

  push(durationMs: number): void {
    // Guard the pathological inputs rAF can produce: a first frame measured
    // against an initialisation timestamp, and the enormous gap after the
    // window comes back from the background. Both are real elapsed time, but
    // neither is a rendered frame, and either one poisons every statistic.
    if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 5_000) {
      return
    }

    this.ring[this.cursor] = durationMs
    this.cursor = (this.cursor + 1) % this.capacity
    this.filled = Math.min(this.filled + 1, this.capacity)

    if (durationMs < this.bestMs) {
      this.bestMs = durationMs
    }
  }

  /** Samples oldest-first — the order the sparkline draws in. */
  samples(): number[] {
    const out: number[] = []

    for (let i = 0; i < this.filled; i += 1) {
      out.push(this.ring[(this.cursor - this.filled + i + this.capacity) % this.capacity])
    }

    return out
  }

  stats(): FrameStats {
    return summarize(this.samples())
  }

  /**
   * The display's refresh rate, inferred from the fastest frame observed.
   *
   * Reported rather than assumed to be 60: on a 120 Hz display a steady 60 fps
   * is a HALVED frame rate and the HUD should not call it perfect, and on a
   * 60 Hz one it should not imply headroom that doesn't exist. Snapped to the
   * common panel rates so measurement noise doesn't render as "73 Hz".
   */
  refreshHz(): number {
    if (!Number.isFinite(this.bestMs) || this.bestMs <= 0) {
      return 60
    }

    const measured = 1000 / this.bestMs
    const rates = [30, 48, 50, 60, 72, 75, 90, 100, 120, 144, 165, 240]

    return rates.reduce((best, rate) => (Math.abs(rate - measured) < Math.abs(best - measured) ? rate : best), 60)
  }

  reset(): void {
    this.cursor = 0
    this.filled = 0
    this.bestMs = Number.POSITIVE_INFINITY
  }
}
