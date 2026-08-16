import { describe, expect, it } from 'vitest'

import { isTerminalLinkActivation } from './links'

describe('isTerminalLinkActivation', () => {
  it('is ⌘-click on macOS and Ctrl-click elsewhere', () => {
    expect(isTerminalLinkActivation({ ctrlKey: false, metaKey: true }, true)).toBe(true)
    expect(isTerminalLinkActivation({ ctrlKey: true, metaKey: false }, false)).toBe(true)
  })

  it('ignores the other platform modifier', () => {
    expect(isTerminalLinkActivation({ ctrlKey: true, metaKey: false }, true)).toBe(false)
    expect(isTerminalLinkActivation({ ctrlKey: false, metaKey: true }, false)).toBe(false)
  })

  it('leaves a BARE click to the selection — a misclick on a URL opens nothing', () => {
    expect(isTerminalLinkActivation({ ctrlKey: false, metaKey: false }, true)).toBe(false)
    expect(isTerminalLinkActivation({ ctrlKey: false, metaKey: false }, false)).toBe(false)
  })
})
