import { act, cleanup, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The bubble only needs message text + thread state from the runtime; stub the
// primitives so the clamp behaviour can be exercised without mounting a whole
// assistant-ui thread. (Everything the factory uses must be declared inside it
// — vi.mock is hoisted above the module's top-level bindings.)
vi.mock('@assistant-ui/react', () => {
  const passthrough = ({ children }: { children?: ReactNode }) => <div>{children}</div>

  return {
    ActionBarPrimitive: { Root: passthrough, Edit: passthrough },
    BranchPickerPrimitive: {
      Root: passthrough,
      Previous: passthrough,
      Next: passthrough,
      Number: () => <span>1</span>,
      Count: () => <span>1</span>
    },
    MessagePrimitive: { Root: passthrough },
    useAuiState: (selector: (state: unknown) => unknown) =>
      selector({
        message: { id: 'm1', content: [{ type: 'text', text: 'a very long prompt' }] },
        thread: { isRunning: false, messages: [{ id: 'm1', role: 'user' }] }
      })
  }
})

// Drive the clamp measurement by hand: jsdom reports no layout, so the real
// observer would leave every bubble unclamped.
let emitSize: ((blockSize: number) => void) | null = null

vi.mock('@/hooks/use-resize-observer', () => ({
  useResizeObserver: (
    callback: (entries: readonly ResizeObserverEntry[]) => void,
    ref: { current: HTMLElement | null }
  ) => {
    emitSize = (blockSize: number) =>
      callback([{ target: ref.current, borderBoxSize: [{ blockSize }] } as unknown as ResizeObserverEntry])
  }
}))

import { UserMessage } from './user-message'

/** Render the bubble, then report a measured content height to the clamp logic. */
function renderClamped(blockSize: number) {
  render(<UserMessage />)
  act(() => emitSize?.(blockSize))
}

afterEach(() => {
  cleanup()
  emitSize = null
})

describe('UserMessage', () => {
  it('is a click-to-edit target carrying the prompt text', () => {
    renderClamped(20)

    const bubble = screen.getByRole('button', { name: 'Edit message' })
    expect(bubble.textContent).toContain('a very long prompt')
  })

  it('marks an overflowing bubble as clamped (fade + max-height) and a short one as not', () => {
    renderClamped(400)
    expect(document.querySelector('.sticky-human-clamp')?.getAttribute('data-clamped')).toBe('true')

    cleanup()
    renderClamped(20)
    expect(document.querySelector('.sticky-human-clamp')?.getAttribute('data-clamped')).toBeNull()
  })

  // MJXHRM-370: the restore affordance is gated on the handler being defined, and
  // `UserMessage` was mounted with NO props at all — so the whole
  // restore-checkpoint flow behind it was unreachable dead code.
  it('hides the restore affordance with no handler, and calls it with one', () => {
    render(<UserMessage />)
    expect(screen.queryByRole('button', { name: 'Restore checkpoint' })).toBeNull()

    cleanup()

    const onRequestRestoreConfirm = vi.fn()
    render(<UserMessage onRequestRestoreConfirm={onRequestRestoreConfirm} />)

    act(() => screen.getByRole('button', { name: 'Restore checkpoint' }).click())

    expect(onRequestRestoreConfirm).toHaveBeenCalledWith('m1', { text: 'a very long prompt' })
  })

  // MJXHRM-223: the bubble used to count its own user ordinal off
  // `thread.messages` and hand it over as the backend's truncation index. That
  // list is a WINDOWED tail (app/chat/transcript-window.ts), so on a long
  // session the number named an earlier turn than the one clicked and the rewind
  // discarded history nobody asked it to. The ordinal is resolved from the
  // session store in `thread.tsx` now; the bubble must not supply one.
  it('does not derive a store ordinal from the rendered thread', () => {
    const onRequestRestoreConfirm = vi.fn()
    render(<UserMessage onRequestRestoreConfirm={onRequestRestoreConfirm} />)

    act(() => screen.getByRole('button', { name: 'Restore checkpoint' }).click())

    const [, target] = onRequestRestoreConfirm.mock.calls[0] as [string, Record<string, unknown>]
    expect(Object.keys(target)).toEqual(['text'])
  })
})
