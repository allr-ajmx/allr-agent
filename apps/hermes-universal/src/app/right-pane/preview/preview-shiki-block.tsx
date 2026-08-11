/**
 * The preview pane's lazy boundary around Shiki (MJXHRM-380).
 *
 * The file viewer resolves its own theme name (a single string, not the
 * transcript's `light-dark()` pair) because it repaints on the app's resolved
 * mode rather than the document's `color-scheme` — so it cannot share
 * `components/chat/shiki-block.tsx` and gets its own thin wrapper instead.
 */
import type { FC } from 'react'
import ShikiHighlighter from 'react-shiki'

const PreviewShikiBlock: FC<{ children: string; language: string; theme: string }> = ({
  children,
  language,
  theme
}) => (
  <ShikiHighlighter language={language} showLanguage={false} theme={theme}>
    {children}
  </ShikiHighlighter>
)

export default PreviewShikiBlock
