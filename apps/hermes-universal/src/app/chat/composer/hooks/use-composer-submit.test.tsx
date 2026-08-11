import { renderHook } from '@testing-library/react'
import { createRef, type RefObject } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { RICH_INPUT_SLOT } from '../rich-editor'

import { useComposerSubmit } from './use-composer-submit'

/**
 * `queueDraft` is the mod+Enter / queue-button path. Its whole reason to exist
 * beyond `queueCurrentDraft` is that a keydown consumes the keystroke with
 * `preventDefault`, so `draftRef` — which only advances on an `input` event —
 * can be a keystroke (or a whole IME composition) behind the DOM.
 */
function setup(overrides: Partial<Parameters<typeof useComposerSubmit>[0]> = {}) {
  // The real editor root carries `data-slot={RICH_INPUT_SLOT}`; without it
  // `composerPlainText` treats the root as a block and appends a newline the
  // live composer never sees.
  const editor = document.createElement('div')
  editor.dataset.slot = RICH_INPUT_SLOT
  const editorRef = createRef<HTMLDivElement | null>() as RefObject<HTMLDivElement | null>
  editorRef.current = editor

  const draftRef = { current: '' } as RefObject<string>

  const args = {
    activeQueueSessionKey: 's1',
    activeQueueSessionKeyRef: { current: 's1' } as RefObject<string | null>,
    attachments: [],
    busy: true,
    compacting: false,
    clearDraft: vi.fn(),
    disabled: false,
    draftRef,
    drainNextQueued: vi.fn(async () => false),
    editorRef,
    exitQueuedEdit: vi.fn(() => false),
    focusInput: vi.fn(),
    inputDisabled: false,
    loadIntoComposer: vi.fn(),
    onCancel: vi.fn(),
    onSteer: vi.fn(async () => true),
    onSubmit: vi.fn(async () => true),
    queueCurrentDraft: vi.fn(() => true),
    queueEdit: null,
    queuedPrompts: [],
    sessionId: 's1',
    setComposerText: vi.fn(),
    stashAt: vi.fn(),
    ...overrides
  } as Parameters<typeof useComposerSubmit>[0]

  const { result } = renderHook(() => useComposerSubmit(args))

  return { args, draftRef, editor, result }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('queueDraft', () => {
  it('re-reads the editor before queueing, so the last keystroke is not dropped', () => {
    const { args, draftRef, editor, result } = setup()

    // The state the composer is in one keystroke after the last input event.
    draftRef.current = 'check the migratio'
    editor.textContent = 'check the migration'

    result.current.queueDraft()

    expect(draftRef.current).toBe('check the migration')
    expect(args.setComposerText).toHaveBeenCalledWith('check the migration')
    expect(args.queueCurrentDraft).toHaveBeenCalledTimes(1)
    expect(args.focusInput).toHaveBeenCalledTimes(1)
  })

  it('leaves the draft alone when the editor already agrees with it', () => {
    const { args, draftRef, editor, result } = setup()

    draftRef.current = 'already synced'
    editor.textContent = 'already synced'

    result.current.queueDraft()

    expect(args.setComposerText).not.toHaveBeenCalled()
    expect(args.queueCurrentDraft).toHaveBeenCalledTimes(1)
  })

  it('queues during a compaction — a summarize call has no live turn to correct', () => {
    const { args, draftRef, editor, result } = setup({ busy: false, compacting: true })

    draftRef.current = 'follow-u'
    editor.textContent = 'follow-up'

    result.current.queueDraft()

    expect(draftRef.current).toBe('follow-up')
    expect(args.queueCurrentDraft).toHaveBeenCalledTimes(1)
  })

  it('does nothing on an idle session — mod+Enter must never surprise-send', () => {
    const { args, draftRef, result } = setup({ busy: false })

    draftRef.current = 'idle draft'

    result.current.queueDraft()

    expect(args.queueCurrentDraft).not.toHaveBeenCalled()
  })

  it('does nothing while the composer is disabled', () => {
    const { args, draftRef, result } = setup({ disabled: true })

    draftRef.current = 'gateway is down'

    result.current.queueDraft()

    expect(args.queueCurrentDraft).not.toHaveBeenCalled()
  })
})
