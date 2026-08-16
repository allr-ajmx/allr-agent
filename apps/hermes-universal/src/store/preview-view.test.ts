import { afterEach, describe, expect, it } from 'vitest'

import {
  $previewCaps,
  $previewModes,
  forgetPreviewView,
  previewCaps,
  previewMode,
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

  it('forgets a closed preview so a long-lived window pins nothing', () => {
    setPreviewMode('/a.md', 'rendered')
    setPreviewCaps('/a.md', { rendered: true, source: true })
    setPreviewMode('/b.ts', 'diff')

    forgetPreviewView('/a.md')

    expect($previewModes.get()).toEqual({ '/b.ts': 'diff' })
    expect($previewCaps.get()).toEqual({})
  })
})
