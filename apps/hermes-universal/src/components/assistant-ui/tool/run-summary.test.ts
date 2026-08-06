import { describe, expect, it } from 'vitest'

import { isCardTool, splitRunItems } from './fallback'
import { isToolCallPart, summarizeToolRun, type ToolCallLike, toolPresentVerb } from './run-summary'

const call = (toolName: string, args: unknown = {}, settled = true): ToolCallLike => ({
  args,
  toolCallId: `${toolName}-${Math.abs(JSON.stringify(args).length)}`,
  toolName,
  ...(settled ? { result: 'ok' } : {})
})

describe('isCardTool', () => {
  it('keeps a file edit on screen — the diff is usually the point of the turn', () => {
    expect(isCardTool('edit_file')).toBe(true)
    expect(isCardTool('write_file')).toBe(true)
  })

  it('keeps the tools that render their own markup on screen', () => {
    expect(isCardTool('clarify')).toBe(true)
    expect(isCardTool('delegate_task')).toBe(true)
    expect(isCardTool('image_generate')).toBe(true)
  })

  it('lets ephemeral activity collapse into a run', () => {
    expect(isCardTool('read_file')).toBe(false)
    expect(isCardTool('terminal')).toBe(false)
    expect(isCardTool('web_search')).toBe(false)
  })
})

describe('splitRunItems', () => {
  it('collapses a back-to-back stretch of activity into one run', () => {
    expect(splitRunItems(['read_file', 'search_files', 'terminal'])).toEqual([{ end: 2, kind: 'run', start: 0 }])
  })

  it('preserves the order work actually happened in', () => {
    expect(splitRunItems(['read_file', 'edit_file', 'terminal', 'terminal'])).toEqual([
      { end: 0, kind: 'run', start: 0 },
      { index: 1, kind: 'card' },
      { end: 3, kind: 'run', start: 2 }
    ])
  })

  it('breaks a run at every card, so two edits do not fuse the reads around them', () => {
    expect(splitRunItems(['edit_file', 'edit_file'])).toEqual([
      { index: 0, kind: 'card' },
      { index: 1, kind: 'card' }
    ])
  })

  it('passes a non-tool part through as its own card', () => {
    expect(splitRunItems(['read_file', '', 'read_file'])).toEqual([
      { end: 0, kind: 'run', start: 0 },
      { index: 1, kind: 'card' },
      { end: 2, kind: 'run', start: 2 }
    ])
  })

  it('is empty for an empty range', () => {
    expect(splitRunItems([])).toEqual([])
  })

  // The run is identified by its FIRST call, so a live stream (many small
  // ranges) and the same turn rehydrated (one big range) agree on which calls
  // belong together even though the indices differ.
  it('yields the same run shape however the range is offset', () => {
    const names = ['read_file', 'terminal', 'read_file']

    expect(splitRunItems(names)).toEqual([{ end: 2, kind: 'run', start: 0 }])
    expect(splitRunItems(names).map(item => (item.kind === 'run' ? item.end - item.start : -1))).toEqual([2])
  })
})

describe('summarizeToolRun', () => {
  it('names the single thing a lone-category run acted on', () => {
    expect(summarizeToolRun([call('read_file', { path: '/src/wiring.tsx' })], false)).toBe('Explored wiring.tsx')
  })

  it('counts once a category holds more than one call', () => {
    expect(summarizeToolRun([call('read_file'), call('read_file'), call('read_file')], false)).toBe('Explored 3 files')
  })

  // "ran 5 commands" is the useful settled reading; a command line only earns
  // its space while it is the thing you are waiting on.
  it('counts a settled command run rather than quoting it', () => {
    expect(summarizeToolRun([call('terminal', { command: 'npm test' })], false)).toBe('Ran 1 command')
  })

  it('quotes the command while it is the live one', () => {
    expect(summarizeToolRun([call('terminal', { command: 'npm test' }, false)], true)).toBe('Running npm test')
  })

  it('joins categories in a fixed clause order, lowercasing after the first', () => {
    expect(summarizeToolRun([call('terminal'), call('terminal'), call('read_file'), call('read_file')], false)).toBe(
      'Explored 2 files, ran 2 commands'
    )
  })

  it('narrates only the category holding the outstanding call', () => {
    const summary = summarizeToolRun([call('read_file'), call('read_file'), call('terminal', {}, false)], true)

    expect(summary).toBe('Explored 2 files, running 1 command')
  })

  // A run with nothing pending is still live in the gap between one call
  // finishing and the next arriving; the most recent call narrates it.
  it('falls back to the most recent call when nothing is pending', () => {
    expect(summarizeToolRun([call('terminal'), call('read_file')], true)).toBe('Exploring 1 file, ran 1 command')
  })

  it('reads as finished when the caller says the run settled, pending calls or not', () => {
    expect(summarizeToolRun([call('terminal', {}, false)], false)).toBe('Ran 1 command')
  })

  it('is empty for an empty run', () => {
    expect(summarizeToolRun([], false)).toBe('')
  })
})

describe('toolPresentVerb', () => {
  it('describes a tool the same way the run summary does', () => {
    expect(toolPresentVerb('read_file')).toBe('Exploring')
    expect(toolPresentVerb('terminal')).toBe('Running')
    expect(toolPresentVerb('edit_file')).toBe('Editing')
    expect(toolPresentVerb('delegate_task')).toBe('Delegating')
    expect(toolPresentVerb('some_mcp_thing')).toBe('Using')
  })
})

describe('isToolCallPart', () => {
  it('keeps tool-call parts and drops everything else', () => {
    expect(isToolCallPart({ type: 'tool-call' })).toBe(true)
    expect(isToolCallPart({ type: 'text' })).toBe(false)
  })
})
