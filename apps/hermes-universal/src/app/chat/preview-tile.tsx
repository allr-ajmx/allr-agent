/**
 * PREVIEW TILES — every open preview is a layout-tree pane, the preview analog
 * of session and route tiles.
 *
 * The preview used to be ONE pane holding its own tab strip: a second bar at a
 * different height from the zone's, with its own close menu and its own label
 * casing, welded next to the file tree and revealed by a visibility binding. It
 * predated the layout tree. Now `$previewTabs` mirrors into pane contributions
 * through the same `paneMirror` the other tiles use, so a preview tab IS a zone
 * tab — same strip, same drag / stack / split, same ✕, same right-click close
 * verbs, and one bar instead of two.
 *
 * The rail component survives for the shells that have no layout tree (the phone
 * Workspace's Editor tab and the narrow AppShell drawer); nothing in the tree
 * path goes through it.
 */

import { ArtifactPreview } from '@/app/right-pane/preview/preview-artifact'
import { PreviewFile } from '@/app/right-pane/preview/preview-file'
import { previewStripTools } from '@/app/right-pane/preview/preview-strip-tools'
import { findGroup } from '@/components/pane-shell/tree/model'
import { $activeTreeGroup, $layoutTree, removeTreePane, revealTreePane } from '@/components/pane-shell/tree/store'
import { useStore } from '@/store/atom'
import {
  $activePreviewPath,
  $previewTabs,
  closePreviewTab,
  isArtifactTab,
  type PreviewTarget,
  selectPreviewTab
} from '@/store/preview'
import { forgetPreviewView } from '@/store/preview-view'

import { paneMirror } from './pane-mirror'

const PREVIEW_TILE_PREFIX = 'preview-tile'

const previewTilePaneId = (path: string) => `${PREVIEW_TILE_PREFIX}:${path}`

/** The pane id the SINGLETON preview rail used to occupy. A tree persisted by an
 *  older build still carries it, and nothing registers it any more, so it would
 *  sit in the layout forever as an invisible leaf. */
const LEGACY_PREVIEW_PANE_ID = 'preview'

/** The target behind a tile id, or null once its tab is gone. */
function targetFor(path: string): PreviewTarget | null {
  return $previewTabs.get().find(tab => tab.path === path) ?? null
}

/** Tab label — the file's basename, which is what `$previewTabs` already
 *  carries. Falls back to the path so a tab mid-close still names something. */
function previewTitle(path: string): string {
  return targetFor(path)?.name ?? path
}

/** One preview, as a layout-tree pane. The tab — its label, close verbs,
 *  drag/stack/split — belongs to the ZONE, and the view-mode switch to the
 *  zone's strip, so this renders only the body. */
function PreviewTilePane({ path }: { path: string }) {
  const target = useStore($previewTabs).find(tab => tab.path === path)

  // The tab closed while this pane was still mounted (the mirror disposes it a
  // tick later).
  if (!target) {
    return null
  }

  // An artifact tab names a registry entry rather than a file on disk.
  if (isArtifactTab(target.path)) {
    return <ArtifactPreview target={target} />
  }

  return <PreviewFile target={target} variant="tile" />
}

/** Keep pane contributions mirroring `$previewTabs`, keep the store's selection
 *  and the tree's active pane agreeing, and front a tile when its tab is
 *  selected. Call once from the root. */
export function watchPreviewTiles(): void {
  removeTreePane(LEGACY_PREVIEW_PANE_ID)
  watchPreviewTileMirror()

  // The reveal analog of session tiles: opening a preview selects its path, and
  // the TREE must front its pane — un-minimize, un-hide, activate in its zone.
  // Both stores, because re-opening the already-active tab changes only
  // `$previewTabs` while switching tabs changes only the active path.
  const reveal = () => {
    const path = $activePreviewPath.get()

    if (path && targetFor(path)) {
      revealTreePane(previewTilePaneId(path))
    }
  }

  $activePreviewPath.listen(reveal)
  $previewTabs.listen(reveal)

  // And the reverse: clicking a preview TAB activates its pane in the TREE
  // only, so the store's selection must follow or `$activePreviewTarget` (which
  // the rail shells and the composer's preview row read) keeps reporting the
  // previous tab. Same derivation the focused session uses: the interacted
  // zone's active pane names the tab. Converges with `reveal` — re-selecting the
  // path the tree already fronts is a no-op in both directions.
  const follow = () => {
    const tree = $layoutTree.get()
    const groupId = $activeTreeGroup.get()
    const active = groupId && tree ? findGroup(tree, groupId)?.active : undefined

    if (!active?.startsWith(`${PREVIEW_TILE_PREFIX}:`)) {
      return
    }

    const path = active.slice(PREVIEW_TILE_PREFIX.length + 1)

    if (targetFor(path) && $activePreviewPath.get() !== path) {
      selectPreviewTab(path)
    }
  }

  $layoutTree.listen(follow)
  $activeTreeGroup.listen(follow)
}

const watchPreviewTileMirror = paneMirror<PreviewTarget>({
  source: $previewTabs,
  key: tab => tab.path,
  kind: 'preview',
  prefix: PREVIEW_TILE_PREFIX,
  // Identical to route (page) tiles: its own zone docked beside main, sized by
  // the split weights. NOT anchored to the file tree — the old rail was a
  // files-adjacent strip, and carrying that over welded the preview into the
  // file browser's zone, so hiding the file tree took the preview with it.
  dir: () => 'right',
  minWidth: '22rem',
  title: previewTitle,
  stripTools: previewStripTools,
  render: path => <PreviewTilePane path={path} />,
  close: path => {
    forgetPreviewView(path)
    closePreviewTab(path)
  }
})
