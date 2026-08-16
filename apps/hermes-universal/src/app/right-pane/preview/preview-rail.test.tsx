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
const THIRD = '/repo/third.ts'

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

/**
 * The rail's MENU, which nothing rendered.
 *
 * "Close to the right" did not exist for previews at all until #118 (its label
 * had been sitting in the translations wired to nothing), and the whole group
 * now reads from `zones.*` so a preview tab answers a right-click with the same
 * words as every other tab strip. Neither fact was held anywhere.
 */
describe('preview rail context menu', () => {
  const openOn = (element: Element) => {
    fireEvent.pointerDown(element, { button: 2, pointerType: 'mouse' })
    fireEvent.contextMenu(element, { button: 2 })
  }

  it('offers the four shared close verbs and nothing else', async () => {
    await setup()

    openOn(tab('clean.ts'))
    expect(screen.getAllByRole('menuitem').map(row => row.textContent)).toEqual([
      'Close',
      'Close others',
      'Close to the right',
      'Close all'
    ])
  })

  it('runs them through the GATED close, so a dirty buffer still asks', async () => {
    const { confirm, preview } = await setup()

    // `clean.ts` is left of the DIRTY tab, so "to the right" targets a buffer
    // with unsaved edits — and must ask, exactly as a lone close does. The
    // batch rewrites these verbs used to be swept it away silently.
    openOn(tab('clean.ts'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Close to the right' }))

    expect(confirm.$pendingClose.get()).toMatchObject({ id: DIRTY, kind: 'file' })
    expect(preview.$previewTabs.get().map(entry => entry.path)).toEqual([CLEAN, DIRTY])
  })

  it('scopes them to the tab the menu was opened on', async () => {
    const { preview } = await setup()
    preview.setPreviewTarget(THIRD)

    // THREE tabs, menu on the MIDDLE one: "to the right" takes only the last,
    // where "others" would also have taken `clean.ts`. With a pair the two
    // verbs close the same set and either wiring passes.
    openOn(tab('dirty.ts'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Close to the right' }))

    expect(preview.$previewTabs.get().map(entry => entry.path)).toEqual([CLEAN, DIRTY])
  })

  it('greys the verbs that would close nothing on a lone tab', async () => {
    const { preview } = await setup()
    preview.closePreviewTab(DIRTY)

    openOn(tab('clean.ts'))

    const state = Object.fromEntries(
      screen.getAllByRole('menuitem').map(row => [row.textContent, row.getAttribute('data-disabled') !== null])
    )

    expect(state['Close others']).toBe(true)
    expect(state['Close to the right']).toBe(true)
    expect(state['Close all']).toBe(false)
  })
})
