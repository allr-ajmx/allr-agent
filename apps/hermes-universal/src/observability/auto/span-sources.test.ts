import { describe, expect, it } from 'vitest'

import { addSpanSources, sourceNameFor } from './span-sources'

/**
 * Regression tests, in the same spirit as `store-names.test.ts`: this transform
 * edits source text in modules the whole app imports, so every case below is a
 * shape that actually appears in this codebase, and the ones about what it
 * MUST NOT touch matter more than the ones about what it rewrites.
 */
const ID = '/Users/x/apps/hermes-universal/src/components/chat/code-fence.tsx'

describe('sourceNameFor', () => {
  it('is repo-relative with src/ stripped', () => {
    expect(sourceNameFor(ID)).toBe('components/chat/code-fence.tsx')
  })

  it('drops a vite query suffix', () => {
    expect(sourceNameFor(`${ID}?t=1730000000`)).toBe('components/chat/code-fence.tsx')
  })
})

describe('addSpanSources', () => {
  it('binds the helpers a module actually imports', () => {
    const code = `import { isRecording, recordSpan } from '@/observability'`

    expect(addSpanSources(code, ID)).toBe(
      `import { isRecording, withSource as __withSource } from '@/observability';` +
        ` const { recordSpan } = __withSource('components/chat/code-fence.tsx')`
    )
  })

  it('rewrites the sibling reach used inside auto/', () => {
    const id = '/Users/x/apps/hermes-universal/src/observability/auto/events.ts'

    expect(addSpanSources(`import { recordSpan } from '../span'`, id)).toBe(
      `import { withSource as __withSource } from '../span';` +
        ` const { recordSpan } = __withSource('observability/auto/events.ts')`
    )
  })

  it('leaves a module that imports no span helper alone', () => {
    // `isRecording` is not a span-raising call — there is nothing to attribute.
    expect(addSpanSources(`import { isRecording } from '@/observability'`, ID)).toBeNull()
  })

  it('leaves a type-only import alone', () => {
    // Rewriting it would emit a runtime const destructuring a type.
    expect(addSpanSources(`import type { SpanAttrs } from '@/observability'`, ID)).toBeNull()
  })

  it('leaves a re-export alone', () => {
    // index.ts is `export { … } from './span'` — not an import, and rewriting it
    // would break the public surface every other module reads.
    expect(addSpanSources(`export { recordSpan, span } from './span'`, ID)).toBeNull()
  })

  it('leaves a MULTI-LINE import alone', () => {
    // Collapsing it to one line would shift every line number below it, and the
    // plugin claims `map: null` on the promise that it never does.
    const code = `import {\n  recordSpan,\n  span\n} from '@/observability'`

    expect(addSpanSources(code, ID)).toBeNull()
  })

  it('is idempotent', () => {
    const code = `import { isRecording, recordSpan } from '@/observability'`
    const once = addSpanSources(code, ID)

    expect(addSpanSources(once as string, ID)).toBeNull()
  })

  it('returns null when the file has nothing to do with observability', () => {
    expect(addSpanSources(`import { useState } from 'react'`, ID)).toBeNull()
  })
})
