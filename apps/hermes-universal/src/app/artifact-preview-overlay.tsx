import { OverlayView } from '@/app/overlays/overlay-view'
import { ArtifactPreview } from '@/app/right-pane/preview/preview-artifact'
import { useI18n } from '@/i18n'
import { useStore } from '@/store/atom'
import { $activePreviewTarget, isArtifactTab, requestClosePreviewTab } from '@/store/preview'

/**
 * Mount point for an artifact preview in a window that has NO preview surface.
 *
 * Opening an artifact is a store write (`openArtifact` → a tab in
 * `$previewTabs`), and every shell that can show one reads that store: the
 * layout tree mirrors it into a tile, the phone Workspace and the narrow
 * AppShell drawer render `PreviewRail`. A detached chat window (`ChatTileHost`)
 * has none of the three — it is one chat and its titlebar — and yet it renders
 * the full transcript, artifact cards included. So the card was there, its
 * "Open" was there, and the click wrote a tab into a store nothing in that
 * window reads: a dead affordance, the same shape as the model picker's dead
 * ⌘⇧M before MJXHRM-54 mounted its dialog here.
 *
 * A window-filling overlay rather than a pane, because a satellite chat window
 * has no pane geometry to dock into and no strip to hang a tab off. Closing it
 * closes the tab, so re-opening the card opens it again rather than finding a
 * tab that is already "active" and doing nothing visible.
 *
 * Scoped to ARTIFACT tabs on purpose. A file tab in this window would want the
 * editor, its dirty state and its save path — a different surface with a
 * different lifecycle, and nothing in a satellite window opens one today.
 */
export function ArtifactPreviewOverlay() {
  const { t } = useI18n()
  const target = useStore($activePreviewTarget)

  if (!target || !isArtifactTab(target.path)) {
    return null
  }

  return (
    <OverlayView
      closeLabel={t.preview.closeTab(target.name)}
      // Clear the card's own titlebar strip: the preview's header row carries
      // the version stepper, copy and download on its right edge, exactly where
      // the overlay's ✕ floats.
      contentClassName="overflow-hidden pt-[calc(var(--titlebar-height)+0.1875rem)]"
      onClose={() => requestClosePreviewTab(target.path)}
    >
      <ArtifactPreview key={target.path} target={target} />
    </OverlayView>
  )
}
