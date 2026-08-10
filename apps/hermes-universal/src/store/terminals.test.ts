import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/store/layout', () => ({ setTerminalOpen: vi.fn() }))

import {
  $activeTerminalId,
  $terminals,
  createTerminal,
  noteTerminalCwd,
  selectTerminal,
  selectTerminalForCwd
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
