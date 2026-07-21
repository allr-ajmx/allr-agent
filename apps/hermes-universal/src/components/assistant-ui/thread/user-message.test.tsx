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
})
