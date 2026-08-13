/**
 * What an expanded tool row shows: the terminal transcript, the search query
 * header, and the technical payload disclosure.
 *
 * THE GAPS THESE PIN. Universal's expanded row had none of the three. A
 * `terminal` call showed no record of what actually ran (the title carries the
 * gateway's 80-char summarized preview, not the command) and no exit code; a
 * command that printed nothing was not even expandable, so the row was a dead
 * end. A `web_search` row listed its hits with nothing saying what was searched
 * for. And technical mode dumped the raw payload of EVERY row inline, always
 * open, which buries the transcript it is meant to annotate.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { $toolDisclosureStates, $toolViewMode } from '@/store/tool-view'

vi.mock('@assistant-ui/react', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAuiState: (select: (state: unknown) => unknown) =>
    select({ message: { id: 'msg-1', status: { type: 'complete' } }, thread: { isRunning: false } })
}))

const { ToolFallback } = await import('./fallback')

const CALL_ID = 'call-1'
// Mirrors `toolEntryDisclosureId(messageId, part)` — the row is rendered
// already open so the assertions are about the body, not the toggle.
const DISCLOSURE_ID = `tool-entry:msg-1:tool:${CALL_ID}`

function renderRow(part: { args?: unknown; result?: unknown; toolName: string }, open = true) {
  if (open) {
    $toolDisclosureStates.set({ [DISCLOSURE_ID]: true })
  }

  render(<ToolFallback {...({ toolCallId: CALL_ID, ...part } as unknown as ComponentProps<typeof ToolFallback>)} />)
}

/** The row's own header button — the one carrying the disclosure state. */
function headerButton(): HTMLButtonElement {
  const button = screen.getAllByRole('button').at(0)

  if (!button) {
    throw new Error('tool row rendered no header button')
  }

  return button as HTMLButtonElement
}

afterEach(() => {
  cleanup()
  $toolDisclosureStates.set({})
  $toolViewMode.set('product')
})

describe('terminal transcript', () => {
  it('shows the command that actually ran and the exit code beside it', () => {
    // `context` is the gateway's summarized preview; `command` is the truth.
    // The transcript must print the latter (tui_gateway `_tool_ctx` caps the
    // preview at 80 chars, so the two are not interchangeable).
    renderRow({
      args: { command: 'pytest -q tests/test_gateway.py', context: 'pytest -q' },
      result: { exit_code: 0, output: '12 passed' },
      toolName: 'terminal'
    })

    expect(screen.getByText('pytest -q tests/test_gateway.py')).toBeTruthy()
    expect(screen.getByText('exit 0')).toBeTruthy()
  })

  it('reports the real code for a timed-out or interrupted run, never 0', () => {
    // 130 is what `tools/terminal_tool.py` returns for a genuine Stop, and 124
    // for a timeout. A view that flattened either to "exit 0" would report a
    // success for a command that never finished.
    renderRow({
      args: { command: 'sleep 900' },
      result: { exit_code: 130, output: '[Command interrupted]' },
      toolName: 'terminal'
    })

    expect(screen.getByText('exit 130')).toBeTruthy()
    expect(screen.queryByText('exit 0')).toBeNull()
  })

  it('shows no exit chip at all when the run never reported one', () => {
    // A turn cancelled before `tool.complete` fires settles the row against a
    // synthetic empty result. There is no code to show, so there is no chip —
    // the command alone is the honest readout.
    renderRow({ args: { command: 'sleep 900' }, result: {}, toolName: 'terminal' })

    expect(screen.getByText('sleep 900')).toBeTruthy()
    expect(screen.queryByText(/^exit /)).toBeNull()
  })

  it('keeps a command that printed nothing expandable', () => {
    // The whole point: `touch x` produces no output, so before the transcript
    // there was nothing to expand INTO and the header was a disabled dead end.
    renderRow({ args: { command: 'touch /tmp/x' }, result: { exit_code: 0, output: '' }, toolName: 'terminal' }, false)

    expect(headerButton().disabled).toBe(false)
  })

  it('does not print the command twice when there is no output', () => {
    // With no output the generic detail fallback echoes the args — the same
    // string the `$` line already shows, one row lower.
    renderRow({ args: { command: 'touch /tmp/x' }, result: { exit_code: 0, output: '' }, toolName: 'terminal' })

    expect(screen.getAllByText('touch /tmp/x')).toHaveLength(1)
  })

  it('leaves execute_code without a transcript', () => {
    // `execute_code` keeps the generic detail body; a `$` prompt would be a lie
    // about how the snippet was run.
    renderRow({ args: { code: 'print(1)' }, result: { exit_code: 0, output: '1' }, toolName: 'execute_code' })

    expect(screen.queryByText('print(1)')).toBeNull()
  })
})

describe('search query header', () => {
  it('names what was searched for above the hits', () => {
    renderRow({
      args: { query: 'tauri webkitgtk mask-image' },
      result: { web: [{ snippet: 'Docs', title: 'Tauri', url: 'https://example.com/t' }] },
      toolName: 'web_search'
    })

    expect(screen.getByText('Search')).toBeTruthy()
    expect(screen.getByText('tauri webkitgtk mask-image')).toBeTruthy()
  })
})

describe('technical payload disclosure', () => {
  it('keeps the raw payload collapsed until asked for', () => {
    $toolViewMode.set('technical')
    renderRow({ args: { path: '/tmp/demo.txt' }, result: { content: 'hello' }, toolName: 'read_file' })

    const toggle = screen.getByRole('button', { name: /tool payload/i })

    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText(/"path": "\/tmp\/demo.txt"/)).toBeNull()

    fireEvent.click(toggle)

    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText(/Arguments:/)).toBeTruthy()
    expect(screen.getByText(/"path": "\/tmp\/demo\.txt"/)).toBeTruthy()
  })

  it('offers the disclosure for a file edit too, not a second inline dump', () => {
    // A patch row used to take a different branch and render the payload in a
    // native <details>, whose browser-drawn triangle matches nothing else here.
    $toolViewMode.set('technical')
    renderRow({
      args: { path: '/tmp/a.ts' },
      result: { diff: '--- a/x\n+++ b/x\n@@\n-old\n+new' },
      toolName: 'patch'
    })

    expect(screen.getByRole('button', { name: /tool payload/i })).toBeTruthy()
    expect(document.querySelector('details')).toBeNull()
  })

  it('stays out of the way in product mode', () => {
    renderRow({ args: { path: '/tmp/demo.txt' }, result: { content: 'hello' }, toolName: 'read_file' })

    expect(screen.queryByRole('button', { name: /tool payload/i })).toBeNull()
  })
})
