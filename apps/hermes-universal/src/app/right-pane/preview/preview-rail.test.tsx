/**
 * The preview rail's CLOSE GESTURES, at the rail — not at the store.
 *
 * `store/preview.test.ts` proves `requestClosePreviewTab` asks before it drops
 * a dirty buffer. It cannot prove the rail calls it: swapping the rail's
 * middle-click back to the ungated `closePreviewTab` leaves every store test
 * green, which is exactly how this rail shipped its ⌘/middle-click on
 * `onAuxClick` — an event that never arrives inside a scroller — for as long as
 * it did. So the gestures are exercised through the rendered strip.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The readers are heavy (CodeMirror / Shiki) and irrelevant to a tab strip.
vi.mock('./preview-file', () => ({ PreviewFile: () => null }))
vi.mock('./preview-artifact', () => ({ ArtifactPreview: () => null }))

const CLEAN = '/repo/clean.ts'
const DIRTY = '/repo/dirty.ts'

async function setup() {
  const preview = await import('@/store/preview')
  const edit = await import('@/store/preview-edit')
  const confirm = await import('@/store/close-confirm')
  const { PreviewRail } = await import('./preview-rail')

  preview.closeAllPreviewTabs()
  edit.setPreviewDirty(DIRTY, true)
  preview.setPreviewTarget(CLEAN)
  preview.setPreviewTarget(DIRTY)

  render(<PreviewRail />)

  return { confirm, preview }
}

/** A middle click as a three-button mouse delivers it: no `auxclick`, which the
 *  autoscroll pan swallows on every platform but macOS. */
function middleClick(element: Element) {
  fireEvent.mouseDown(element, { button: 1 })
  fireEvent.pointerDown(element, { button: 1 })
  fireEvent.pointerUp(element, { button: 1 })
}

const tab = (name: string) => screen.getByText(name).closest('div[title]')!

afterEach(() => {
  cleanup()
  vi.resetModules()
})

beforeEach(() => {
  window.localStorage.clear()
})

describe('preview rail close gestures', () => {
  it('middle-click closes a clean tab outright', async () => {
    const { preview } = await setup()

    middleClick(tab('clean.ts'))
    expect(preview.$previewTabs.get().map(t => t.path)).toEqual([DIRTY])
  })

  it('middle-click on a tab with unsaved edits asks before discarding them', async () => {
    const { confirm, preview } = await setup()

    middleClick(tab('dirty.ts'))
    // Still open, and a prompt is queued against this exact file.
    expect(preview.$previewTabs.get().map(t => t.path)).toEqual([CLEAN, DIRTY])
    expect(confirm.$pendingClose.get()).toMatchObject({ id: DIRTY, kind: 'file' })

    confirm.resolvePendingClose(confirm.$pendingClose.get()!.token, true)
    expect(preview.$previewTabs.get().map(t => t.path)).toEqual([CLEAN])
  })

  it('⌘-click — the trackpad stand-in — takes the same gated route', async () => {
    const { confirm } = await setup()

    fireEvent.click(tab('dirty.ts'), { button: 0, metaKey: true })
    expect(confirm.$pendingClose.get()).toMatchObject({ id: DIRTY, kind: 'file' })
  })

  it('the ✕ — the only one of the three a finger can reach — is gated too', async () => {
    const { confirm } = await setup()

    fireEvent.click(screen.getByRole('button', { name: /dirty\.ts/u }))
    expect(confirm.$pendingClose.get()).toMatchObject({ id: DIRTY, kind: 'file' })
  })

  it('a plain click selects rather than closes', async () => {
    const { preview } = await setup()

    fireEvent.click(tab('clean.ts'))
    expect(preview.$activePreviewTarget.get()?.path).toBe(CLEAN)
    expect(preview.$previewTabs.get()).toHaveLength(2)
  })
})
