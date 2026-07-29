import { describe, expect, it } from 'vitest'

import { resolveIntroCopy } from './intro-copy'

describe('resolveIntroCopy', () => {
  it('rotates through a personality set as the seed advances', () => {
    const bodies = new Set(Array.from({ length: 5 }, (_, seed) => resolveIntroCopy('', seed).body))

    // intro-copy.jsonl carries 5 lines per personality — all distinct.
    expect(bodies.size).toBe(5)
    // And it wraps rather than falling off the end.
    expect(resolveIntroCopy('', 5).body).toBe(resolveIntroCopy('', 0).body)
  })

  it('draws from the configured personality, and treats the neutral values as none', () => {
    expect(resolveIntroCopy('pirate', 0).body).not.toBe(resolveIntroCopy('', 0).body)
    expect(resolveIntroCopy('none', 2).body).toBe(resolveIntroCopy('', 2).body)
    expect(resolveIntroCopy('default', 2).body).toBe(resolveIntroCopy('', 2).body)
  })

  it('gives an unknown personality its own voice-aware copy instead of the neutral set', () => {
    const copy = resolveIntroCopy('space_pirate', 0)

    expect(copy.headline).toContain('Space Pirate')
    expect(copy.body).not.toBe(resolveIntroCopy('', 0).body)
  })
})
