/**
 * THE LAZY BOUNDARY around the diff renderer's Shiki path.
 *
 * `useShikiHighlighter` is a hook, so unlike `codeToTokens` it cannot be moved
 * behind a dynamic `import()` at its call site — the only way to keep it out of
 * the entry chunk is to give it a module of its own and `lazy()` that
 * (MJXHRM-380). `diff-lines.tsx` is reached statically from
 * `assistant-ui/tool/fallback.tsx`, i.e. from the transcript, so without this
 * split the engine ships with the app however the code-fence highlighter is
 * loaded.
 *
 * Everything this needs arrives as PROPS — the transformer list and the
 * pre-Shiki fallback both. That is deliberate: importing them from
 * `diff-lines.tsx` would make the lazy chunk import its own parent, and a cycle
 * across a `lazy()` boundary is the kind of thing that works in dev and fails
 * once rolldown reorders the chunks.
 */
import type { ReactNode } from 'react'
import { useShikiHighlighter } from 'react-shiki'
import type { ShikiTransformer } from 'shiki'

import { SHIKI_THEME } from '@/components/chat/shiki-theme'

const SyntaxDiff = ({
  code,
  fallback,
  language,
  transformers
}: {
  code: string
  /** The colour-only diff, shown until Shiki resolves so there is no flash. */
  fallback: ReactNode
  language: string
  transformers: ShikiTransformer[]
}) => {
  const highlighted = useShikiHighlighter(code, language, SHIKI_THEME, {
    defaultColor: 'light-dark()',
    transformers
  })

  return (highlighted as ReactNode) ?? fallback
}

export default SyntaxDiff
