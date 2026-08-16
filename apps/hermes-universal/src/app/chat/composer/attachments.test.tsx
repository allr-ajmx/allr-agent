/**
 * The composer's attachment pills.
 *
 * Adapted from apps/desktop/src/app/chat/composer/attachments.test.tsx. Four of
 * desktop's six cases carry over as-is (universal's `AttachmentList` has the
 * same `.filter(Boolean)` guard against the stale entries a session switch can
 * leave behind). The fifth — "opens an attached image in the lightbox, not the
 * preview rail" — does NOT apply: universal has no composer lightbox, every
 * attachment kind routes to the right-pane preview tab. Its sibling is kept and
 * rewritten to assert that single route rather than the contrast desktop draws.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ComposerAttachment } from '@/store/composer'
import { $previewTabs } from '@/store/preview'

import { AttachmentList } from './attachments'

function makeAttachment(id: string, label = 'test.pdf'): ComposerAttachment {
  return { id, kind: 'file', label }
}

beforeEach(() => {
  $previewTabs.set([])
})

afterEach(() => {
  cleanup()
  $previewTabs.set([])
})

describe('AttachmentList', () => {
  it('renders valid attachments', () => {
    render(<AttachmentList attachments={[makeAttachment('a', 'doc.pdf'), makeAttachment('b', 'img.png')]} />)

    expect(screen.getByText('doc.pdf')).toBeDefined()
    expect(screen.getByText('img.png')).toBeDefined()
  })

  it('renders empty list without error', () => {
    const { container } = render(<AttachmentList attachments={[]} />)

    expect(container.querySelector('[data-slot="composer-attachments"]')).not.toBeNull()
    expect(container.querySelectorAll('button')).toHaveLength(0)
  })

  it('does not crash when attachments array contains undefined entries', () => {
    // Repro: a session switch can leave stale/undefined entries in the
    // attachments array, and the pill reads `attachment.kind` unguarded.
    const attachments = [
      makeAttachment('a', 'good.pdf'),
      undefined as unknown as ComposerAttachment,
      makeAttachment('b', 'also-good.png')
    ]

    expect(() => render(<AttachmentList attachments={attachments} />)).not.toThrow()

    expect(screen.getByText('good.pdf')).toBeDefined()
    expect(screen.getByText('also-good.png')).toBeDefined()
  })

  it('does not crash when attachments array contains null entries', () => {
    const attachments = [null as unknown as ComposerAttachment, makeAttachment('a', 'valid.txt')]

    expect(() => render(<AttachmentList attachments={attachments} />)).not.toThrow()

    expect(screen.getByText('valid.txt')).toBeDefined()
  })

  it('routes an attachment to the right-pane preview tab', async () => {
    const file: ComposerAttachment = { id: 'doc', kind: 'file', label: 'notes.md', path: '/tmp/notes.md' }

    render(<AttachmentList attachments={[file]} />)

    fireEvent.click(screen.getByRole('button', { name: /notes\.md/ }))

    await new Promise(resolve => setTimeout(resolve, 0))

    expect($previewTabs.get().map(tab => tab.path)).toEqual(['/tmp/notes.md'])
  })

  it('leaves a folder pill inert — there is nothing to preview', async () => {
    const folder: ComposerAttachment = { id: 'dir', kind: 'folder', label: 'src', path: '/tmp/src' }

    render(<AttachmentList attachments={[folder]} />)

    const pill = screen.getByRole('button', { name: /src/ })

    expect(pill).toBeDisabled()

    fireEvent.click(pill)
    await new Promise(resolve => setTimeout(resolve, 0))

    expect($previewTabs.get()).toHaveLength(0)
  })
})
