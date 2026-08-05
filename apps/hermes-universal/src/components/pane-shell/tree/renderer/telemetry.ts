/**
 * The layout renderer's telemetry SEAM — two null hooks, and no imports.
 *
 * The renderer is app code that ships; the instruments that read it
 * (`observability/auto/engine-probe.ts`, `observability/auto/layout-counters.ts`)
 * are dev/bench only. Importing them from here would drag the whole
 * observability layer into the release bundle to answer questions nobody there
 * can ask, and importing the tracer into the render path is also how you end up
 * with a cycle between the layout engine and the thing measuring it.
 *
 * So the renderer calls hooks that are null until something installs them. Cost
 * in release: one call to a function that returns immediately, per split render
 * and per layout commit. The same shape the engine already uses for
 * `registerPaneCloser` and the side openers.
 */

import type { ProfilerOnRenderCallback } from 'react'

let commitHook: (() => void) | null = null
let reactCommitHook: ProfilerOnRenderCallback | null = null
let splitRenderHook: ((splitId: string, children: number, panes: number) => void) | null = null
let zoneRenderHook: ((zoneId: string, kind: string) => void) | null = null

/** Called from a dependency-less layout effect at the END of every layout-tree
 *  commit — while the DOM is still dirty, which is what makes a forced-layout
 *  probe measure this commit rather than the next idle moment. */
export const notifyLayoutCommit = (): void => commitHook?.()

/** Called once per `TreeSplit` render, with the shape of the work that render
 *  just did. Counts cost PAID, which React 19 may discard — see the counter
 *  module for why the attribute is named `splitRenders`. */
export const notifySplitRender = (splitId: string, children: number, panes: number): void =>
  splitRenderHook?.(splitId, children, panes)

/**
 * Called once per `TreeGroup` render, with the KIND of the tile it is fronting.
 *
 * This is the attribution the root Profiler cannot give. `react.commit` says
 * the layout tree re-rendered and how long it took; `splitRenders` says whether
 * the tree STRUCTURE was involved. Neither says which pane's content did it,
 * and "a sidebar resize costs a second of React" is not actionable until you
 * know whether that second is the file tree, the transcript or the terminal.
 *
 * The kind, not the id: `files` / `chat` / `terminal` is what you act on, and
 * generated zone ids churn per session so they would be unsearchable as tags.
 */
export const notifyZoneRender = (zoneId: string, kind: string): void => zoneRenderHook?.(zoneId, kind)

/** Wired straight to `<Profiler onRender>` — same signature on purpose, so the
 *  renderer hands React's own numbers across without reshaping them. */
export const notifyReactCommit: ProfilerOnRenderCallback = (...args) => reactCommitHook?.(...args)

// A setter each rather than one options object: these are separate installers
// with separate lifetimes, and a single merge-free setter would let whichever
// installed last silently clear the others' hooks.
export function setLayoutCommitHook(fn: typeof commitHook): void {
  commitHook = fn
}

export function setReactCommitHook(fn: typeof reactCommitHook): void {
  reactCommitHook = fn
}

export function setSplitRenderHook(fn: typeof splitRenderHook): void {
  splitRenderHook = fn
}

export function setZoneRenderHook(fn: typeof zoneRenderHook): void {
  zoneRenderHook = fn
}
