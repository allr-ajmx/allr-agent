/**
 * RESIZE GESTURES — "is the user sizing something right now", and what everyone
 * downstream should do about it.
 *
 * The layout tree already resizes cheaply: the sash previews with inline styles
 * and commits to the store once on release (tree/renderer/tree-split.tsx). What
 * still costs a drag is everything DOWNSTREAM of the width change — every
 * ResizeObserver in the app re-firing at frame rate:
 *
 *  - `useResizeObserver` consumers: `measureClamp` runs once per chat bubble, so
 *    a transcript with ~100 of them is ~100 handler calls and setStates a frame.
 *  - the terminal re-fits xterm AND sends a PTY resize over IPC, per frame.
 *  - the chat virtualizer recomputes its window, per frame.
 *
 * None of that is legible mid-drag — the seam moves faster than anyone can read
 * a reflowing transcript — so it is throttled to a handful of updates a second,
 * with a guaranteed final pass when the gesture ends.
 *
 * ── Why the rate is a SETTING and not a constant ────────────────────────────
 * Two open questions, both answerable only on a real build. The remaining frame
 * cost has not been traced since the shared-observer batching landed, so it may
 * be layout/paint rather than script — in which case throttling changes nothing
 * visible, and `'off'` is the two-click A/B that proves it. And a coarse throttle
 * trades a low-but-smooth frame rate for visible STEPPING, which some eyes find
 * worse than the stutter it replaces; that is a preference, not a fact.
 *
 * The preset atom is also the seam the optimization profile plugs into later: a
 * profile picks a preset, it doesn't reimplement the throttle.
 */

import { type Codec, Codecs, persistentAtom } from '@/lib/persisted'

// ---------------------------------------------------------------------------
// Gesture tracking
// ---------------------------------------------------------------------------

/** A window resize has no pointerup, so the gesture ends after this much quiet. */
const WINDOW_RESIZE_TAIL_MS = 200

/**
 * How long a gesture must run before the calm state (below) engages. Short
 * enough to cover any real drag, long enough that nudging a sash never flashes.
 */
const CALM_GRACE_MS = 250

// A depth counter rather than a boolean, so overlapping gestures nest safely
// (moved here from pane-shell/geometry.ts, which owned it when the sash was the
// only source).
let depth = 0
let windowTail: null | ReturnType<typeof setTimeout> = null
let calmTimer: null | ReturnType<typeof setTimeout> = null

const endListeners = new Set<() => void>()

export const resizeGestureActive = (): boolean => depth > 0

export function beginResizeGesture(): void {
  depth += 1

  if (depth === 1) {
    scheduleCalm()
  }
}

export function endResizeGesture(): void {
  depth = Math.max(0, depth - 1)

  if (depth > 0) {
    return
  }

  clearCalm()

  // Copied before iterating: a listener that unsubscribes itself (the common
  // one-shot flush) would otherwise mutate the set mid-loop.
  for (const listener of [...endListeners]) {
    listener()
  }
}

/**
 * Run `cb` when the current gesture ends. Returns a disposer.
 *
 * This replaced a single-slot callback in geometry.ts — it has three subscribers
 * now (the workspace geometry vars, and a trailing flush per throttled handler),
 * and a slot silently drops all but the last.
 */
export function onResizeGestureEnd(cb: () => void): () => void {
  endListeners.add(cb)

  return () => endListeners.delete(cb)
}

/**
 * Treat an OS window resize as a gesture too. There is no pointerdown to hook,
 * so the first event opens one and `WINDOW_RESIZE_TAIL_MS` of quiet closes it.
 *
 * Attached lazily on first use rather than at module scope: importing this file
 * must not touch the DOM (tests, and the satellite windows that never mount the
 * tree).
 */
let windowWatched = false

function watchWindowResize(): void {
  if (windowWatched || typeof window === 'undefined') {
    return
  }

  windowWatched = true

  window.addEventListener('resize', () => {
    if (windowTail === null) {
      beginResizeGesture()
    } else {
      clearTimeout(windowTail)
    }

    windowTail = setTimeout(() => {
      windowTail = null
      endResizeGesture()
    }, WINDOW_RESIZE_TAIL_MS)
  })
}

// ---------------------------------------------------------------------------
// The rate
// ---------------------------------------------------------------------------

/**
 * Which surface a throttled handler belongs to.
 *
 * Every category resolves to the same rate today. The tag exists so the
 * optimization profile can later say "terminal off mid-drag, chat at 10/s"
 * without revisiting a single call site.
 */
export type ResizeCategory = 'chat' | 'terminal' | 'virtual'

export type ResizeThrottlePreset = 'balanced' | 'battery' | 'off' | 'smooth'

/** `off` is a genuine pass-through, not a very small interval — see below. */
export const RESIZE_THROTTLE_MS: Record<ResizeThrottlePreset, number> = {
  off: 0,
  smooth: 100,
  balanced: 180,
  battery: 300
}

export const RESIZE_THROTTLE_PRESETS = Object.keys(RESIZE_THROTTLE_MS) as readonly ResizeThrottlePreset[]

const isPreset = (value: string): value is ResizeThrottlePreset => value in RESIZE_THROTTLE_MS

// Unknown stored values fall back rather than throwing: this is a UI pref read
// at module load, and a hand-edited localStorage must not brick the app.
const presetCodec: Codec<ResizeThrottlePreset> = {
  decode: raw => (isPreset(raw) ? raw : 'balanced'),
  encode: value => value
}

export const $resizeThrottle = persistentAtom<ResizeThrottlePreset>(
  'hermes.resizeThrottle',
  'balanced',
  presetCodec
)

/** Milliseconds between updates for `category` while a gesture is running. */
export function resizeThrottleMs(category: ResizeCategory): number {
  // ponytail: one rate for every category; fan out per-category when a profile needs it
  void category

  return RESIZE_THROTTLE_MS[$resizeThrottle.get()]
}

/** Updates per second a preset works out to — the settings caption. */
export const resizeThrottleHz = (preset: ResizeThrottlePreset): number =>
  RESIZE_THROTTLE_MS[preset] === 0 ? 0 : Math.round(1000 / RESIZE_THROTTLE_MS[preset])

// ---------------------------------------------------------------------------
// The lever
// ---------------------------------------------------------------------------

/**
 * Wrap a resize handler so it runs at most `resizeThrottleMs(category)` apart
 * WHILE a gesture is in progress, and untouched the rest of the time.
 *
 * Outside a gesture this is a pass-through, which is the whole safety argument:
 * mount measurement, session switches and a composer growing as you type behave
 * exactly as they did before this module existed. Only the drag is throttled.
 *
 * The interval is read PER CALL, not captured when the handler is wrapped —
 * changing the preset has to take effect on the next drag, not on the next
 * remount of whatever component happened to own the handler.
 *
 * Handlers must be idempotent and last-write-wins (recompute from current
 * geometry, never accumulate a delta) — dropped intermediate calls are the point.
 */
export function throttleDuringResize<A extends unknown[]>(
  category: ResizeCategory,
  fn: (...args: A) => void
): (...args: A) => void {
  let timer: null | ReturnType<typeof setTimeout> = null
  let pending: A | null = null
  let lastRun = 0
  let releaseEndHook: (() => void) | null = null

  const run = (args: A) => {
    lastRun = Date.now()
    pending = null
    fn(...args)
  }

  // The trailing edge. Also the gesture-end flush, so the final geometry always
  // lands even if the gesture stops mid-window.
  const flush = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }

    releaseEndHook?.()
    releaseEndHook = null

    if (pending) {
      run(pending)
    }
  }

  return (...args: A) => {
    watchWindowResize()

    const interval = resizeThrottleMs(category)

    if (interval <= 0 || !resizeGestureActive()) {
      flush()
      run(args)

      return
    }

    pending = args

    if (timer !== null) {
      return
    }

    const wait = interval - (Date.now() - lastRun)

    // Leading edge: the first move of a drag lands immediately, so a short drag
    // still tracks the pointer.
    if (wait <= 0) {
      run(args)

      return
    }

    // A gesture can end inside the window — hook the end so the last position
    // isn't left un-rendered until something else happens to resize.
    releaseEndHook ??= onResizeGestureEnd(flush)
    timer = setTimeout(flush, wait)
  }
}

// ---------------------------------------------------------------------------
// The calm state (opt-in)
// ---------------------------------------------------------------------------

/**
 * Freeze-and-dim the pane bodies while a gesture settles, instead of letting the
 * content re-wrap at the throttled rate.
 *
 * OFF by default. Throttling alone still re-wraps text several times a second,
 * which may or may not read as "breaking" — that is a judgement only the person
 * looking at it can make, so it ships as a switch rather than as an opinion.
 *
 * Implemented as an attribute on <html>, not React state: the whole point is to
 * calm renders down, so the mechanism must not itself cause one.
 */
export const $calmDuringResize = persistentAtom('hermes.calmDuringResize', false, Codecs.bool)

function scheduleCalm(): void {
  if (typeof document === 'undefined' || !$calmDuringResize.get()) {
    return
  }

  calmTimer = setTimeout(() => {
    calmTimer = null
    document.documentElement.dataset.resizing = ''
  }, CALM_GRACE_MS)
}

function clearCalm(): void {
  if (calmTimer !== null) {
    clearTimeout(calmTimer)
    calmTimer = null
  }

  if (typeof document === 'undefined' || !('resizing' in document.documentElement.dataset)) {
    return
  }

  // A frame later: the gesture's final flush is still pending, and lifting the
  // veil before it paints is exactly the reflow-in-public this exists to hide.
  requestAnimationFrame(() => {
    if (!resizeGestureActive()) {
      delete document.documentElement.dataset.resizing
    }
  })
}
