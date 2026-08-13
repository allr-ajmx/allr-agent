/**
 * Which session a tool row files its previewable artifact under.
 *
 * Ported from apps/desktop/src/components/assistant-ui/tool/fallback-preview-scope.test.tsx.
 *
 * THE DEFECT THIS PINS. Universal's row read the GLOBAL `$sessionId`/`$currentCwd`
 * from `store/chat`, so a preview produced by a tool running inside a session
 * TILE was filed under the main chat. The composer status stack is keyed by
 * session (`$previewStatusBySession`), so the tile's own composer never showed
 * the link and the main chat showed one for a file it had not produced — and the
 * cwd recorded alongside it was the wrong session's, so a relative target
 * resolved against the wrong directory. Desktop fixed this; universal had not.
 */

import { cleanup, render } from '@testing-library/react'
import { atom } from 'nanostores'
import type { ComponentProps, ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { type SessionView, SessionViewProvider } from '@/app/chat/session-view'
import { $previewStatusBySession } from '@/store/preview-status'
import { $activeSessionKey } from '@/store/session-state-types'

vi.mock('@assistant-ui/react', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAuiState: (select: (state: unknown) => unknown) =>
    select({ message: { id: 'msg-1', status: { type: 'complete' } }, thread: { isRunning: false } })
}))

const { ToolFallback } = await import('./fallback')

const PRIMARY_ID = 'primary-session'
const TILE_ID = 'tile-session'

/** Minimal tile view: only the fields the tool row reads. */
function tileView(): SessionView {
  return {
    ...({} as SessionView),
    $cwd: atom('/tile/work'),
    $messages: atom([]),
    $runtimeId: atom<null | string>(TILE_ID),
    kind: 'tile'
  }
}

function renderToolRow(wrap: (node: ReactNode) => ReactNode) {
  const props = {
    args: { path: '/tile/work/report.html' },
    result: { path: '/tile/work/report.html' },
    toolCallId: 'call-1',
    toolName: 'write_file'
  } as unknown as ComponentProps<typeof ToolFallback>

  render(<>{wrap(<ToolFallback {...props} />)}</>)
}

afterEach(() => {
  cleanup()
  $previewStatusBySession.set({})
  $activeSessionKey.set('')
})

describe('tool row preview recording', () => {
  it('records into the session whose transcript the row is in, not the primary', () => {
    // The primary session is live and DIFFERENT — if the row read the global
    // atoms it would file under this one, which is exactly the bug.
    $activeSessionKey.set(PRIMARY_ID)

    const view = tileView()

    renderToolRow(node => <SessionViewProvider value={view}>{node}</SessionViewProvider>)

    const recorded = $previewStatusBySession.get()

    expect(Object.keys(recorded)).toEqual([TILE_ID])
    expect(recorded[TILE_ID]?.[0]?.cwd).toBe('/tile/work')
  })

  it('still records into the primary session for the main chat', () => {
    $activeSessionKey.set(PRIMARY_ID)

    renderToolRow(node => node)

    expect(Object.keys($previewStatusBySession.get())).toEqual([PRIMARY_ID])
  })
})
