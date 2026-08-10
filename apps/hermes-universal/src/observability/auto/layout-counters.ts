/**
 * Per-frame totals for the layout renderer's work.
 *
 * ONE SPAN PER FRAME, NOT ONE PER SPLIT
 *
 * WebKitGTK clamps `performance.now()` to 1ms, so a span around a single
 * `TreeSplit`'s tracks pass would read 0ms no matter how much tree it walked.
 * Eight 0ms spans say nothing that `{splitRenders: 8, paneVisits: 340}` on one
 * span does not — and at 60fps they would be ~480 spans/second, which buries
 * the trace it is supposed to explain. So the hook accumulates and the frame
 * boundary flushes.
 *
 * HOW TO READ IT, AND HOW NOT TO
 *
 * These counters answer **how much work**. `react.commit`'s `actualMs` answers
 * **how long**. Only together are they a finding: a `layout.tracks` span
 * showing `paneVisits: 340` and a duration of 0ms does NOT mean the tracks pass
 * is free — it means the clock could not see it. Read the counter against the
 * React commit time in the same frame.
 *
 * `splitRenders`, not `splitCommits`: React 19 can render a tree and discard
 * it, so this measures cost PAID, which may legitimately exceed the number of
 * commits. A large divergence between the two is itself the finding.
 *
 * DEV/BENCH ONLY.
 */

import {
  setPaneCommitHook,
  setReactCommitHook,
  setSplitRenderHook,
  setZoneRenderHook
} from '@/components/pane-shell/tree/renderer/telemetry'

import { isRecording, recordSpan } from '../span'

import { probeCommit } from './engine-probe'
import { currentFrame, noteFrameWork, onFrameEnd } from './frames'

interface Totals {
  children: number
  paneVisits: number
  splitRenders: number
}

const empty = (): Totals => ({ children: 0, paneVisits: 0, splitRenders: 0 })

let totals = empty()
/** Distinct splits that rendered this frame — a split rendering twice in one
 *  frame is a different problem from two splits rendering once. */
let splitIds = new Set<string>()
/** Zone renders this frame, counted per tile KIND. This is the attribution the
 *  root Profiler cannot provide: `react.commit` says the tree cost 18ms,
 *  `zones` says it was `files` and not `chat`. */
let zoneKinds = new Map<string, number>()
let zoneRenders = 0
let reactCommits = 0

function flush(): void {
  const { children, paneVisits, splitRenders } = totals
  const commits = reactCommits
  const distinct = splitIds.size
  const zones = zoneRenders

  // Sorted by count so the loudest pane reads first in Jaeger's tag list.
  const kinds = [...zoneKinds.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([kind, n]) => `${kind}:${n}`)
    .join(' ')

  totals = empty()
  splitIds = new Set()
  zoneKinds = new Map()
  zoneRenders = 0
  reactCommits = 0

  if (splitRenders === 0 && commits === 0 && zones === 0) {
    return
  }

  const at = performance.now()

  // Zero-length on purpose: this span is a CONTAINER FOR COUNTERS, not a
  // duration. Giving it a fabricated width would invite exactly the reading
  // the module doc warns against.
  recordSpan(
    'layout.tracks',
    at,
    at,
    {
      children,
      distinctSplits: distinct,
      paneVisits,
      reactCommits: commits,
      splitRenders,
      zoneKinds: kinds,
      zoneRenders: zones
    },
    currentFrame() || undefined
  )
}

export function installLayoutCounters(): () => void {
  setSplitRenderHook((splitId, children, panes) => {
    if (!isRecording()) {
      return
    }

    totals.splitRenders += 1
    totals.children += children
    totals.paneVisits += panes
    splitIds.add(splitId)
  })

  setZoneRenderHook((_zoneId, kind) => {
    if (!isRecording()) {
      return
    }

    zoneRenders += 1
    zoneKinds.set(kind, (zoneKinds.get(kind) ?? 0) + 1)
  })

  // The breakdown the root Profiler cannot give. `id` is the tile kind, and
  // this fires only for panes that actually committed — so a right-sidebar
  // resize that costs a second of React finally says WHOSE second it was.
  //
  // Never sum these with `react.commit`: a nested Profiler's actualDuration is
  // already inside its ancestor's. The root is the total, this is the split.
  setPaneCommitHook((id, phase, actualDuration, _baseDuration, startTime, commitTime) => {
    if (!isRecording()) {
      return
    }

    recordSpan(
      'react.pane',
      startTime,
      commitTime,
      { actualMs: Math.round(actualDuration), kind: String(id), phase },
      currentFrame() || undefined
    )
  })

  setReactCommitHook((_id, phase, actualDuration, baseDuration, startTime, commitTime) => {
    if (!isRecording()) {
      return
    }

    reactCommits += 1
    // React's own summed work, so the frame's paint estimate can subtract it.
    noteFrameWork(actualDuration)

    // BOTH numbers, because they measure different things and will differ.
    // `actualDuration` is React's summed render work — it excludes browser
    // layout and paint, and includes any nested Profiler. The span extent
    // (startTime → commitTime) covers the whole render+commit including
    // whatever React yielded for. A 40ms span with `actualMs: 6` is React
    // yielding, not React working, and without both it reads as the latter.
    recordSpan(
      'react.commit',
      startTime,
      commitTime,
      { actualMs: Math.round(actualDuration), baseMs: Math.round(baseDuration), phase },
      currentFrame() || undefined
    )

    // How much style and layout THIS commit dirtied. Deliberately last, so the
    // forced flush is not inside the span that measures React's own work.
    probeCommit()
  })

  const off = onFrameEnd(flush)

  return () => {
    off()
    setSplitRenderHook(null)
    setZoneRenderHook(null)
    setPaneCommitHook(null)
    setReactCommitHook(null)
  }
}
