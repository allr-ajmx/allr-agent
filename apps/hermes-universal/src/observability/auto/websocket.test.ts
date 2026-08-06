import { describe, expect, it } from 'vitest'

import { frameLabel } from './websocket'

/**
 * `frameLabel` runs on EVERY inbound frame at stream rate, and whatever it
 * returns becomes a span attribute — so it has two jobs it must not fail at:
 * never throw, and never return anything but a method name. Frames carry
 * conversation text, prompts and tool output.
 */
describe('frameLabel', () => {
  it('reads a JSON-RPC method', () => {
    expect(frameLabel('{"jsonrpc":"2.0","method":"session.subscribe","id":1}')).toBe('session.subscribe')
  })

  it('falls back to params.type, which is how gateway events are shaped', () => {
    expect(frameLabel('{"params":{"type":"message.delta","text":"hello"}}')).toBe('message.delta')
  })

  it('returns undefined rather than guessing when there is no method', () => {
    // A mislabelled span is worse than an unlabelled one.
    expect(frameLabel('{"result":{"ok":true}}')).toBeUndefined()
  })

  it('never returns non-string method values', () => {
    expect(frameLabel('{"method":{"nested":"object"}}')).toBeUndefined()
    expect(frameLabel('{"method":42}')).toBeUndefined()
  })

  it('does not throw on malformed JSON', () => {
    expect(frameLabel('{"method":"x"')).toBeUndefined()
  })

  it('skips non-object payloads without parsing', () => {
    expect(frameLabel('plain text frame')).toBeUndefined()
    expect(frameLabel('')).toBeUndefined()
    expect(frameLabel(null)).toBeUndefined()
    expect(frameLabel(undefined)).toBeUndefined()
    expect(frameLabel(12345)).toBeUndefined()
  })

  it('does not leak message content', () => {
    const label = frameLabel('{"method":"message.delta","params":{"text":"SECRET USER TEXT"}}')

    expect(label).toBe('message.delta')
    expect(label).not.toContain('SECRET')
  })
})
