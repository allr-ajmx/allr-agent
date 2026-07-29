import type * as AssistantUI from '@assistant-ui/react'
import type { ToolCallMessagePartProps } from '@assistant-ui/react'
import { cleanup, render, screen } from '@testing-library/react'
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
