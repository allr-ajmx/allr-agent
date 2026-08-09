import type * as AssistantUI from '@assistant-ui/react'
import type { ToolCallMessagePartProps } from '@assistant-ui/react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

// The live panel asks assistant-ui whether its message is still streaming. There
// is no runtime in a unit test, so pin it to "running" and leave the rest of the
// module intact (ToolFallback and friends import from it at module scope).
vi.mock('@assistant-ui/react', async importActual => {
  const actual = await importActual<typeof AssistantUI>()

  return { ...actual, useAuiState: () => true }
})

import { onComposerInsertRequest } from '@/app/chat/composer/focus'
import { setSessionClarify } from '@/store/prompts'
import { seedActiveSession } from '@/test-sessions'

import { ClarifyTool, readClarifyResult } from './clarify-tool'

afterEach(() => {
  cleanup()
  seedActiveSession('sess-1')
  setSessionClarify('sess-1', null)
})

function renderClarify(ui: ReactNode) {
  return render(<I18nProvider>{ui}</I18nProvider>)
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
