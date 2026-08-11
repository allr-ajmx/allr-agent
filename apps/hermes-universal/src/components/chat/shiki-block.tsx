/**
 * THE LAZY BOUNDARY around Shiki.
 *
 * This module exists to be the only thing that imports `react-shiki`, so that
 * one `lazy(() => import('./shiki-block'))` in `shiki-highlighter.tsx` splits
 * the whole highlighter — the engine, the WASM regex layer and every entry of
 * `bundledLanguages` — out of the renderer's entry chunk. Desktop draws the
 * boundary the same way and for the same reason.
 *
 * Keep it minimal on purpose. Anything added here is code that a chat with no
 * code fence in it pays for, and the card chrome (copy button, expandable body,
 * budget fallback) deliberately stays on the eager side so a fence still paints
 * its slab immediately while this chunk is in flight.
 */
import type { FC, ReactNode } from 'react'
import ShikiHighlighter from 'react-shiki'

import { SHIKI_COLOR_REPLACEMENTS, SHIKI_THEME } from '@/components/chat/shiki-theme'

/**
 * `react-shiki` is a default export, and `React.lazy` requires a module whose
 * default export is a component — so this file re-exports it wrapped rather than
 * re-exporting it directly. Wrapping also keeps the highlighter's option set
 * (theme, colour replacements, `light-dark()` switching) on this side of the
 * boundary, where it belongs: none of it is meaningful until the engine loads.
 */
const ShikiBlock: FC<{ children: string; language: string }> = ({ children, language }) => (
  <ShikiHighlighter
    addDefaultStyles={false}
    as="div"
    colorReplacements={SHIKI_COLOR_REPLACEMENTS}
    defaultColor="light-dark()"
    delay={120}
    language={language}
    showLanguage={false}
    theme={SHIKI_THEME}
  >
    {children}
  </ShikiHighlighter>
)

export default ShikiBlock

export type ShikiBlockChildren = ReactNode
