/**
 * Floating tracer HUD — the span recorder, without the console.
 *
 * WHY THIS EXISTS
 *
 * The controls were console-only (`__hermesTrace.on()`, `.run()`, `.timeline()`),
 * which is fine for the person who wrote them and hostile to everyone else.
 * Recording is a thing you do WHILE reproducing something — mid-drag, mid-stream,
 * hands on the pointer — and reaching for a devtools console to start and stop it
 * costs the first second of every capture, which is often the interesting one.
 * Worse, the two states that silently ruin a capture (recording off, auto-drain
 * on) are both invisible until you go looking, so the usual outcome is a clean
 * empty result and no hint why.
 *
 * So: a live readout of whether it is recording and how many spans it has, next
 * to the buttons that change that.
 *
 * DEV/BENCH ONLY. Mounted through a lazy import behind the same build gate as
 * the markdown bench, so a release bundle contains neither this component nor
 * the exporter it drives.
 *
 * NO NANOSTORES IN HERE. vite.config.ts aliases `nanostores` to the store
 * autocapture wrapper, so a store-backed HUD would record its own state changes
 * as `store.set` spans — the instrument would show up in its own measurements,
 * at the exact moment someone is trying to read them. Plain React state, and a
 * poll for the counters.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { HUD_SURFACE, HUD_TEXT } from '@/app/floating-hud'
import { writeClipboardText } from '@/components/ui/copy-button'
import { openExternalLink } from '@/lib/external-link'
import { JAEGER_UI, tracer, type TracerStatus } from '@/observability/exporter'

const POSITION_KEY = 'hermes.trace-hud-position.v1'
const COLLAPSED_KEY = 'hermes.trace-hud-collapsed.v1'
/**
 * Counter refresh. Fast enough that "is it recording anything?" is answered at a
 * glance, slow enough to be nothing next to a 60fps render — which matters more
 * than usual here, because this component is on screen during every capture it
 * is used for.
 */
const POLL_MS = 250
const NOMINAL_W = 260
const NOMINAL_H = 150

interface Point {
  x: number
  y: number
}

function clampPoint(x: number, y: number): Point {
  return {
    x: Math.min(Math.max(0, x), Math.max(0, (window.innerWidth || 800) - NOMINAL_W)),
    y: Math.min(Math.max(0, y), Math.max(0, (window.innerHeight || 600) - NOMINAL_H))
  }
}

function loadPosition(): Point {
  try {
    const raw = localStorage.getItem(POSITION_KEY)

    if (raw) {
      const parsed = JSON.parse(raw) as Point

      if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
        return clampPoint(parsed.x, parsed.y)
      }
    }
  } catch {
    // Private mode, quota, or a shape from an older version. Fall through.
  }

  // Top-right by default: out of the way of the composer and the sidebar, both
  // of which are things people record themselves using.
  return clampPoint((window.innerWidth || 800) - NOMINAL_W - 24, 56)
}

function persist(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // ignore (private mode / quota)
  }
}

const BUTTON = 'rounded border border-(--stroke-nous) px-1.5 py-0.5 hover:bg-white/10 disabled:opacity-40'

export function TraceHud() {
  const [status, setStatus] = useState<TracerStatus>(() => tracer.status())
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === 'true')
  const [position, setPosition] = useState<Point>(loadPosition)
  const [markLabel, setMarkLabel] = useState('')

  const hostRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ dx: number; dy: number; x: number; y: number } | null>(null)

  // Both a subscription AND a poll. The subscription catches control changes the
  // instant they happen (including ones made from the console, so the two front
  // ends never disagree); the poll is for the span count, which changes without
  // anything to notify on — spans are recorded on hot paths that must not carry
  // a listener call.
  useEffect(() => {
    const refresh = () => setStatus(tracer.status())
    const unsubscribe = tracer.subscribe(refresh)
    const timer = window.setInterval(refresh, POLL_MS)

    return () => {
      unsubscribe()
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    const reclamp = () => setPosition(current => clampPoint(current.x, current.y))

    window.addEventListener('resize', reclamp)

    return () => window.removeEventListener('resize', reclamp)
  }, [])

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    const el = hostRef.current

    if (!el) {
      return
    }

    const rect = el.getBoundingClientRect()

    dragRef.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top, x: rect.left, y: rect.top }
    el.setPointerCapture(e.pointerId)
  }, [])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current
    const el = hostRef.current

    if (!drag || !el) {
      return
    }

    const next = clampPoint(e.clientX - drag.dx, e.clientY - drag.dy)

    drag.x = next.x
    drag.y = next.y
    // Straight to the DOM: a setState per pointermove would re-render the HUD on
    // every frame of the drag, and this thing is on screen precisely when
    // someone is measuring frame cost.
    el.style.left = `${next.x}px`
    el.style.top = `${next.y}px`
  }, [])

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current

    if (drag) {
      dragRef.current = null
      setPosition({ x: drag.x, y: drag.y })
      persist(POSITION_KEY, { x: drag.x, y: drag.y })
    }

    hostRef.current?.releasePointerCapture?.(e.pointerId)
  }, [])

  const toggleCollapsed = useCallback(() => {
    setCollapsed(current => {
      const next = !current

      persist(COLLAPSED_KEY, next)

      return next
    })
  }, [])

  const toggleRecording = useCallback(() => {
    if (tracer.status().recording) {
      void tracer.off()
    } else {
      tracer.on()
    }
  }, [])

  const submitMark = useCallback(() => {
    tracer.mark(markLabel.trim())
    setMarkLabel('')
  }, [markLabel])

  const dot = status.recording ? 'bg-red-500' : 'bg-white/30'

  return (
    <div
      className={`fixed z-[70] w-[260px] select-none font-mono ${HUD_SURFACE} ${HUD_TEXT}`}
      ref={hostRef}
      style={{ left: position.x, top: position.y }}
    >
      {/* The whole header is the drag handle, so there is no thin grip to hunt
          for; the two buttons stop propagation rather than sitting outside it. */}
      <div
        className="flex cursor-grab items-center gap-2 px-2 py-1"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <span className={`size-2 shrink-0 rounded-full ${dot}`} />
        <span className="grow truncate opacity-70">
          trace · {status.recording ? `capture ${status.capture}` : 'idle'}
        </span>
        <button className={BUTTON} onClick={toggleCollapsed} onPointerDown={e => e.stopPropagation()} type="button">
          {collapsed ? '+' : '–'}
        </button>
      </div>

      {collapsed ? null : (
        <div className="flex flex-col gap-1.5 border-t border-(--stroke-nous) px-2 py-1.5">
          <div className="flex gap-1">
            <button className={`${BUTTON} grow`} onClick={toggleRecording} type="button">
              {status.recording ? '■ stop' : '● record'}
            </button>
            <button className={BUTTON} onClick={() => void tracer.flush()} type="button">
              flush
            </button>
            <button className={BUTTON} onClick={() => tracer.clear()} type="button">
              clear
            </button>
          </div>

          {/* The counters. `spans` sitting at 0 while recording is the single
              most useful thing on here — it says the capture is running and the
              thing being reproduced is not producing any. */}
          <div className="flex justify-between opacity-70">
            <span>{status.spans} spans</span>
            <span>{status.openSpans} open</span>
            <span>{status.sinceFlushMs === 0 ? 'no flush' : `${Math.round(status.sinceFlushMs / 1000)}s ago`}</span>
          </div>

          <label className="flex items-center gap-1.5 opacity-70">
            <input checked={status.autoFlush} onChange={e => tracer.autoflush(e.target.checked)} type="checkbox" />
            {/* Named for what it costs, not for what it does: auto-drain on is
                why `timeline` so often prints nothing. */}
            <span>auto-drain{status.autoFlush ? '' : ' off — spans stay local'}</span>
          </label>

          <input
            className="w-full rounded border border-(--stroke-nous) bg-transparent px-1 py-0.5"
            onChange={e => tracer.run(e.target.value)}
            placeholder="run label"
            value={status.run}
          />

          <div className="flex gap-1">
            <input
              className="grow rounded border border-(--stroke-nous) bg-transparent px-1 py-0.5"
              onChange={e => setMarkLabel(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && submitMark()}
              placeholder="mark…"
              value={markLabel}
            />
            <button className={BUTTON} disabled={!status.recording} onClick={submitMark} type="button">
              mark
            </button>
          </div>

          <div className="flex gap-1">
            <button className={`${BUTTON} grow`} onClick={() => tracer.timeline()} type="button">
              timeline
            </button>
            <button
              className={BUTTON}
              onClick={() => void writeClipboardText(JSON.stringify(tracer.otlp()))}
              type="button"
            >
              copy
            </button>
            <button
              className={BUTTON}
              // Prefiltered by run label, because an unfiltered Jaeger is a list
              // of every capture anyone has ever taken on this machine.
              onClick={() =>
                void openExternalLink(
                  `${JAEGER_UI}/search?service=hermes-universal&tags=${encodeURIComponent(
                    JSON.stringify({ 'hermes.run': status.run })
                  )}`
                )
              }
              type="button"
            >
              jaeger ↗
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
