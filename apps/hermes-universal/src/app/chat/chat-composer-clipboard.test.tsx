import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as ClipboardModule from '@/lib/clipboard'

// The composer's image-paste props are the whole subject here, so ChatBar is a
// prop recorder rather than the real 900-line composer.
const barProps: Record<string, unknown>[] = []

vi.mock('@/app/chat/composer', () => ({
  ChatBar: (props: Record<string, unknown>) => {
    barProps.push(props)

    return null
  }
}))
vi.mock('@/app/chat/hooks/use-slash-command', () => ({ useSlashCommand: () => vi.fn() }))
vi.mock('@/app/shell/model-menu-panel', () => ({ ModelMenuPanel: () => null }))

const clipboard = { canRead: true }

vi.mock('@/lib/clipboard', async importOriginal => ({
  ...(await importOriginal<typeof ClipboardModule>()),
  canReadClipboardImage: () => clipboard.canRead,
  readClipboardImage: vi.fn()
}))
vi.mock('@/app/chat/attachments', () => ({
  pickAttachment: vi.fn(),
  pickFolderAttachment: vi.fn(),
  pickRemoteAttachment: vi.fn(),
  pickRemoteFolderAttachment: vi.fn(),
  stageAttachmentFromBlob: vi.fn(async () => ({ name: 'shot.png', ref: '@image:shot.png' })),
  stagedToComposerAttachment: (staged: { name: string; ref: string }) => ({
    id: staged.ref,
    kind: 'image',
    label: staged.name,
    refText: staged.ref
  })
}))

import { stageAttachmentFromBlob } from '@/app/chat/attachments'
import { readClipboardImage } from '@/lib/clipboard'

import { ChatComposer } from './chat-composer'
import { type ComposerScope, ComposerScopeProvider, MAIN_COMPOSER_SCOPE } from './composer/scope'

const add = vi.fn()
const scope: ComposerScope = { ...MAIN_COMPOSER_SCOPE, attachments: { ...MAIN_COMPOSER_SCOPE.attachments, add } }

function mount() {
  barProps.length = 0
  render(
    <ComposerScopeProvider value={scope}>
      <ChatComposer />
    </ComposerScopeProvider>
  )

  return barProps.at(-1) as Record<string, unknown>
}

beforeEach(() => {
  clipboard.canRead = true
  add.mockReset()
  vi.mocked(stageAttachmentFromBlob).mockClear()
  vi.mocked(readClipboardImage).mockReset()
})

afterEach(cleanup)

// Both of these props existed on the composer's type, were destructured, and
// were used — and NOTHING ever passed them, so an image paste hit
// `preventDefault()` and vanished, and "Paste image" was permanently disabled
// (MJXHRM-415). These assertions are the guard against that regressing to
// undefined again.
describe('ChatComposer image-paste wiring', () => {
  it('hands ChatBar a blob attacher', async () => {
    const onAttachImageBlob = mount().onAttachImageBlob as (blob: Blob) => Promise<boolean>

    expect(onAttachImageBlob).toBeTypeOf('function')

    const blob = new Blob(['x'], { type: 'image/png' })

    await expect(onAttachImageBlob(blob)).resolves.toBe(true)
    expect(stageAttachmentFromBlob).toHaveBeenCalledWith(blob)
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ kind: 'image', refText: '@image:shot.png' }))
  })

  it('stages what the clipboard read returns', async () => {
    const blob = new Blob(['x'], { type: 'image/png' })
    vi.mocked(readClipboardImage).mockResolvedValue(blob)

    const paste = mount().onPasteClipboardImage as () => Promise<boolean>

    await expect(paste()).resolves.toBe(true)
    expect(stageAttachmentFromBlob).toHaveBeenCalledWith(blob)
  })

  it('answers false and attaches nothing when the clipboard holds no image', async () => {
    vi.mocked(readClipboardImage).mockResolvedValue(null)

    const paste = mount().onPasteClipboardImage as () => Promise<boolean>

    await expect(paste()).resolves.toBe(false)
    expect(stageAttachmentFromBlob).not.toHaveBeenCalled()
  })

  // Withheld, not passed-and-failing: the context menu renders the entry
  // disabled when the prop is absent, which is the honest state on Android and
  // iOS where the plugin's read_image is unsupported outright.
  it('withholds the paste-image action where no image read is possible', () => {
    clipboard.canRead = false

    expect(mount().onPasteClipboardImage).toBeUndefined()
  })
})
