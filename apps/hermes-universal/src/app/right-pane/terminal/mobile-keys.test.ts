import { describe, expect, it } from 'vitest'

import { applyTerminalModifiers, nextModifierState, type TerminalModifiers } from './mobile-keys'

// The sticky-modifier encoding. It's the part of the key row that can silently
// send the wrong bytes to a live shell, so it's tested rather than eyeballed.

const off: TerminalModifiers = { alt: 'off', ctrl: 'off' }

describe('applyTerminalModifiers', () => {
  it('passes plain input through untouched', () => {
    expect(applyTerminalModifiers('ls', off)).toBe('ls')
  })

  it('maps a Ctrl-ed letter to its control code, in either case', () => {
    expect(applyTerminalModifiers('c', { ...off, ctrl: 'armed' })).toBe('\u0003')
    expect(applyTerminalModifiers('C', { ...off, ctrl: 'locked' })).toBe('\u0003')
    expect(applyTerminalModifiers('d', { ...off, ctrl: 'armed' })).toBe('\u0004')
  })

  it('maps Ctrl-? to DEL', () => {
    expect(applyTerminalModifiers('?', { ...off, ctrl: 'armed' })).toBe('\u007f')
  })

  it('leaves input Ctrl has no meaning for alone rather than mangling it', () => {
    // Multi-char (a paste, or an escape sequence from the row) and digits.
    expect(applyTerminalModifiers('echo', { ...off, ctrl: 'armed' })).toBe('echo')
    expect(applyTerminalModifiers('1', { ...off, ctrl: 'armed' })).toBe('1')
  })

  it('prefixes ESC for Alt (the meta encoding)', () => {
    expect(applyTerminalModifiers('b', { ...off, alt: 'armed' })).toBe('\u001bb')
  })

  it('composes Ctrl and Alt', () => {
    expect(applyTerminalModifiers('c', { alt: 'armed', ctrl: 'armed' })).toBe('\u001b\u0003')
  })
})

describe('nextModifierState', () => {
  it('cycles off → armed → locked → off', () => {
    expect(nextModifierState('off')).toBe('armed')
    expect(nextModifierState('armed')).toBe('locked')
    expect(nextModifierState('locked')).toBe('off')
  })
})
