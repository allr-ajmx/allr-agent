import { describe, expect, it } from 'vitest'

import { addStoreNames } from './store-names'

/**
 * These are regression tests, not coverage. The first version of this transform
 * used a regex and shipped `atom(hasSavedTarget(, '$restoring') || …)` into
 * store/gateway-restore.ts — a parse error in a module the entire app imports,
 * which took out 30+ test files at once. Every case below is a shape that
 * actually appears in this codebase.
 */
describe('addStoreNames', () => {
  it('names a simple atom', () => {
    expect(addStoreNames(`export const $open = atom(false)`)).toBe(`export const $open = atom(false, '$open')`)
  })

  it('handles NESTED calls in the initial value', () => {
    // The exact shape that broke the regex version.
    const code = `export const $restoring = atom(hasSavedTarget() || hasPendingOAuth())`

    expect(addStoreNames(code)).toBe(`export const $restoring = atom(hasSavedTarget() || hasPendingOAuth(), '$restoring')`)
  })

  it('supplies a value when the call has no arguments', () => {
    // Otherwise the name lands in the value position and the store boots
    // holding its own label.
    expect(addStoreNames(`export const $x = atom()`)).toBe(`export const $x = atom(undefined, '$x')`)
  })

  it('ignores parens inside string arguments', () => {
    const code = `export const $sep = atom(')')`

    expect(addStoreNames(code)).toBe(`export const $sep = atom(')', '$sep')`)
  })

  it('carries a type annotation through', () => {
    const code = `export const $ids: WritableAtom<string[]> = atom([])`

    expect(addStoreNames(code)).toBe(`export const $ids: WritableAtom<string[]> = atom([], '$ids')`)
  })

  it('names every store in a module, not just the first', () => {
    const out = addStoreNames(`export const $a = atom(1)\nexport const $b = atom(2)\n`)

    expect(out).toContain(`atom(1, '$a')`)
    expect(out).toContain(`atom(2, '$b')`)
  })

  it('handles a multi-line object initial value', () => {
    const code = `export const $cfg = atom({\n  a: 1,\n  b: fn(2)\n})`

    expect(addStoreNames(code)).toBe(`export const $cfg = atom({\n  a: 1,\n  b: fn(2)\n}, '$cfg')`)
  })

  it('leaves non-exported and non-$ declarations alone', () => {
    // Narrow by design: rewriting a call the transform does not understand is a
    // syntax error, so anything unusual is left untouched and simply unnamed.
    expect(addStoreNames(`const local = atom(1)`)).toBeNull()
    expect(addStoreNames(`export const plain = atom(1)`)).toBeNull()
  })

  it('returns null when there is nothing to rewrite', () => {
    expect(addStoreNames(`export const x = 1`)).toBeNull()
  })

  it('names map() as well as atom()', () => {
    expect(addStoreNames(`export const $m = map({})`)).toBe(`export const $m = map({}, '$m')`)
  })
})
