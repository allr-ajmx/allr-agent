import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/store/layout', () => ({ setTerminalOpen: vi.fn() }))

import {
  $activeTerminalId,
  $terminals,
  closeTerminalsToRight,
  createTerminal,
  noteTerminalCwd,
  selectTerminal,
  selectTerminalForCwd,
  terminalCloseTargets
} from './terminals'

beforeEach(() => {
  $terminals.set([])
  $activeTerminalId.set(null)
})

describe('noteTerminalCwd', () => {
  it('records the spawn directory once, and stays identity-stable on a repeat', () => {
    const id = createTerminal()
    noteTerminalCwd(id, '/work/repo')

    const after = $terminals.get()
    expect(after[0].cwd).toBe('/work/repo')

    noteTerminalCwd(id, '/work/repo')
    expect($terminals.get()).toBe(after)
  })

  it('ignores a terminal that has already been closed', () => {
    expect(() => noteTerminalCwd('term-gone', '/work/repo')).not.toThrow()
    expect($terminals.get()).toEqual([])
  })
})

describe('selectTerminalForCwd', () => {
  it('fronts the terminal that belongs to that directory', () => {
    const a = createTerminal()
    noteTerminalCwd(a, '/work/alpha')
    const b = createTerminal()
    noteTerminalCwd(b, '/work/beta')

    selectTerminal(a)
    selectTerminalForCwd('/work/beta')

    expect($activeTerminalId.get()).toBe(b)
  })

  it('leaves the current tab alone when nothing matches', () => {
    const a = createTerminal()
    noteTerminalCwd(a, '/work/alpha')

    selectTerminalForCwd('/work/unrelated')

    expect($activeTerminalId.get()).toBe(a)
  })

  it('never spawns a shell for a directory with no terminal', () => {
    selectTerminalForCwd('/work/alpha')

    expect($terminals.get()).toEqual([])
    expect($activeTerminalId.get()).toBeNull()
  })

  it('ignores a blank directory (a detached chat)', () => {
    const a = createTerminal()
    noteTerminalCwd(a, '/work/alpha')
    const b = createTerminal()

    selectTerminalForCwd('   ')

    expect($activeTerminalId.get()).toBe(b)
  })
})

// MJXHRM-409. The rail offered Close / others / all and stopped there; the
// fourth verb of the shared tab close group had no implementation to call.
describe('closeTerminalsToRight', () => {
  it('drops every terminal past the anchor', () => {
    const a = createTerminal()
    createTerminal()
    createTerminal()

    closeTerminalsToRight(a)

    expect($terminals.get().map(term => term.id)).toEqual([a])
  })

  it('rehomes the active terminal only when it was one of the closed ones', () => {
    const a = createTerminal()
    const b = createTerminal()
    createTerminal()

    // Active is the last-created (`/c`), which this closes.
    closeTerminalsToRight(b)
    expect($activeTerminalId.get()).toBe(b)

    const d = createTerminal()
    selectTerminal(a)
    closeTerminalsToRight(b)

    // `a` survived, so the selection stays put rather than jumping to the end.
    expect($activeTerminalId.get()).toBe(a)
    expect($terminals.get().map(term => term.id)).toEqual([a, b])
    expect(d).toBeTruthy()
  })

  it('is a no-op on the rightmost terminal and on an unknown id', () => {
    const a = createTerminal()
    const b = createTerminal()

    closeTerminalsToRight(b)
    closeTerminalsToRight('nope')

    expect($terminals.get().map(term => term.id)).toEqual([a, b])
  })
})

describe('terminalCloseTargets', () => {
  it('counts what each verb would close, so the menu disables the dead ones', () => {
    const a = createTerminal()
    createTerminal()
    const c = createTerminal()

    expect(terminalCloseTargets(a)).toEqual({ all: 3, others: 2, right: 2 })
    expect(terminalCloseTargets(c)).toEqual({ all: 3, others: 2, right: 0 })
    expect(terminalCloseTargets('gone')).toEqual({ all: 3, others: 0, right: 0 })
  })
})
