import { beforeEach, describe, expect, it } from 'vitest'

import { notifyPaneCommit, notifyReactCommit, notifyZoneRender } from '@/components/pane-shell/tree/renderer/telemetry'

import { clearSpans, peekAll, setRecording } from '../span'

import { installFrames, setFramesActive } from './frames'
import { installLayoutCounters } from './layout-counters'

/** Wait past a frame's post-paint boundary — two rAFs plus a macrotask, which
 *  is enough for the clock's MessageChannel handler to have run. */
const frameBoundary = () =>
  new Promise<void>(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)))
  })

/**
 * The three captures that drove this instrument each came back with one of its
 * counters at zero, and each time the question was the same and expensive:
 * is the app not doing that work, or is the instrument not wired?
 *
 * These tests answer the second half cheaply and for good. They drive the
 * telemetry seam directly — React's Profiler is what calls it in the app, and
 * that part is typechecked JSX — so a zero in a future capture means the app,
 * not the wiring.
 */
const named = (name: string) => peekAll().filter(s => s.name === name)

/** Profiler's onRender argument list, which the hooks mirror exactly. */
const profile = (fn: typeof notifyReactCommit, id: string, actualMs: number, phase: 'update' = 'update') =>
  fn(id, phase, actualMs, 100, 0, actualMs)

describe('layout counters', () => {
  let uninstall = () => {}

  beforeEach(() => {
    uninstall()
    setRecording(false)
    clearSpans()
    uninstall = installLayoutCounters()
    setRecording(true, 'test')
  })

  it('records a pane commit against the tile KIND', () => {
    // The attribution the root Profiler cannot give: which pane's content.
    profile(notifyPaneCommit, 'files', 19)

    const [span] = named('react.pane')

    expect(span).toBeDefined()
    expect(span.attrs?.kind).toBe('files')
    expect(span.attrs?.actualMs).toBe(19)
  })

  it('keeps each pane separate, so a capture can name the expensive one', () => {
    profile(notifyPaneCommit, 'files', 18)
    profile(notifyPaneCommit, 'chat', 1)
    profile(notifyPaneCommit, 'files', 20)

    const kinds = named('react.pane').map(s => s.attrs?.kind)

    expect(kinds).toEqual(['files', 'chat', 'files'])
  })

  it('records nothing at all while recording is off', () => {
    setRecording(false)
    profile(notifyPaneCommit, 'files', 19)
    profile(notifyReactCommit, 'layout-tree', 19)

    expect(peekAll()).toHaveLength(0)
  })

  it('folds zone renders into the per-frame span, loudest kind first', async () => {
    // Driven through the REAL frame clock rather than a poked flush: the frame
    // boundary is what makes these counters per-frame, and a test that skipped
    // it would pass with the clock unwired — which is exactly the failure that
    // sent a capture back empty.
    const stopFrames = installFrames()

    setFramesActive('test', true)

    notifyZoneRender('group-1', 'chat')
    notifyZoneRender('group-2', 'files')
    notifyZoneRender('group-3', 'files')
    profile(notifyReactCommit, 'layout-tree', 12)

    await frameBoundary()

    const [tracks] = named('layout.tracks')

    expect(tracks).toBeDefined()
    expect(tracks.attrs?.zoneRenders).toBe(3)
    expect(tracks.attrs?.zoneKinds).toBe('files:2 chat:1')
    expect(tracks.attrs?.reactCommits).toBe(1)

    setFramesActive('test', false)
    stopFrames()
  })
})
