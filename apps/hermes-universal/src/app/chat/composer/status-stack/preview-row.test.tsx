import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { openExternalLink } from '@/lib/external-link'
import { $activePreviewPath, $previewTabs, closeAllPreviewTabs } from '@/store/preview'
import type { PreviewArtifact } from '@/store/preview-status'

vi.mock('@/lib/external-link', () => ({ openExternalLink: vi.fn(async () => {}) }))

import { PreviewStatusRow } from './preview-row'

const artifact = (over: Partial<PreviewArtifact> = {}): PreviewArtifact => ({
  cwd: '/repo',
  id: 'preview.html',
  label: 'preview.html',
  target: 'preview.html',
  ...over
})

afterEach(() => {
  cleanup()
  vi.mocked(openExternalLink).mockClear()
  closeAllPreviewTabs()
})

describe('PreviewStatusRow', () => {
  it('sends an http target to the system browser, not the preview pane', async () => {
    render(
      <PreviewStatusRow
        item={artifact({ id: 'url', label: 'localhost:5173', target: 'http://localhost:5173' })}
        onDismiss={() => undefined}
      />
    )

    fireEvent.click(screen.getByText('localhost:5173'))

    await vi.waitFor(() => expect(openExternalLink).toHaveBeenCalledWith('http://localhost:5173'))
    expect($previewTabs.get()).toHaveLength(0)
  })

  it('opens a file target in the right-pane viewer, resolved against the captured cwd', async () => {
    render(<PreviewStatusRow item={artifact()} onDismiss={() => undefined} />)

    fireEvent.click(screen.getByText('preview.html'))

    await vi.waitFor(() => expect($activePreviewPath.get()).toBe('/repo/preview.html'))
    expect(openExternalLink).not.toHaveBeenCalled()
  })

  it('leaves an absolute file target alone', async () => {
    render(<PreviewStatusRow item={artifact({ target: '/tmp/out.html' })} onDismiss={() => undefined} />)

    fireEvent.click(screen.getByText('preview.html'))

    await vi.waitFor(() => expect($activePreviewPath.get()).toBe('/tmp/out.html'))
  })

  it('dismisses through the trailing button without activating the row', () => {
    const onDismiss = vi.fn()
    render(<PreviewStatusRow item={artifact()} onDismiss={onDismiss} />)

    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))

    expect(onDismiss).toHaveBeenCalledWith('preview.html')
    expect($activePreviewPath.get()).toBeNull()
  })

  it('keeps the preview tooltip label inline inside the portaled decoration', async () => {
    // A block child collapses Tip's decoration wrapper geometry and
    // mis-positions the tooltip (desktop #62022).
    const view = render(<PreviewStatusRow item={artifact()} onDismiss={() => undefined} />)

    fireEvent.pointerMove(screen.getByText('preview.html'), { pointerType: 'mouse' })
    await screen.findByRole('tooltip')

    const content = document.querySelector<HTMLElement>('[data-slot="tooltip-content"]')
    const label = content?.firstElementChild?.firstElementChild

    expect(content).not.toBeNull()
    expect(view.container.contains(content)).toBe(false)
    expect(label?.classList.contains('inline-flex')).toBe(true)
    expect(label?.classList.contains('flex')).toBe(false)
  })
})
