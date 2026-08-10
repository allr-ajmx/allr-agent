/**
 * Floating FPS HUD — frame rate, frame-time shape, and what blocked the thread.
 *
 * Sibling of the tracer HUD (`dev/trace-hud.ts`), same chrome (`dev/hud-shell.ts`)
 * and the same reason for existing outside React: an instrument that renders
 * inside the app measures its own interference. That argument is sharper here
 * than anywhere else, because this one reports the exact quantity it would be
 * perturbing.
 *
 * THREE THINGS IT DOES THAT A NAIVE FPS COUNTER DOESN'T
 *
 * 1. The rAF callback does arithmetic ONLY — no DOM, no formatting, no
 *    allocation. Text is written on a 4 Hz timer, and only for values that
 *    actually changed. A counter that writes `textContent` every frame is
 *    measuring itself.
 * 2. It reports worst-frame and p95 next to the average, because a second with
 *    59 good frames and one 200 ms frame averages to ~55 fps and reads as fine
 *    while the user plainly saw a hitch.
 * 3. It counts `longtask` entries alongside frames, so a stall is attributable:
 *    frames dropping WITH long tasks is blocked JS, frames dropping WITHOUT
 *    them is paint/compositing or the GPU.
 *
 * THE COST IT CANNOT AVOID, STATED PLAINLY
 *
 * A running `requestAnimationFrame` loop keeps the compositor awake, so the app
 * never idles while this is open and the machine draws more power than it
 * otherwise would. There is no way to sample frame rate without asking for
 * frames. What it can do is stop entirely when hidden or backgrounded, which it
 * does — a hidden HUD costs nothing, and `×` really means off.
 *
 * The loop itself belongs to `observability/auto/frames.ts`, not to this file.
 * One loop serves both this and the tracer's `frame` spans, so the two cannot
 * disagree about what a frame was, and opening both HUDs costs one loop rather
 * than two — which matters precisely because the loop perturbs the measurement.
 *
 * DEV/BENCH ONLY, installed from observability/install.ts.
 */

import { onFrame, setFramesActive } from '@/observability/auto/frames'

import { FrameMeter, LONG_FRAME_MS } from './frame-meter'
import { BUTTON, createHudShell, DIM, el, ROW } from './hud-shell'

const PANEL_W = 190
/** 4 Hz. Fast enough to feel live, slow enough that the readout is not itself a
 *  per-frame workload. */
const PAINT_MS = 250
const SPARK_H = 26
/** Frame time the sparkline's full bar height represents. */
const SPARK_CEIL_MS = 64

const GOOD = '#22c55e'
const WARN = '#f59e0b'
const BAD = '#ef4444'

/** Colour by how far below the display's own refresh rate we are — 60 fps is
 *  perfect on a 60 Hz panel and a halving on a 120 Hz one. */
function toneFor(fps: number, refreshHz: number): string {
  const ratio = fps / refreshHz

  return ratio >= 0.9 ? GOOD : ratio >= 0.6 ? WARN : BAD
}

export function installFpsHud(): () => void {
  if (typeof document === 'undefined' || !document.body) {
    return () => {}
  }

  const meter = new FrameMeter()

  const shell = createHudShell({
    // Below the tracer HUD's default slot, so opening both doesn't stack them.
    defaultPosition: ({ width }) => ({ x: Math.max(0, width - PANEL_W - 20), y: 300 }),
    id: 'fps',
    onChrome: () => {
      syncLoop()
      paint()
    },
    title: 'fps',
    width: PANEL_W
  })

  // ── body ──────────────────────────────────────────────────────────────────
  const headline = el('div', 'display:flex;align-items:baseline;gap:5px')
  const fpsOut = el('span', 'font-size:19px;line-height:1.1;font-variant-numeric:tabular-nums', '–')
  const refreshOut = el('span', 'opacity:.5', '')

  headline.append(fpsOut, refreshOut)

  const spark = el(
    'canvas',
    `width:100%;height:${SPARK_H}px;display:block;border-radius:3px;background:rgba(0,0,0,.25)`
  )

  const context = spark.getContext('2d')

  const worstRow = el('div', 'display:flex;justify-content:space-between;opacity:.65')
  const worstOut = el('span', '', 'worst –')
  const p95Out = el('span', '', 'p95 –')

  worstRow.append(worstOut, p95Out)

  const blockedRow = el('div', 'display:flex;justify-content:space-between;opacity:.65')
  const longFramesOut = el('span', '', '0 long')
  const longTasksOut = el('span', '', '')

  blockedRow.append(longFramesOut, longTasksOut)

  const actions = el('div', ROW)
  const resetButton = el('button', `${BUTTON};flex:1 1 auto`, 'reset')

  actions.append(resetButton)
  shell.body.append(headline, spark, worstRow, blockedRow, actions)

  // ── long tasks ────────────────────────────────────────────────────────────
  //
  // Passive: the observer costs nothing per frame and tells us whether a dropped
  // frame was blocked JS or something further down the pipeline. Not universally
  // supported — WebKitGTK is the target here, not Chromium — so its absence is a
  // missing row, never a broken HUD.
  let longTasks = 0
  let longTaskMs = 0
  let longTaskSupported = false
  let observer: PerformanceObserver | null = null

  try {
    observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        longTasks += 1
        longTaskMs += entry.duration
      }
    })
    observer.observe({ buffered: true, type: 'longtask' })
    longTaskSupported = true
  } catch {
    observer = null
  }

  // ── measurement ───────────────────────────────────────────────────────────
  //
  // The rAF loop is NOT owned here. `observability/auto/frames.ts` runs one loop
  // for the whole app and this subscribes to it, so the HUD's frame times and
  // the tracer's `frame` spans are the same measurement by construction rather
  // than two loops that agree until they don't — and an app with both open pays
  // for one loop, not two.
  let painter = 0
  let unsubscribe: (() => void) | null = null

  function stopLoop(): void {
    unsubscribe?.()
    unsubscribe = null
    setFramesActive('fps-hud', false)

    if (painter !== 0) {
      window.clearInterval(painter)
      painter = 0
    }
  }

  /**
   * Run while VISIBLE — including collapsed, because the collapsed pill shows
   * the frame rate in its title and that is the most useful way to leave this
   * open. Stop entirely when hidden or backgrounded.
   */
  function syncLoop(): void {
    if (shell.isHidden() || document.hidden) {
      stopLoop()
      meter.reset()

      return
    }

    if (unsubscribe === null) {
      unsubscribe = onFrame(deltaMs => {
        // Zero is the clock's "no previous frame" sentinel, not a 0ms frame.
        if (deltaMs > 0) {
          meter.push(deltaMs)
        }
      })
      setFramesActive('fps-hud', true)
    }

    if (painter === 0) {
      painter = window.setInterval(paint, PAINT_MS)
    }
  }

  // ── readout ───────────────────────────────────────────────────────────────
  //
  // Last value WRITTEN to the DOM, so an unchanged tick touches nothing.
  const painted = { fps: '', long: '', p95: '', refresh: '', tasks: '', title: '', tone: '', worst: '' }

  const setText = (node: HTMLElement, key: keyof typeof painted, next: string) => {
    if (painted[key] !== next) {
      painted[key] = next
      node.textContent = next
    }
  }

  function paint(): void {
    if (shell.isHidden()) {
      return
    }

    const stats = meter.stats()
    const refreshHz = meter.refreshHz()
    const ready = stats.sampleCount > 2
    const fps = Math.round(stats.fps)
    const tone = ready ? toneFor(stats.fps, refreshHz) : DIM

    if (painted.tone !== tone) {
      painted.tone = tone
      shell.dot.style.background = tone
      fpsOut.style.color = tone
    }

    // Collapsed, the title IS the readout — the whole point of the pill.
    setText(shell.title, 'title', shell.isCollapsed() ? (ready ? `fps · ${fps}` : 'fps') : 'fps')

    if (shell.isCollapsed()) {
      return
    }

    setText(fpsOut, 'fps', ready ? String(fps) : '–')
    setText(refreshOut, 'refresh', ready ? `/ ${refreshHz} Hz` : '')
    setText(worstOut, 'worst', ready ? `worst ${Math.round(stats.worstMs)}ms` : 'worst –')
    setText(p95Out, 'p95', ready ? `p95 ${Math.round(stats.p95Ms)}ms` : 'p95 –')
    setText(longFramesOut, 'long', `${stats.longFrames} long`)
    setText(
      longTasksOut,
      'tasks',
      longTaskSupported ? `${longTasks} tasks · ${Math.round(longTaskMs)}ms` : 'longtask n/a'
    )

    drawSpark(stats.worstMs)
  }

  /**
   * The sparkline is what makes this readable: a number tells you the frame rate
   * is bad, the shape tells you whether it is a steady sag or one spike.
   *
   * Canvas rather than DOM bars because a canvas repaint is contained to its own
   * bitmap — sixty elements whose heights change four times a second would put
   * the HUD back into the document's layout, which is the thing this whole file
   * is arranged to avoid.
   */
  function drawSpark(worstMs: number): void {
    if (!context) {
      return
    }

    const ratio = window.devicePixelRatio || 1
    const cssWidth = spark.clientWidth || PANEL_W - 12
    const width = Math.max(1, Math.round(cssWidth * ratio))
    const height = Math.max(1, Math.round(SPARK_H * ratio))

    if (spark.width !== width || spark.height !== height) {
      spark.width = width
      spark.height = height
    }

    context.clearRect(0, 0, width, height)

    const samples = meter.samples()

    if (samples.length === 0) {
      return
    }

    const refreshHz = meter.refreshHz()
    const budgetMs = 1000 / refreshHz
    // Scale to the worst frame on screen, floored at the ceiling constant, so a
    // calm window doesn't magnify 17ms noise into alarming bars.
    const scaleMs = Math.max(SPARK_CEIL_MS, Math.min(worstMs, 400))
    const barWidth = width / samples.length

    for (let i = 0; i < samples.length; i += 1) {
      const ms = samples[i]
      const barHeight = Math.max(1, Math.min(1, ms / scaleMs) * height)

      context.fillStyle = ms >= LONG_FRAME_MS ? BAD : ms > budgetMs * 1.5 ? WARN : GOOD
      context.fillRect(i * barWidth, height - barHeight, Math.max(1, barWidth - ratio), barHeight)
    }

    // The budget line: everything under it rendered within one refresh interval.
    const budgetY = height - Math.min(1, budgetMs / scaleMs) * height

    context.fillStyle = 'rgba(255,255,255,.25)'
    context.fillRect(0, budgetY, width, Math.max(1, ratio))
  }

  // ── wiring ────────────────────────────────────────────────────────────────
  resetButton.addEventListener('click', () => {
    meter.reset()
    longTasks = 0
    longTaskMs = 0
    paint()
  })

  const onVisibility = () => syncLoop()

  document.addEventListener('visibilitychange', onVisibility)

  syncLoop()
  paint()

  // The way back from the `×`, mirroring `__hermesTrace.hud()`. Deliberately not
  // a global hotkey: this app has a rebindable keybind registry, and a raw
  // listener here would be a second, invisible source of truth for shortcuts.
  const api = {
    hud: (show = true) => {
      shell.setHidden(!show)

      return `fps hud ${show ? 'shown' : 'hidden'}`
    },
    reset: () => {
      meter.reset()

      return 'fps meter reset'
    },
    stats: () => meter.stats()
  }

  ;(window as unknown as { __hermesFps?: typeof api }).__hermesFps = api

  return () => {
    stopLoop()
    observer?.disconnect()
    document.removeEventListener('visibilitychange', onVisibility)
    shell.destroy()
    delete (window as unknown as { __hermesFps?: typeof api }).__hermesFps
  }
}
