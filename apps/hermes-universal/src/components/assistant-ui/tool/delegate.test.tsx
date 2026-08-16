import type * as AssistantUI from '@assistant-ui/react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The row chrome asks assistant-ui whether its message is still streaming;
// there is no runtime in a unit test. Keep the rest of the module intact —
// `ToolFallback` and friends import from it at module scope.
vi.mock('@assistant-ui/react', async importActual => {
  const actual = await importActual<typeof AssistantUI>()

  return { ...actual, useAuiState: () => true }
})

import { I18nProvider } from '@/i18n'
import { $subagentsBySession } from '@/store/subagents'
import { seedActiveSession } from '@/test-sessions'

import { DelegateTool } from './delegate'

afterEach(() => {
  cleanup()
  $subagentsBySession.set({})
})

function renderDelegate(props: Parameters<typeof DelegateTool>[0]) {
  seedActiveSession('sess-1')

  return render(
    <I18nProvider>
      <DelegateTool {...props} />
    </I18nProvider>
  )
}

describe('DelegateTool', () => {
  it('lists one row per dispatched goal once the call carries its tasks', () => {
    renderDelegate({
      args: { tasks: [{ goal: 'Audit the router' }, { goal: 'Port the tests' }] },
      result: undefined,
      toolCallId: 'call-1'
    })

    expect(screen.getByText('Audit the router')).toBeTruthy()
    expect(screen.getByText('Port the tests')).toBeTruthy()
  })

  // The gateway's `tool.start` carries `{tool_id, name, context}` and NOTHING
  // else — arguments arrive on `tool.complete` (tui_gateway/server.py
  // `_on_tool_start`). So for the whole of a live run the call describes no
  // children, and a card that renders `null` there makes a running delegation
  // invisible for exactly as long as it is running.
  it('renders the fallback while the call still has no goals to list', () => {
    renderDelegate({
      args: { context: 'delegate_task' },
      fallback: <span>generic tool row</span>,
      result: undefined,
      toolCallId: 'call-1'
    })

    expect(screen.getByText('generic tool row')).toBeTruthy()
  })

  it('drops the fallback the moment the goals arrive', () => {
    renderDelegate({
      args: { context: 'delegate_task', tasks: [{ goal: 'Audit the router' }] },
      fallback: <span>generic tool row</span>,
      result: undefined,
      toolCallId: 'call-1'
    })

    expect(screen.queryByText('generic tool row')).toBeNull()
    expect(screen.getByText('Audit the router')).toBeTruthy()
  })
})
