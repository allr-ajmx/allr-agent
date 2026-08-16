import { describe, expect, it } from 'vitest'

import { deriveChangedFiles } from './changed-files'

const edit = (path: string, diff: string, over: Record<string, unknown> = {}) => ({
  args: { path },
  result: { inline_diff: diff },
  toolName: 'write_file',
  type: 'tool-call',
  ...over
})

const diff = (added: number, removed: number) =>
  [...Array.from({ length: added }, () => '+new'), ...Array.from({ length: removed }, () => '-old')].join('\n')

describe('deriveChangedFiles', () => {
  it('folds a turn into one row per file, in first-touched order', () => {
    const files = deriveChangedFiles([edit('src/b.ts', diff(2, 1)), edit('src/a.ts', diff(1, 0))])

    expect(files.map(f => f.path)).toEqual(['src/b.ts', 'src/a.ts'])
    expect(files[0]).toMatchObject({ added: 2, name: 'b.ts', removed: 1 })
  })

  it('sums repeated edits to the same file', () => {
    const files = deriveChangedFiles([edit('src/a.ts', diff(2, 1)), edit('src/a.ts', diff(3, 4))])

    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ added: 5, removed: 5 })
  })

  it('ignores parts that are not landed file edits', () => {
    expect(
      deriveChangedFiles([
        // Still running: no result to count.
        { args: { path: 'src/a.ts' }, toolName: 'write_file', type: 'tool-call' },
        // Not a file-edit tool.
        edit('src/b.ts', diff(1, 0), { toolName: 'shell' }),
        // Not a tool call at all.
        { type: 'text' },
        null
      ])
    ).toEqual([])
  })
})
