/**
 * Every symbol the sample plugins import from `@hermes/plugin-sdk` must actually
 * be on the SDK's export surface.
 *
 * This is the guard the hardcoded allowlist in alias.test.ts can't be: it reads
 * the real sample sources and fails on whatever they actually import, so a
 * symbol added to a sample without a matching export is caught here rather than
 * at plugin-load time.
 *
 * The failure it exists to prevent is total, not partial. `shimUrl`
 * (runtime.ts) builds the runtime shim's named exports from `Object.keys()` of
 * this namespace, so a missing symbol is simply absent from the blob and the
 * plugin's very first `import` throws — it never reaches `register()`, and it
 * lands in the inventory as an error row. That is how kanban failed with
 * `compactNumber not found`.
 *
 * Only VALUE imports are checked here — type-only bindings erase before the
 * namespace exists, so a runtime assertion can't see them. They aren't
 * unguarded: both apps include this directory in `tsconfig.json`, so a missing
 * type is a typecheck failure instead (that is how the missing `ctx.onDispose`
 * surfaced when the samples first compiled here).
 */

import { describe, expect, it } from 'vitest'

import * as sdk from './index'

// Raw sources, not modules: this must see what the files import, and importing
// them would only prove they resolve today.
const sources = import.meta.glob('../../../../packages/hermes-sample-plugins/*/*.{ts,tsx}', {
  eager: true,
  query: '?raw',
  import: 'default'
}) as Record<string, string>

/** Value bindings pulled from '@hermes/plugin-sdk', local alias stripped. */
function sdkValueImports(source: string): string[] {
  const names: string[] = []

  // `import type { … }` is skipped wholesale; inline `type Foo` is skipped
  // clause by clause. What's left is what the shim actually has to carry.
  for (const match of source.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s*from\s*['"]@hermes\/plugin-sdk['"]/g)) {
    if (match[1]) {
      continue
    }

    for (const clause of match[2].split(',')) {
      const binding = clause.trim()

      if (!binding || /^type\s/.test(binding)) {
        continue
      }

      // `Foo as Bar` — the SDK has to export `Foo`, the left side.
      names.push(binding.split(/\s+as\s+/)[0].trim())
    }
  }

  return names
}

describe('sample plugins against the SDK surface', () => {
  it('finds the sample sources at all', () => {
    // A glob that silently matches nothing would make every assertion below
    // vacuously pass — the exact way this kind of test rots.
    expect(Object.keys(sources).length).toBeGreaterThan(0)
    expect(Object.keys(sources).some(path => path.includes('/kanban/'))).toBe(true)
  })

  it.each(Object.entries(sources))('%s imports only values the SDK exports', (_path, source) => {
    const missing = sdkValueImports(source).filter(name => !(name in sdk))

    expect(missing).toEqual([])
  })
})
