import { act, cleanup, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The wiring under test lives BETWEEN the bubble and the store, and neither end
// proves it: `user-message.test.tsx` renders the bubble with a handler it was
// handed, and `chat.test.ts` calls `restoreToMessage` directly. MJXHRM-370 was
// exactly this seam — `thread.tsx` mounted `UserMessage` with no props at all,
// so a fully implemented confirm flow and a fully implemented store verb never
// met. What has to be pinned is the whole path: bubble → context → dialog →
// `restoreToMessage`, with the session key and the store-global ordinal the
// destructive rewind is aimed by.
type TestMessage = { id: string; parts: { text: string; type: 'text' }[]; role: string }

// Real atoms, not `{ get }` stubs: everything under `<Thread>` that reads the
// view does so through `useStore`, which subscribes.
const view = await vi.hoisted(async () => {
  const { atom } = await import('nanostores')

  return {
    $messages: atom<TestMessage[]>([]),
    $runtimeId: atom<null | string>(null)
  }
})

vi.mock('@/app/chat/session-view', () => ({
  useSessionView: () => view
}))

// Partial: the bubble's reaction/todo hooks pull real atoms out of the store
// graph, and only the two verbs this seam calls are stubbed.
vi.mock('@/store/chat', async importOriginal => ({
  ...((await importOriginal()) as Record<string, unknown>),
  interruptSession: vi.fn().mockResolvedValue(true),
  restoreToMessage: vi.fn().mockResolvedValue(undefined)
}))

// Every `sessionKey` the list was handed, in render order. The list is memo'd
// and takes the key as a PROP, so recording the prop is the only way to see it —
// nothing it drives (the render-budget cut, the pin-to-bottom settle loop, the
// per-session scroll mirror) is observable from outside.
const listProps = vi.hoisted(() => ({ sessionKeys: [] as (null | string | undefined)[] }))

// The transcript list is a windowed, stick-to-bottom scroller; all this test
// needs from it is that the components map it is handed is what renders each
// message. Rendering `components.UserMessage` IS the assertion that the map
// reaches a message.
vi.mock('./list', () => ({
  ThreadMessageList: ({
    components,
    sessionKey
  }: {
    components: { UserMessage: () => ReactNode }
    sessionKey?: null | string
  }) => {
    listProps.sessionKeys.push(sessionKey)

    return (
      <div>
        <components.UserMessage />
      </div>
    )
  }
}))

vi.mock('./timeline', () => ({ ThreadTimeline: () => null }))
vi.mock('./status', () => ({ ResponseLoadingIndicator: () => null }))
vi.mock('@/components/chat/intro', () => ({ Intro: () => null }))
vi.mock('./assistant-message', () => ({ AssistantMessage: () => null }))
vi.mock('./system-message', () => ({ SystemMessage: () => null }))
vi.mock('./user-edit-composer', () => ({ UserEditComposer: () => null }))

// The REAL `UserMessage` renders below, so the affordance under test is the one
// the app ships. Only its assistant-ui substrate is stubbed.
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
    ThreadPrimitive: { Root: passthrough },
    useAuiState: (selector: (value: unknown) => unknown) =>
      selector({
        message: { id: 'h6-user', content: [{ type: 'text', text: 'the fourth ask' }] },
        // The thread renders a WINDOWED tail: this is the only list the bubble
        // can see, and it is three user turns short of the session's own.
        thread: { isRunning: false, messages: [{ id: 'h6-user', role: 'user' }] }
      })
  }
})

vi.mock('@/hooks/use-resize-observer', () => ({ useResizeObserver: () => {} }))

import { restoreToMessage } from '@/store/chat'

import { Thread } from './thread'

const userTurn = (id: string, text: string): TestMessage => ({
  id,
  parts: [{ text, type: 'text' as const }],
  role: 'user'
})

const assistantTurn = (id: string): TestMessage => ({
  id,
  parts: [{ text: 'ok', type: 'text' as const }],
  role: 'assistant'
})

/** A four-turn session; the bubble on screen (`h6-user`) is its FOURTH user turn. */
const seedSession = () => {
  view.$runtimeId.set('runtime-tile')
  view.$messages.set([
    userTurn('h0-user', 'the first ask'),
    assistantTurn('h1-assistant'),
    userTurn('h2-user', 'the second ask'),
    assistantTurn('h3-assistant'),
    userTurn('h4-user', 'the third ask'),
    assistantTurn('h5-assistant'),
    userTurn('h6-user', 'the fourth ask'),
    assistantTurn('h7-assistant')
  ])
}

const openConfirm = async () => {
  await act(async () => {
    screen.getByRole('button', { name: 'Restore checkpoint' }).click()
  })
}

const confirm = async () => {
  await act(async () => {
    screen.getByRole('button', { name: 'Restore & rerun' }).click()
  })
}

beforeEach(() => {
  seedSession()
  listProps.sessionKeys.length = 0
  vi.mocked(restoreToMessage).mockClear()
  vi.mocked(restoreToMessage).mockResolvedValue(undefined)
})

afterEach(cleanup)

describe('Thread restore-checkpoint wiring', () => {
  it('reaches the store from a user bubble, addressed to this thread’s session', async () => {
    render(<Thread />)

    // The affordance exists at all: `UserMessage` gates it on the handler being
    // defined, and it was mounted with none.
    await openConfirm()
    expect(screen.getByText('Restore to this checkpoint?')).toBeTruthy()

    await confirm()

    expect(restoreToMessage).toHaveBeenCalledWith(
      'h6-user',
      // The ordinal is counted over the SESSION's messages, not the windowed
      // tail the bubble was handed — that tail holds one user turn, so a
      // rendered-thread count would have aimed the truncation at turn 0.
      { text: 'the fourth ask', userOrdinal: 3 },
      // …and at THIS surface's session. Hydrated ids are positional, so
      // `h6-user` resolves just as well against another open chat.
      'runtime-tile'
    )
  })

  it('leaves the transcript alone when the dialog is dismissed', async () => {
    render(<Thread />)

    await openConfirm()
    await act(async () => {
      screen.getByRole('button', { name: 'Cancel' }).click()
    })

    expect(screen.queryByText('Restore to this checkpoint?')).toBeNull()
    expect(restoreToMessage).not.toHaveBeenCalled()
  })

  it('keeps the dialog open with the reason when the rewind is refused', async () => {
    vi.mocked(restoreToMessage).mockRejectedValue(new Error('session busy — interrupt the current turn'))

    render(<Thread />)
    await openConfirm()
    await confirm()

    // Closing optimistically would leave a truncated transcript with nothing
    // explaining it — and this rewind rolled back, so the thread is intact.
    expect(screen.getByText('Restore to this checkpoint?')).toBeTruthy()
    expect(screen.getByText('session busy — interrupt the current turn')).toBeTruthy()
  })

  // `restoreToMessage` defaults an omitted key to the ACTIVE chat. A surface
  // that does not know its own session must therefore refuse rather than omit
  // it: `h6-user` is a positional hydrated id and resolves perfectly well
  // against whatever chat happens to be on screen.
  it('refuses to rewind when this surface has no session key, instead of falling back to the active chat', async () => {
    view.$runtimeId.set(null)

    render(<Thread />)
    await openConfirm()
    await confirm()

    expect(restoreToMessage).not.toHaveBeenCalled()
    expect(screen.getByText('No active session to restore.')).toBeTruthy()
  })
})

/**
 * MJXHRM-381. `ThreadMessageList` declares a `sessionKey` prop and drives three
 * things off it — the render-budget cut on a warm session switch, the pin-to-
 * bottom settle loop, and (now) which session's scroll state the composer /
 * status stack / jump button read. Desktop's `thread/index.tsx` passes it; this
 * port did not, so inside the memo'd list it was permanently `undefined` and all
 * three were dead. Nothing downstream is observable from here, which is exactly
 * why nothing caught it — so the prop itself is what gets pinned.
 */
describe('Thread → ThreadMessageList session key', () => {
  it('hands the list this surface’s session key', () => {
    render(<Thread />)

    expect(listProps.sessionKeys.at(-1)).toBe('runtime-tile')
  })

  it('re-hands it when the surface switches session', async () => {
    render(<Thread />)
    await act(async () => {
      view.$runtimeId.set('runtime-other')
    })

    expect(listProps.sessionKeys.at(-1)).toBe('runtime-other')
  })
})
