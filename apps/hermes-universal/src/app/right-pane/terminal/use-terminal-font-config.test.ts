// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The config→atom hop the ticket was filed about, isolated from the xterm the
// pane wraps around it. `data` is swapped between renders the way React Query
// swaps it: a revalidation returns a NEW object, which is what re-runs the sync.
const record = vi.hoisted(() => ({ data: undefined as unknown }))

vi.mock('@/app/hooks/use-config-record', () => ({
  useHermesConfigRecord: () => ({ data: record.data })
}))

import { $terminalFontFamily } from './terminal-font'
import { useTerminalFontFromConfig } from './use-terminal-font-config'

beforeEach(() => {
  record.data = undefined
  $terminalFontFamily.set('')
})

afterEach(cleanup)

describe('useTerminalFontFromConfig', () => {
  it('pushes the configured family into the live atom', () => {
    record.data = { terminal: { font_family: 'MesloLGS NF' } }
    renderHook(() => useTerminalFontFromConfig())

    expect($terminalFontFamily.get()).toBe('MesloLGS NF')
  })

  it('re-pushes on every revalidation — a config edit no longer waits for a remount', () => {
    record.data = { terminal: { font_family: 'MesloLGS NF' } }
    const { rerender } = renderHook(() => useTerminalFontFromConfig())

    // A hand-edit of config.yaml, picked up by the next fetch of the shared record.
    record.data = { terminal: { font_family: 'Hack Nerd Font' } }
    rerender()

    expect($terminalFontFamily.get()).toBe('Hack Nerd Font')
  })

  it('follows a profile switch back down to the bundled default', () => {
    record.data = { terminal: { font_family: 'MesloLGS NF' } }
    const { rerender } = renderHook(() => useTerminalFontFromConfig())

    record.data = { terminal: {} }
    rerender()

    expect($terminalFontFamily.get()).toBe('')
  })

  it('leaves the atom alone until the record arrives', () => {
    // Seeded by the Settings picker (same WebView) or a peer broadcast; an
    // in-flight fetch must not blank it back to the bundled default.
    $terminalFontFamily.set('Hack Nerd Font')
    const { rerender } = renderHook(() => useTerminalFontFromConfig())

    expect($terminalFontFamily.get()).toBe('Hack Nerd Font')

    record.data = { terminal: { font_family: 'MesloLGS NF' } }
    rerender()

    expect($terminalFontFamily.get()).toBe('MesloLGS NF')
  })
})
