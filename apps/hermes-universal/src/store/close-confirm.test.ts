import { afterEach, describe, expect, it, vi } from 'vitest'

import { $pendingClose, requestClose, resolvePendingClose } from './close-confirm'

const drain = () => {
  while ($pendingClose.get()) {
    resolvePendingClose($pendingClose.get()!.token, false)
  }
}

afterEach(drain)

describe('the shared close gate', () => {
  it('runs the close straight through when nothing is at stake', () => {
    const close = vi.fn()

    requestClose({ close, id: 'a', kind: 'session' }, false)

    expect(close).toHaveBeenCalledTimes(1)
    expect($pendingClose.get()).toBeNull()
  })

  it('parks the close until the answer lands', () => {
    const close = vi.fn()

    requestClose({ close, id: 'a', kind: 'session' }, true)

    expect(close).not.toHaveBeenCalled()
    expect($pendingClose.get()).toMatchObject({ id: 'a', kind: 'session' })

    resolvePendingClose($pendingClose.get()!.token, true)

    expect(close).toHaveBeenCalledTimes(1)
    expect($pendingClose.get()).toBeNull()
  })

  it('a declined close never runs', () => {
    const close = vi.fn()

    requestClose({ close, id: 'a', kind: 'session' }, true)
    resolvePendingClose($pendingClose.get()!.token, false)

    expect(close).not.toHaveBeenCalled()
    expect($pendingClose.get()).toBeNull()
  })

  // The reason this is a QUEUE. "Close others" over three working chats used to
  // overwrite one pending id twice and prompt once, so two tabs silently
  // survived a verb the user had already confirmed.
  it('queues one prompt per target and answers them in turn', () => {
    const first = vi.fn()
    const second = vi.fn()

    requestClose({ close: first, id: 'a', kind: 'session' }, true)
    requestClose({ close: second, id: 'b', kind: 'session' }, true)

    expect($pendingClose.get()?.id).toBe('a')

    resolvePendingClose($pendingClose.get()!.token, true)

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
    expect($pendingClose.get()?.id).toBe('b')

    resolvePendingClose($pendingClose.get()!.token, true)

    expect(second).toHaveBeenCalledTimes(1)
    expect($pendingClose.get()).toBeNull()
  })

  it('one prompt per target, however many times a bulk verb names it', () => {
    const close = vi.fn()

    requestClose({ close, id: 'a', kind: 'session' }, true)
    requestClose({ close, id: 'a', kind: 'session' }, true)

    resolvePendingClose($pendingClose.get()!.token, true)

    expect(close).toHaveBeenCalledTimes(1)
    expect($pendingClose.get()).toBeNull()
  })

  it('separates the same id under two kinds', () => {
    const session = vi.fn()
    const file = vi.fn()

    requestClose({ close: session, id: 'x', kind: 'session' }, true)
    requestClose({ close: file, id: 'x', kind: 'file' }, true)

    expect($pendingClose.get()?.kind).toBe('session')
    resolvePendingClose($pendingClose.get()!.token, true)
    expect($pendingClose.get()?.kind).toBe('file')
  })

  // `ConfirmDialog` calls `onClose` AFTER a successful `onConfirm`, so both
  // handlers fire on one click. Answering by token is what stops that second
  // call popping the queue again and closing the next tab unasked.
  it('ignores a stale token, so a double answer cannot eat the next prompt', () => {
    const first = vi.fn()
    const second = vi.fn()

    requestClose({ close: first, id: 'a', kind: 'session' }, true)
    requestClose({ close: second, id: 'b', kind: 'session' }, true)

    const token = $pendingClose.get()!.token
    resolvePendingClose(token, true)
    // The dialog's onClose, arriving with the token it already answered.
    resolvePendingClose(token, false)

    expect(first).toHaveBeenCalledTimes(1)
    expect($pendingClose.get()?.id).toBe('b')
    expect(second).not.toHaveBeenCalled()
  })
})
