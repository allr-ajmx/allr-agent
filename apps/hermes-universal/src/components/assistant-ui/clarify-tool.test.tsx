import type * as AssistantUI from '@assistant-ui/react'
import type { ToolCallMessagePartProps } from '@assistant-ui/react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import type * as ChatStore from '@/store/chat'

// The live panel asks assistant-ui whether its message is still streaming. There
// is no runtime in a unit test, so drive it from here and leave the rest of the
// module intact (ToolFallback and friends import from it at module scope).
//
// MUTABLE, deliberately. This used to be pinned to `true`, which mocked away the
// subject of the panel's own live-or-dead gate: every test ran against a
// "running" message, so the branch that decides whether a clarify is still
// answerable had no coverage at all — and the paths the synthetic clarify row
// exists for are precisely the ones where the message does NOT look running.
const aui = vi.hoisted(() => ({ messageRunning: true }))

vi.mock('@assistant-ui/react', async importActual => {
  const actual = await importActual<typeof AssistantUI>()

  return { ...actual, useAuiState: () => aui.messageRunning }
})

// The expired-answer path is decided by the gateway's reply, so the responder
// is the seam. Everything else in the chat store stays real.
vi.mock('@/store/chat', async importActual => {
  const actual = await importActual<typeof ChatStore>()

  return { ...actual, respondClarify: vi.fn().mockResolvedValue('delivered') }
})

import { onComposerInsertRequest } from '@/app/chat/composer/focus'
import { respondClarify } from '@/store/chat'
import { setSessionClarify } from '@/store/prompts'
import { seedActiveSession } from '@/test-sessions'

import { ClarifyTool, readClarifyResult } from './clarify-tool'

afterEach(() => {
  cleanup()
  seedActiveSession('sess-1')
  setSessionClarify('sess-1', null)
  aui.messageRunning = true
  vi.mocked(respondClarify).mockClear()
  vi.mocked(respondClarify).mockResolvedValue('delivered')
})

function renderClarify(ui: ReactNode) {
  return render(<I18nProvider>{ui}</I18nProvider>)
}

/**
 * Settle the send the panel just started.
 *
 * A bare `setTimeout(0)` was NOT enough: `respond` awaits `respondClarify` and
 * does its expired-answer work in the continuation, so under load the draft
 * could land after the assertion — and after `dispose()` — which then showed up
 * in the NEXT test's listener. That is how these two tests failed as a pair,
 * one short and one long, but only when the file ran alongside others.
 *
 * Awaiting the panel's OWN promise fixes the order rather than out-waiting it:
 * the component registered its continuation first, so it runs first, and the
 * macrotask after it flushes anything the continuation queued.
 */
async function settleRespond() {
  await act(async () => {
    await vi.mocked(respondClarify).mock.results.at(-1)?.value
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

function clarifyProps(
  args: ToolCallMessagePartProps['args'],
  result: ToolCallMessagePartProps['result'],
  toolCallId: string
): ToolCallMessagePartProps {
  return {
    addResult: vi.fn(),
    args,
    argsText: JSON.stringify(args),
    isError: false,
    respondToApproval: vi.fn(),
    result,
    resume: vi.fn(),
    status: result === undefined ? { type: 'running' } : { type: 'complete' },
    toolCallId,
    toolName: 'clarify',
    type: 'tool-call'
  } as unknown as ToolCallMessagePartProps
}

describe('readClarifyResult', () => {
  it('reads question + user_response from the tool JSON payload', () => {
    expect(
      readClarifyResult({
        question: 'Which target?',
        choices_offered: ['staging', 'prod'],
        user_response: 'staging'
      })
    ).toEqual({
      question: 'Which target?',
      answer: 'staging',
      error: undefined
    })
  })

  it('parses a JSON string result the same way as an object', () => {
    expect(
      readClarifyResult(
        JSON.stringify({
          question: 'Ship it?',
          user_response: 'yes'
        })
      )
    ).toEqual({
      question: 'Ship it?',
      answer: 'yes',
      error: undefined
    })
  })

  it('keeps an empty user_response so Skip can render as skipped', () => {
    expect(readClarifyResult({ question: 'Ok?', user_response: '' })).toEqual({
      question: 'Ok?',
      answer: '',
      error: undefined
    })
  })
})

describe('ClarifyTool live view', () => {
  // The regression this guards: `tool.start` carries NO args, so a panel that
  // only read args showed a spinner (and the user fell back to free text)
  // instead of the question + choice buttons the gateway actually sent.
  it('renders the question and choices from the clarify.request store', () => {
    setSessionClarify('sess-1', { requestId: 'c1', question: 'Which deployment target?', choices: ['staging', 'prod'] })

    renderClarify(<ClarifyTool {...clarifyProps({}, undefined, 'clarify-live-1')} />)

    expect(screen.getByText('Which deployment target?')).toBeTruthy()
    expect(screen.getByRole('button', { name: /staging/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /prod/ })).toBeTruthy()
    // The trailing free-form escape hatch is still offered.
    expect(screen.getByPlaceholderText('Other (type your answer)')).toBeTruthy()
  })

  it('offers a free-form answer when the question has no choices', () => {
    setSessionClarify('sess-1', { requestId: 'c2', question: 'Anything else?', choices: null })

    renderClarify(<ClarifyTool {...clarifyProps({}, undefined, 'clarify-live-2')} />)

    expect(screen.getByText('Anything else?')).toBeTruthy()
    expect(screen.getByPlaceholderText('Type your answer…')).toBeTruthy()
    expect(screen.queryByPlaceholderText('Other (type your answer)')).toBeNull()
  })

  it('waits on a spinner until the gateway request lands', () => {
    renderClarify(<ClarifyTool {...clarifyProps({ question: 'Which target?' }, undefined, 'clarify-live-3')} />)

    expect(screen.getByRole('status')).toBeTruthy()
    expect(screen.queryByText('Which target?')).toBeNull()
  })
})

describe('ClarifyTool settled view', () => {
  it('keeps the question and answer visible after the tool completes', () => {
    renderClarify(
      <ClarifyTool
        {...clarifyProps(
          { question: 'Which deployment target?', choices: ['staging', 'prod'] },
          {
            question: 'Which deployment target?',
            choices_offered: ['staging', 'prod'],
            user_response: 'staging'
          },
          'clarify-1'
        )}
      />
    )

    expect(screen.getByText('Which deployment target?')).toBeTruthy()
    expect(screen.getByText('staging')).toBeTruthy()
    expect(document.querySelector('[data-clarify-settled]')).toBeTruthy()
    expect(document.querySelector('[data-clarify-answer]')?.textContent).toBe('staging')
  })

  it('labels an empty response as Skipped', () => {
    renderClarify(
      <ClarifyTool
        {...clarifyProps(
          { question: 'Anything else?' },
          { question: 'Anything else?', user_response: '' },
          'clarify-2'
        )}
      />
    )

    expect(screen.getByText('Anything else?')).toBeTruthy()
    expect(screen.getByText('Skipped')).toBeTruthy()
  })
})

describe('ClarifyTool choice hygiene', () => {
  // Choices come out of a model's tool call, so they are only as well-formed as
  // the model made them: a blank entry renders an unlabelled button, a
  // multi-line one breaks the single-row layout.
  it('drops blank, multi-line and over-long choices before rendering', () => {
    setSessionClarify('sess-1', {
      requestId: 'c-hygiene',
      question: 'Pick one',
      choices: ['staging', '   ', 'two\nlines', 'x'.repeat(400), 'prod']
    })

    renderClarify(<ClarifyTool {...clarifyProps({}, undefined, 'clarify-hygiene')} />)

    expect(screen.getByRole('button', { name: /staging/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /prod/ })).toBeTruthy()
    expect(document.querySelectorAll('[data-choice]')).toHaveLength(2)
  })
})

describe('ClarifyTool keyboard navigation', () => {
  const renderWithChoices = (id: string) => {
    setSessionClarify('sess-1', { requestId: id, question: 'Which target?', choices: ['staging', 'prod'] })
    renderClarify(<ClarifyTool {...clarifyProps({}, undefined, id)} />)
  }

  const press = (key: string) => act(() => void fireEvent.keyDown(window, { key }))

  const highlighted = () => document.querySelector('[data-highlighted]')?.textContent ?? ''

  it('moves a cursor with the arrow keys, wrapping past the Other row', () => {
    renderWithChoices('c-arrows')

    // The cursor starts on the first choice.
    expect(highlighted()).toContain('staging')

    press('ArrowDown')

    expect(highlighted()).toContain('prod')

    // One more lands on the trailing "Other" row, then wraps to the top.
    press('ArrowDown')

    expect(document.querySelector('label[data-highlighted]')).toBeTruthy()

    press('ArrowDown')

    expect(highlighted()).toContain('staging')
  })

  it('picks a choice by digit as well as by letter', () => {
    renderWithChoices('c-digits')
    press('2')

    // Picking stages the answer — Continue enables rather than firing at once.
    expect(screen.getByRole('button', { name: /Continue/ }).hasAttribute('disabled')).toBe(false)
    expect(document.querySelector('[data-choice][aria-current]')?.textContent).toContain('prod')
  })

  // Arrow navigation is a move, not a pick: leaving a staged answer behind
  // would let the cursor and the selection disagree about what Enter sends.
  it('clears a staged answer when the cursor moves', () => {
    renderWithChoices('c-move-clears')
    press('1')

    expect(screen.getByRole('button', { name: /Continue/ }).hasAttribute('disabled')).toBe(false)

    press('ArrowDown')

    expect(screen.getByRole('button', { name: /Continue/ }).hasAttribute('disabled')).toBe(true)
  })

  // Testing only INPUT/TEXTAREA let a focused Skip button lose its own Enter
  // to the card's global handler.
  it('stands down while any focusable control holds focus', () => {
    renderWithChoices('c-focus-guard')

    const skip = screen.getByRole('button', { name: 'Skip' })
    act(() => skip.focus())
    press('2')

    // Nothing was staged: Continue stays disabled and the cursor never left
    // the first row it started on.
    expect(screen.getByRole('button', { name: /Continue/ }).hasAttribute('disabled')).toBe(true)
    expect(document.querySelector('[data-choice][aria-current]')?.textContent).toContain('staging')
  })
})

// The card binds the DOCUMENT, but it is one surface among many: keep-alive
// leaves an inactive tab's clarify mounted, and a split can show two at once.
// The composer has always been visible-scoped (`clarifyCardOwnsKey`); the card
// was not, so a background question ate the foreground's letters and Enter
// answered it — into the wrong session.
describe('ClarifyTool key ownership across surfaces', () => {
  const press = (key: string) => act(() => void fireEvent.keyDown(window, { key }))

  /** Where the keyboard cursor sits — `aria-current` is the card's own read of it. */
  const cursor = (root: HTMLElement) => root.querySelector('[data-choice][aria-current]')?.textContent ?? ''

  /** Continue enables only once an answer is STAGED, so it is the pick signal. */
  const staged = (root: HTMLElement) =>
    !within(root)
      .getByRole('button', { name: /Continue/ })
      .hasAttribute('disabled')

  it('ignores keys while it sits in a hidden pane', () => {
    seedActiveSession('sess-1')
    setSessionClarify('sess-1', { requestId: 'c-hidden', question: 'Which target?', choices: ['staging', 'prod'] })

    render(
      <I18nProvider>
        <div data-pane-hidden="" data-testid="hidden">
          <ClarifyTool {...clarifyProps({}, undefined, 'c-hidden')} />
        </div>
      </I18nProvider>
    )

    const card = screen.getByTestId('hidden')

    press('2')

    // Nothing picked, and the cursor never left the row it mounted on.
    expect(staged(card)).toBe(false)
    expect(cursor(card)).toContain('staging')
  })

  // The hidden card is mounted FIRST, which is what a tab round-trip leaves
  // behind. Its handler therefore runs first and used to `preventDefault()` the
  // key, so the `defaultPrevented` guard then silenced the card the user was
  // actually looking at: the keystroke landed in the background session and
  // vanished from the foreground one.
  it('does not let a background card take the key from the visible one', () => {
    seedActiveSession('sess-1')
    setSessionClarify('sess-1', { requestId: 'c-split', question: 'Which target?', choices: ['staging', 'prod'] })

    render(
      <I18nProvider>
        <div data-pane-hidden="" data-testid="background">
          <ClarifyTool {...clarifyProps({}, undefined, 'c-split-hidden')} />
        </div>
        <div data-testid="foreground">
          <ClarifyTool {...clarifyProps({}, undefined, 'c-split-visible')} />
        </div>
      </I18nProvider>
    )

    const [background, foreground] = [screen.getByTestId('background'), screen.getByTestId('foreground')]

    press('2')

    expect(staged(foreground)).toBe(true)
    expect(cursor(foreground)).toContain('prod')

    expect(staged(background)).toBe(false)
    expect(cursor(background)).toContain('staging')
  })
})

// `clarify.respond` is `allow_expired`, so a question the backend's own timeout
// already popped answers OK and delivers nothing. The panel used to treat that
// as a normal send: the card settled, the words were gone, and the user had no
// idea the agent never heard them.
describe('ClarifyTool expired answer', () => {
  it('drafts a follow-up when the answer arrives after the timeout', async () => {
    seedActiveSession('sess-1')
    setSessionClarify('sess-1', { requestId: 'c-expired', question: 'Which target?', choices: ['staging', 'prod'] })
    vi.mocked(respondClarify).mockResolvedValue('expired')

    const inserted: string[] = []
    const dispose = onComposerInsertRequest(({ text }) => inserted.push(text))

    renderClarify(<ClarifyTool {...clarifyProps({}, undefined, 'c-expired')} />)

    // Picking stages; Continue is what sends.
    fireEvent.click(screen.getByRole('button', { name: /prod/ }))
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }))
    await settleRespond()
    dispose()

    expect(inserted).toHaveLength(1)
    expect(inserted[0]).toContain('prod')
    expect(inserted[0]).toContain('Which target?')
  })

  it('drafts nothing when the answer landed in time', async () => {
    seedActiveSession('sess-1')
    setSessionClarify('sess-1', { requestId: 'c-in-time', question: 'Which target?', choices: ['staging', 'prod'] })

    const inserted: string[] = []
    const dispose = onComposerInsertRequest(({ text }) => inserted.push(text))

    renderClarify(<ClarifyTool {...clarifyProps({}, undefined, 'c-in-time')} />)

    fireEvent.click(screen.getByRole('button', { name: /prod/ }))
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }))
    await settleRespond()
    dispose()

    expect(inserted).toEqual([])
  })
})

describe('ClarifyTool skipped choices', () => {
  // The blocking request is long gone — the tool already returned empty — so a
  // pick cannot resolve it retroactively. It drafts a follow-up instead.
  it('keeps a skipped clarify answerable by drafting a follow-up', async () => {
    const inserted: string[] = []
    const dispose = onComposerInsertRequest(({ text }) => inserted.push(text))

    renderClarify(
      <ClarifyTool
        {...clarifyProps(
          { question: 'Which target?', choices: ['staging', 'prod'] },
          { question: 'Which target?', user_response: '' },
          'clarify-late'
        )}
      />
    )

    expect(document.querySelector('[data-clarify-late-choices]')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /prod/ }))
    // The composer bus dispatches on a macrotask so a click handler can finish
    // before the composer reacts.
    await act(() => new Promise(resolve => setTimeout(resolve, 0)))
    dispose()

    expect(inserted).toHaveLength(1)
    expect(inserted[0]).toContain('prod')
    expect(inserted[0]).toContain('Which target?')
  })

  it('shows no late choices for an ANSWERED clarify', () => {
    renderClarify(
      <ClarifyTool
        {...clarifyProps(
          { question: 'Which target?', choices: ['staging', 'prod'] },
          { question: 'Which target?', user_response: 'staging' },
          'clarify-answered'
        )}
      />
    )

    expect(document.querySelector('[data-clarify-late-choices]')).toBeNull()
  })
})

/**
 * MJXHRM-362. `selectMessageRunning` is `slice.busy && row.pending`, and `busy`
 * is written by `message.start` — an event that has ALREADY gone by on every
 * path the synthetic clarify row exists for (a background session whose slice
 * the request created, a mid-turn reattach, a cold open of a parked session).
 * Gating the interactive panel on it alone meant the row the reducer went to the
 * trouble of synthesizing rendered as a dead collapsed tool row, and the agent
 * stayed parked in the backend's `_block` with the question on screen but
 * unanswerable.
 */
describe('ClarifyTool live gate', () => {
  it('stays answerable when the turn does not look live but the clarify is parked', async () => {
    aui.messageRunning = false
    setSessionClarify('sess-1', { requestId: 'c-parked', question: 'Which branch?', choices: ['main', 'dev'] })

    renderClarify(<ClarifyTool {...clarifyProps({ question: 'Which branch?' }, undefined, 'req-parked')} />)

    expect(screen.getByText('Which branch?')).toBeTruthy()

    const choice = screen.getByRole('button', { name: /main/ })

    fireEvent.click(choice)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /continue/i }))
    })

    expect(respondClarify).toHaveBeenCalledWith('main', 'sess-1')
  })

  // The other half of the same gate: a turn that stopped mid-prompt with nothing
  // parked must NOT leave an interactive panel offering to answer a dead
  // request. `message.complete` / `error` clear the store entry.
  it('falls back to a plain tool row when the turn stopped and nothing is parked', () => {
    aui.messageRunning = false

    renderClarify(<ClarifyTool {...clarifyProps({ question: 'Which branch?' }, undefined, 'req-dead')} />)

    expect(screen.queryByPlaceholderText('Other (type your answer)')).toBeNull()
    expect(document.querySelector('[data-clarify-choices]')).toBeNull()
  })

  // A stale row whose `tool.complete` was lost must not hijack the NEW question.
  it('does not offer a stale row the request parked for a different question', () => {
    aui.messageRunning = false
    setSessionClarify('sess-1', { requestId: 'c-new', question: 'Which region?', choices: ['eu'] })

    renderClarify(<ClarifyTool {...clarifyProps({ question: 'Which branch?' }, undefined, 'req-stale')} />)

    expect(screen.queryByRole('button', { name: /eu/ })).toBeNull()
    expect(document.querySelector('[data-clarify-choices]')).toBeNull()
  })
})
