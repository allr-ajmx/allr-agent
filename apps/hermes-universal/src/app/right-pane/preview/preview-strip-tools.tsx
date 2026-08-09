/**
 * Per-preview strip tools — the source / rendered / diff switch.
 *
 * These were buttons in the preview's own toolbar, a second bar under the tab
 * that named the same file. Now that a preview is a layout-tree tile they are
 * strip glyphs, contributed as `PaneStripTool` DATA — the zone strip renders
 * them with `PaneStripGlyph`, the same button the `+` is, so there is no
 * preview-owned styling to drift from the rest of the app.
 *
 * `active` is driven by the real view state (`store/preview-view`), not by a
 * click-handler assumption, and `disabled` by what the pane actually managed to
 * load — an image or a binary offers no source view, a `.ts` file no rendered
 * one. The strip reads these during ITS render, so both stores nudge it.
 *
 * Universal has no in-app browser (the app CSP is `default-src 'self'`, so a
 * frame cannot load a remote page), hence none of desktop's console / DevTools
 * glyphs. When that lands, its handles register here the same way.
 */

import { invalidateStripTools } from '@/components/pane-shell/tree/store'
import { Codicon } from '@/components/ui/codicon'
import type { PaneStripTool } from '@/components/ui/pane-tab'
import { translateNow } from '@/i18n'
import { $previewCaps, $previewModes, previewCaps, previewMode, setPreviewMode } from '@/store/preview-view'

// The glyphs are read during the strip's render, so a mode flip or a finished
// load has to tell it to read again. Module-level: one subscription for the
// whole app, not one per open preview.
$previewModes.listen(() => invalidateStripTools())
$previewCaps.listen(() => invalidateStripTools())

/** The view-mode switch for one preview, as strip-tool DATA. */
export function previewStripTools(path: string): readonly PaneStripTool[] {
  const caps = previewCaps(path)
  const mode = previewMode(path)

  return [
    {
      active: mode === 'source',
      disabled: !caps?.source,
      icon: <Codicon name="code" size="0.8125rem" />,
      id: 'preview-source',
      label: translateNow('preview.source'),
      onSelect: () => setPreviewMode(path, 'source')
    },
    {
      active: mode === 'rendered',
      disabled: !caps?.rendered,
      icon: <Codicon name="book" size="0.8125rem" />,
      id: 'preview-rendered',
      label: translateNow('preview.renderedPreview'),
      onSelect: () => setPreviewMode(path, 'rendered')
    },
    {
      active: mode === 'diff',
      // A diff is a git question, not a content one — it stands even for a file
      // the viewer can't render, so it needs no capability behind it.
      icon: <Codicon name="git-compare" size="0.8125rem" />,
      id: 'preview-diff',
      label: translateNow('preview.diff'),
      onSelect: () => setPreviewMode(path, 'diff')
    }
  ]
}
