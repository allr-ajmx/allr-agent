import { describe, expect, it } from 'vitest'

import { terminalClipboardIntent } from './clipboard'

const keydown = (init: KeyboardEventInit & { key: string }) => new KeyboardEvent('keydown', init)

describe('terminalClipboardIntent — macOS', () => {
  const mac = (hasSelection: boolean) => ({ hasSelection, isMac: true })

  it('⌘C copies a selection and falls through without one', () => {
    expect(terminalClipboardIntent(keydown({ key: 'c', metaKey: true }), mac(true))).toBe('copy')
    // ⌘ isn't a terminal modifier, so with nothing selected this is a no-op in
    // the shell rather than a keystroke we swallowed.
    expect(terminalClipboardIntent(keydown({ key: 'c', metaKey: true }), mac(false))).toBeNull()
  })

  it('⌘V pastes regardless of selection', () => {
    expect(terminalClipboardIntent(keydown({ key: 'v', metaKey: true }), mac(false))).toBe('paste')
  })

  it('leaves bare Ctrl+C as SIGINT', () => {
    expect(terminalClipboardIntent(keydown({ key: 'c', ctrlKey: true }), mac(true))).toBeNull()
  })
})

describe('terminalClipboardIntent — Windows/Linux', () => {
  const pc = (hasSelection: boolean) => ({ hasSelection, isMac: false })

  it('Ctrl+Shift+C/V are the explicit chords', () => {
    expect(terminalClipboardIntent(keydown({ ctrlKey: true, key: 'c', shiftKey: true }), pc(true))).toBe('copy')
    expect(terminalClipboardIntent(keydown({ ctrlKey: true, key: 'v', shiftKey: true }), pc(false))).toBe('paste')
  })

  it('bare Ctrl+C copies ONLY with a selection — otherwise it stays SIGINT', () => {
    expect(terminalClipboardIntent(keydown({ ctrlKey: true, key: 'c' }), pc(true))).toBe('copy')
    expect(terminalClipboardIntent(keydown({ ctrlKey: true, key: 'c' }), pc(false))).toBeNull()
  })

  it('never claims ⌘ chords off-Mac', () => {
    expect(terminalClipboardIntent(keydown({ key: 'c', metaKey: true }), pc(true))).toBeNull()
  })
})

describe('terminalClipboardIntent — guards', () => {
  it('ignores keyup and anything with Alt held', () => {
    expect(
      terminalClipboardIntent(new KeyboardEvent('keyup', { key: 'c', metaKey: true }), {
        hasSelection: true,
        isMac: true
      })
    ).toBeNull()
    expect(
      terminalClipboardIntent(keydown({ altKey: true, key: 'c', metaKey: true }), { hasSelection: true, isMac: true })
    ).toBeNull()
  })
})
