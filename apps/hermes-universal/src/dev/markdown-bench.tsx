/**
 * Dev-only markdown/KaTeX bench — the in-app half of the perf harness.
 *
 * Reachable at /dev/markdown-bench, and only in a dev build: the route is
 * mounted behind `import.meta.env.DEV` in app/mobile-controller.tsx, so this
 * module is tree-shaken out of a production bundle.
 *
 * It renders the REAL surface (`MarkdownTextContent`, the same component the
 * assistant transcript uses) over a LaTeX-heavy fixture, so what it measures is
 * what a chat actually pays. Its companion, bench/index.html, strips the
 * framework away to isolate engine cost; this page cannot do that, and
 * bench/index.html cannot tell you what React costs. Use both.
 *
 * What to watch, in priority order:
 *   nodes       — every DOM node is walked by every later style/layout pass.
 *                 This is the number the KaTeX collapse exists to hold down.
 *   worst frame — during a sidebar toggle or width sweep. Anything over ~16ms
 *                 is a dropped frame and is what "clunky" actually means.
 *   commit ms   — React build cost for the transcript.
 */

import { Profiler, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { MarkdownTextContent } from '@/components/assistant-ui/markdown-text'
import { toggleSidebarOpen } from '@/store/layout'

import fixture from './fixtures/latex-heavy.md?raw'

const MULTIPLIERS = [1, 5, 20] as const

interface Sample {
  commitMs: number
  katexCount: number
  label: string
  nodes: number
  relayoutMs: number
  worstFrameMs: number
}

/**
 * Force style+layout to flush and report how long it took. Reading a geometry
 * property is what makes the engine resolve everything pending — the same
 * forced synchronous layout a sidebar toggle triggers.
 */
function flushLayout(el: HTMLElement | null): number {
  const start = performance.now()

  void el?.getBoundingClientRect().height
  void document.body.offsetHeight

  return performance.now() - start
}

/**
 * Drive `frames` animation frames while `mutate` changes layout each one, and
 * report the worst frame gap plus total forced-layout time. rAF deltas rather
 * than PerformanceObserver('long-animation-frame') because WebKitGTK may not
 * implement LoAF — this path has to work on the engine Tauri actually embeds.
 */
async function measureFrames(frames: number, el: HTMLElement | null, mutate: (i: number) => void) {
  let relayoutMs = 0
  let worstFrameMs = 0
  let last = performance.now()

  for (let i = 0; i < frames; i += 1) {
    mutate(i)
    relayoutMs += flushLayout(el)

    await new Promise(requestAnimationFrame)

    const now = performance.now()

    worstFrameMs = Math.max(worstFrameMs, now - last)
    last = now
  }

  return { relayoutMs, worstFrameMs }
}

export function MarkdownBench() {
  const [multiplier, setMultiplier] = useState<number>(1)
  const [remountKey, setRemountKey] = useState(0)
  const [samples, setSamples] = useState<Sample[]>([])
  const [busy, setBusy] = useState(false)

  const stageRef = useRef<HTMLDivElement>(null)
  // Written by the Profiler callback, read when a run finishes — deliberately a
  // ref, so recording a commit time can't itself cause a commit.
  const commitRef = useRef(0)

  const text = useMemo(() => Array.from({ length: multiplier }, () => fixture).join('\n\n---\n\n'), [multiplier])

  const measure = useCallback(() => {
    const el = stageRef.current

    return {
      commitMs: commitRef.current,
      katexCount: el?.querySelectorAll('.katex-host, .katex').length ?? 0,
      nodes: el?.querySelectorAll('*').length ?? 0
    }
  }, [])

  const record = useCallback(
    (label: string, relayoutMs: number, worstFrameMs: number) => {
      setSamples(prev => [...prev, { ...measure(), label, relayoutMs, worstFrameMs }])
    },
    [measure]
  )

  // Baseline row on first paint / whenever the fixture size changes, so a run
  // always has a "just sat there" number to compare the interactions against.
  useEffect(() => {
    let cancelled = false

    const id = requestAnimationFrame(() => {
      if (!cancelled) {
        record(`idle x${multiplier}`, flushLayout(stageRef.current), 0)
      }
    })

    return () => {
      cancelled = true
      cancelAnimationFrame(id)
    }
  }, [multiplier, record, remountKey])

  const runSweep = useCallback(async () => {
    setBusy(true)

    const el = stageRef.current

    // Animate the column's own width: the general "the viewport changed shape"
    // case, covering a window resize as well as a pane drag.
    const { relayoutMs, worstFrameMs } = await measureFrames(40, el, i => {
      el?.style.setProperty('max-width', `${620 + (i % 20) * 12}px`)
    })

    el?.style.removeProperty('max-width')
    record(`sweep x${multiplier}`, relayoutMs, worstFrameMs)
    setBusy(false)
  }, [multiplier, record])

  const runToggle = useCallback(async () => {
    setBusy(true)

    // The real store action, so this exercises the real grid-track rewrite in
    // pane-shell rather than a lookalike.
    const { relayoutMs, worstFrameMs } = await measureFrames(12, stageRef.current, () => toggleSidebarOpen())

    record(`sidebar toggle x${multiplier}`, relayoutMs, worstFrameMs)
    setBusy(false)
  }, [multiplier, record])

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-4 text-sm">
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="text-base font-semibold">Markdown / KaTeX bench</h1>
        <span className="text-muted-foreground text-xs">{text.length.toLocaleString()} chars</span>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        {MULTIPLIERS.map(value => (
          <button
            className={`rounded border px-2 py-1 ${multiplier === value ? 'border-foreground' : 'border-border'}`}
            key={value}
            onClick={() => setMultiplier(value)}
            type="button"
          >
            x{value}
          </button>
        ))}
        <button
          className="rounded border border-border px-2 py-1"
          onClick={() => setRemountKey(key => key + 1)}
          type="button"
        >
          remount
        </button>
        <button className="rounded border border-border px-2 py-1" disabled={busy} onClick={runToggle} type="button">
          toggle sidebar
        </button>
        <button className="rounded border border-border px-2 py-1" disabled={busy} onClick={runSweep} type="button">
          sweep width
        </button>
        <button className="rounded border border-border px-2 py-1" onClick={() => setSamples([])} type="button">
          clear
        </button>
      </div>

      <table className="w-full border-collapse text-xs tabular-nums">
        <thead className="text-muted-foreground">
          <tr>
            {['run', 'commit ms', 'nodes', 'katex', 'relayout ms', 'worst frame ms'].map(head => (
              <th className="border border-border px-2 py-1 text-start" key={head}>
                {head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {samples.map((sample, index) => (
            <tr key={index}>
              <td className="border border-border px-2 py-1">{sample.label}</td>
              <td className="border border-border px-2 py-1 text-end">{sample.commitMs.toFixed(1)}</td>
              <td className="border border-border px-2 py-1 text-end">{sample.nodes.toLocaleString()}</td>
              <td className="border border-border px-2 py-1 text-end">{sample.katexCount}</td>
              <td className="border border-border px-2 py-1 text-end">{sample.relayoutMs.toFixed(1)}</td>
              <td className="border border-border px-2 py-1 text-end">{sample.worstFrameMs.toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <Profiler
        id="markdown-bench"
        onRender={(_id, _phase, actualDuration) => {
          commitRef.current = actualDuration
        }}
      >
        <div className="mx-auto w-full max-w-(--composer-width)" ref={stageRef}>
          <MarkdownTextContent isRunning={false} key={`${multiplier}-${remountKey}`} text={text} />
        </div>
      </Profiler>
    </div>
  )
}
