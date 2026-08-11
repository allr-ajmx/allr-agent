import { describe, expect, it } from 'vitest'

import { bytesToBase64 } from './http'

describe('bytesToBase64', () => {
  it('round-trips through atob', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]).buffer

    expect(atob(bytesToBase64(bytes))).toBe(String.fromCharCode(0, 1, 2, 250, 255))
  })

  // `String.fromCharCode(...view)` blows the argument limit here and throws,
  // which is why the encoder chunks.
  it('encodes a payload past the spread-argument limit', () => {
    const big = new Uint8Array(300_000).fill(7)

    expect(bytesToBase64(big.buffer)).toBe(btoa(String.fromCharCode(7).repeat(300_000)))
  })

  it('encodes nothing as the empty string', () => {
    expect(bytesToBase64(new Uint8Array(0).buffer)).toBe('')
  })
})
