/**
 * Double-click an assistant reply to heart it — the iMessage gesture.
 *
 * Ported from apps/desktop/src/components/assistant-ui/thread/double-click-reaction.test.tsx.
 * `isTapbackDoubleClick` is byte-identical to desktop's, so those three cases
 * come across verbatim.
 *
 * The two rendered cases needed one deliberate change. Desktop's hook writes the
 * optimistic overlay ITSELF (`setLocalReaction` then `toggleMessageReaction`), so
 * desktop can stub `toggleMessageReaction` and still watch the paint. Universal's
 * hook calls only `toggleMessageReaction`, which owns the optimistic write, the
 * authoritative overwrite and the rollback — stubbing it here would leave nothing
 * under test. So the seam mocked is one layer lower: `reactToMessage`, the
 * gateway RPC, exactly as SE-H's breadcrumb defines it. Everything above it —
 * the gesture guard, the toggle-vs-retract decision, the optimistic paint and the
 * footer's merge — is the shipped code.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MessageReactResult } from '@/lib/gateway-rpc'
import { $reactionsEnabled } from '@/store/reactions-enabled'
import { $agentReactions, $localReactions, $reactionRowIds } from '@/store/reactions-local'

import { isTapbackDoubleClick } from './use-message-reactions'

const MESSAGE_ID = 'assistant-1'

// A real atom: `useSessionView().$runtimeId` is read through `useStore`, and an
// empty id makes `toggleMessageReaction` bail with "No active session" — which
// would make every assertion below pass for the wrong reason.
const view = await vi.hoisted(async () => {
  const { atom } = await import('nanostores')

  return { $messages: atom<unknown[]>([]), $runtimeId: atom<null | string>('session-1') }
})

vi.mock('@/app/chat/session-view', () => ({
  branchSourceOf: () => undefined,
  useSessionView: () => view
}))

// The wire. Echoes back what it was sent, the way the backend does: the returned
// list is authoritative, so a hook that sent the WRONG emoji (e.g. re-hearting
// instead of retracting) is visible in the answer rather than hidden by the
// optimistic paint.
const reactToMessage = vi.fn(async ({ emoji }: { emoji: null | string }): Promise<MessageReactResult> => ({
  reactions: emoji ? [{ at: 1, author: 'user', emoji }] : [],
  row_id: 42
}))

vi.mock('@/lib/gateway-rpc', () => ({
  isMissingRpcMethod: () => false,
  reactToMessage: (params: { emoji: null | string }) => reactToMessage(params)
}))

// Transcript body and the settled-turn card are not what this gesture touches;
// both drag in the whole markdown/shiki stack.
vi.mock('./message-parts', () => ({ MESSAGE_PARTS_COMPONENTS: {} }))
vi.mock('./changed-files-card', () => ({ ChangedFilesCard: () => null }))
vi.mock('@/components/chat/preview-attachment', () => ({ PreviewAttachment: () => null }))

const message = {
  content: [{ text: 'done', type: 'text' }],
  id: MESSAGE_ID,
  metadata: { custom: {} },
  parts: [{ text: 'done', type: 'text' }],
  role: 'assistant',
  status: { reason: 'stop', type: 'complete' }
}

vi.mock('@assistant-ui/react', () => {
  const passthrough = ({ children }: { children?: ReactNode }) => <div>{children}</div>

  return {
    ActionBarPrimitive: { Root: passthrough },
    BranchPickerPrimitive: {
      Count: () => <span>1</span>,
      Next: passthrough,
      Number: () => <span>1</span>,
      Previous: passthrough,
      Root: passthrough
    },
    ErrorPrimitive: { Message: passthrough, Root: passthrough },
    MessagePrimitive: {
      // Forwards every prop, so `onDoubleClick` really has to be ON the root for
      // the gesture to fire — this is the wiring half of the test.
      Error: () => null,
      Parts: () => <span>done</span>,
      Root: ({ children, ...props }: ComponentProps<'div'>) => <div {...props}>{children}</div>
    },
    useAuiState: (selector: (state: unknown) => unknown) =>
      selector({ message, thread: { isRunning: false, messages: [message] } }),
    useMessageRuntime: () => ({ getState: () => message })
  }
})

vi.mock('@/hooks/use-resize-observer', () => ({ useResizeObserver: () => undefined }))

const { AssistantMessage } = await import('./assistant-message')

const root = () => document.querySelector('[data-slot="aui_assistant-message-root"]')!

beforeEach(() => {
  reactToMessage.mockClear()
  $localReactions.set({})
  $agentReactions.set({})
  $reactionRowIds.set({})
  $reactionsEnabled.set(false)
})

afterEach(() => {
  cleanup()
  $reactionsEnabled.set(false)
})

describe('isTapbackDoubleClick', () => {
  it('claims a plain double-click on message body', () => {
    expect(isTapbackDoubleClick({ detail: 2, target: document.createElement('span') })).toBe(true)
  })

  it('ignores a triple-click, so selecting a paragraph does not re-toggle', () => {
    expect(isTapbackDoubleClick({ detail: 3, target: document.createElement('span') })).toBe(false)
  })

  it('leaves double-click alone where it already means something', () => {
    const code = document.createElement('pre')
    const inner = document.createElement('code')

    code.append(inner)

    expect(isTapbackDoubleClick({ detail: 2, target: inner })).toBe(false)
    expect(isTapbackDoubleClick({ detail: 2, target: document.createElement('a') })).toBe(false)
    expect(isTapbackDoubleClick({ detail: 2, target: document.createElement('button') })).toBe(false)
  })
})

describe('double-click to heart an assistant message', () => {
  it('hearts the message, and a second double-click retracts it', async () => {
    $reactionsEnabled.set(true)
    render(<AssistantMessage />)

    fireEvent.doubleClick(root(), { detail: 2 })

    // Optimistic, BEFORE the wire answers: `toggleMessageReaction` paints the
    // overlay ahead of its first await, and the pending mock has not resolved.
    expect($localReactions.get()[MESSAGE_ID]).toEqual([expect.objectContaining({ author: 'user', emoji: '❤️' })])
    // …and it reaches the eye, not just the store.
    expect(await screen.findByText('❤️')).toBeInTheDocument()

    await waitFor(() => expect($reactionRowIds.get()[MESSAGE_ID]).toBe(42))
    expect(reactToMessage).toHaveBeenLastCalledWith(expect.objectContaining({ emoji: '❤️' }))

    fireEvent.doubleClick(root(), { detail: 2 })

    // The retract leg: same gesture, opposite emoji. A hook that re-sent '❤️'
    // would get '❤️' back from the echo and never empty the list.
    expect(reactToMessage).toHaveBeenLastCalledWith(expect.objectContaining({ emoji: null }))
    await waitFor(() => expect($localReactions.get()[MESSAGE_ID]).toEqual([]))
    expect(screen.queryByText('❤️')).toBeNull()
  })

  it('does nothing while reactions are off', async () => {
    render(<AssistantMessage />)

    fireEvent.doubleClick(root(), { detail: 2 })

    expect($localReactions.get()[MESSAGE_ID]).toBeUndefined()
    expect(reactToMessage).not.toHaveBeenCalled()
  })
})
