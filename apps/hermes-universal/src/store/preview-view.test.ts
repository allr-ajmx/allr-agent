import { afterEach, describe, expect, it } from 'vitest'

import {
  $previewCaps,
  $previewModes,
  forgetPreviewView,
  previewCaps,
  previewMode,
  seedPreviewMode,
  setPreviewCaps,
  setPreviewMode
} from './preview-view'

afterEach(() => {
  $previewModes.set({})
  $previewCaps.set({})
})

describe('preview view state', () => {
  it('defaults to source and remembers a per-path mode', () => {
    expect(previewMode('/a.ts')).toBe('source')
    setPreviewMode('/a.md', 'rendered')
    expect(previewMode('/a.md')).toBe('rendered')
    // Keyed by path: one preview's mode never leaks into another's.
    expect(previewMode('/a.ts')).toBe('source')
  })

  it('is a no-op (same object reference) when the mode is unchanged', () => {
    setPreviewMode('/a.ts', 'diff')
    const before = $previewModes.get()
    setPreviewMode('/a.ts', 'diff')
    expect($previewModes.get()).toBe(before)
  })

  it('has no capabilities until the pane has read the file', () => {
    // What leaves the strip's source/rendered glyphs disabled while the read is
    // in flight, instead of offering a mode that may not exist.
    expect(previewCaps('/a.ts')).toBeUndefined()
    setPreviewCaps('/a.ts', { rendered: false, source: true })
    expect(previewCaps('/a.ts')).toEqual({ rendered: false, source: true })
  })

  it('is a no-op when capabilities are unchanged', () => {
    setPreviewCaps('/a.ts', { rendered: false, source: true })
    const before = $previewCaps.get()
    setPreviewCaps('/a.ts', { rendered: false, source: true })
    expect($previewCaps.get()).toBe(before)
  })

  it('seeds a mode only for a path that has none', () => {
    // The pane seeds on every load, and a save reloads. Seeding with
    // `setPreviewMode` is what made a saved `.md` snap back to `rendered`.
    seedPreviewMode('/a.md', 'rendered')
    expect(previewMode('/a.md')).toBe('rendered')

    setPreviewMode('/a.md', 'source')
    seedPreviewMode('/a.md', 'rendered')
    expect(previewMode('/a.md')).toBe('source')
  })

  it('does not mistake an explicit "source" for an absent mode', () => {
    // `previewMode()` returns 'source' for a path it has never seen, so the
    // seed's absence test has to be a key lookup. A user who switched a
    // markdown file to source and saved it must not be flipped back.
    setPreviewMode('/b.md', 'source')
    seedPreviewMode('/b.md', 'rendered')
    expect(previewMode('/b.md')).toBe('source')
  })

  it('is a no-op (same object reference) when a mode is already seeded', () => {
    seedPreviewMode('/a.ts', 'source')
    const before = $previewModes.get()
    seedPreviewMode('/a.ts', 'diff')
    expect($previewModes.get()).toBe(before)
  })

  it('forgets a closed preview so a long-lived window pins nothing', () => {
    setPreviewMode('/a.md', 'rendered')
    setPreviewCaps('/a.md', { rendered: true, source: true })
    setPreviewMode('/b.ts', 'diff')

    forgetPreviewView('/a.md')

    expect($previewModes.get()).toEqual({ '/b.ts': 'diff' })
    expect($previewCaps.get()).toEqual({})
  })
})
