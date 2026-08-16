import { atom, computed } from '@/store/atom'
import { requestClose } from '@/store/close-confirm'
import { $dirtyPreviewPaths, setPreviewDirty } from '@/store/preview-edit'
import { forgetPreviewView } from '@/store/preview-view'

// The right-pane file viewer/editor's open-file state. Adapted (much simplified)
// from desktop's store/preview.ts: a VS Code-style set of file tabs + the active
// one. Desktop's target also modeled web/URL previews (Electron webview) and a
// per-session registry — dropped here; this is files only.

export interface PreviewTarget {
  /** Absolute file path — the tab id. An artifact tab uses the synthetic
   *  `artifact:<id>` form instead (see ARTIFACT_TAB_PREFIX). */
  path: string
  /** Basename, for the tab label. */
  name: string
}

/**
 * An artifact tab is addressed by REFERENCE, not by content.
 *
 * The registry owns the artifact and its versions; a tab only names one. That
 * is what lets an already-open tab pick up a new version the moment the model
 * regenerates the same artifact — the alternative, a tab holding a copy of the
 * HTML, would show the version it was opened at forever.
 */
export const ARTIFACT_TAB_PREFIX = 'artifact:'

export const isArtifactTab = (path: string): boolean => path.startsWith(ARTIFACT_TAB_PREFIX)

export const artifactIdFromTab = (path: string): string => path.slice(ARTIFACT_TAB_PREFIX.length)

// Live preview-server restart status (verbatim from desktop store/preview.ts).
// Universal doesn't drive preview-server restarts yet, but the ported activity
// rail (store/activity.ts) consumes this shape; callers pass null until wired.
export interface PreviewServerRestart {
  message?: string
  status: 'complete' | 'error' | 'running'
  taskId: string
  url: string
}

function baseName(path: string): string {
  const cleaned = path.replace(/[\\/]+$/, '')

  return cleaned.slice(cleaned.lastIndexOf('/') + 1) || cleaned
}

export const $previewTabs = atom<PreviewTarget[]>([])
export const $activePreviewPath = atom<string | null>(null)
/** Bumped to force the active file to re-read from disk (after a save). */
export const $previewReloadNonce = atom(0)

export const $activePreviewTarget = computed(
  [$previewTabs, $activePreviewPath],
  (tabs, active) => tabs.find(tab => tab.path === active) ?? null
)

export function setPreviewTarget(path: string): void {
  const tabs = $previewTabs.get()

  if (!tabs.some(tab => tab.path === path)) {
    $previewTabs.set([...tabs, { name: baseName(path), path }])
  }

  $activePreviewPath.set(path)
}

export function selectPreviewTab(path: string): void {
  if ($previewTabs.get().some(tab => tab.path === path)) {
    $activePreviewPath.set(path)
  }
}

// Opened from a composer attachment pill (ported from desktop, where it set a
// rich session-scoped preview target). Universal's preview model is tab-based,
// so this best-effort opens a tab for the target's path. The rich preview
// descriptor + source are accepted for import-site parity but not yet used.
// FLAG(chat-port).
export function setCurrentSessionPreviewTarget(
  preview: { target?: unknown } & Record<string, unknown>,
  _source: string,
  target: string
): void {
  const path = target || (typeof preview.target === 'string' ? preview.target : '')

  if (path) {
    setPreviewTarget(path)
  }
}

/** Open (or focus) a tab for an artifact, labelled by its title. */
export function openArtifactPreviewTab(artifactId: string, title: string): void {
  const path = `${ARTIFACT_TAB_PREFIX}${artifactId}`
  const tabs = $previewTabs.get()

  $previewTabs.set(
    tabs.some(tab => tab.path === path)
      ? tabs.map(tab => (tab.path === path ? { name: title || tab.name, path } : tab))
      : [...tabs, { name: title || 'Artifact', path }]
  )

  $activePreviewPath.set(path)
}

/**
 * Forget everything else keyed by a closed tab's path.
 *
 * The per-path maps (view mode, load capabilities, the unsaved-edits flag) are
 * keyed by path and nothing else prunes them, so a long-lived window otherwise
 * pins an entry for every file it ever opened — and a dirty flag left behind
 * keeps claiming unsaved work in a tab that is gone. Done HERE rather than in
 * the tile's closer because a tab has four doors out (the tile ✕ / ⌘W, the
 * close verbs, the rail's own strip, a gateway switch) and only one of them
 * went through the tile.
 */
function forgetPreviewPath(path: string): void {
  forgetPreviewView(path)
  setPreviewDirty(path, false)
}

/** Drop every artifact tab — the registry they reference is gone. */
export function closeArtifactPreviewTabs(): void {
  const remaining = $previewTabs.get().filter(tab => !isArtifactTab(tab.path))

  $previewTabs.get().forEach(tab => isArtifactTab(tab.path) && forgetPreviewPath(tab.path))
  $previewTabs.set(remaining)

  const active = $activePreviewPath.get()

  if (active && isArtifactTab(active)) {
    $activePreviewPath.set(remaining.length ? remaining[remaining.length - 1].path : null)
  }
}

export function requestPreviewReload(): void {
  $previewReloadNonce.set($previewReloadNonce.get() + 1)
}

function afterClose(remaining: PreviewTarget[], closed: string): void {
  $previewTabs.set(remaining)

  if ($activePreviewPath.get() === closed) {
    $activePreviewPath.set(remaining.length ? remaining[remaining.length - 1].path : null)
  }
}

export function closePreviewTab(path: string): void {
  forgetPreviewPath(path)
  afterClose(
    $previewTabs.get().filter(tab => tab.path !== path),
    path
  )
}

/**
 * Close a file tab the way a USER closes one — asking first when it is holding
 * edits that were never saved.
 *
 * The editor's buffer is component state (`preview-file.tsx`'s `draftRef`), so
 * closing the tab unmounts it and the typing is gone; `closePreviewTab` even
 * clears the dirty flag on the way out, so nothing was left to say work had been
 * lost. Every door out took that path — the rail's ✕, middle-click, ⌘-click, the
 * tab menu, the tile's closer under ⌘W, the composer's preview pill — which is
 * the same divergence MJXHRM-390 fixed for chats, in the other direction: a
 * busy CHAT asked, a dirty FILE never did.
 *
 * `closePreviewTab` stays the unconditional primitive: a gateway switch tears
 * these tabs down because they point at a machine we have stopped talking to,
 * and that teardown is not a question.
 */
export function requestClosePreviewTab(path: string): void {
  requestClose({ close: () => closePreviewTab(path), id: path, kind: 'file' }, $dirtyPreviewPaths.get().has(path))
}

/** "Close others" — the single close verb applied to each target, one at a
 *  time, so a dirty tab in the batch gets the prompt a lone dirty tab gets
 *  instead of being swept away with the clean ones. (It used to be its own
 *  batch rewrite of `$previewTabs`, i.e. a second implementation of closing.) */
export function requestCloseOtherPreviewTabs(path: string): void {
  $previewTabs
    .get()
    .filter(tab => tab.path !== path)
    .forEach(tab => requestClosePreviewTab(tab.path))
}

/**
 * Close every preview tab.
 *
 * Also the gateway-switch verb: a tab names an absolute path on the gateway's
 * filesystem, read and written over `/api/fs/*` (see hermes.ts), so after a
 * soft switch every open file tab points at a machine the app is no longer
 * talking to. Left open, the pane keeps showing the OLD backend's bytes while
 * the editor's save path reads and writes the NEW one — which either resurrects
 * a file that only existed over there or overwrites a same-named file that
 * happens to exist here.
 */
export function closeAllPreviewTabs(): void {
  $previewTabs.get().forEach(tab => forgetPreviewPath(tab.path))
  $previewTabs.set([])
  $activePreviewPath.set(null)
}

/** "Close all" from a MENU — one prompt per unsaved tab. (`closeAllPreviewTabs`
 *  itself stays unconditional; it is also the gateway-switch teardown.) */
export function requestCloseAllPreviewTabs(): void {
  $previewTabs.get().forEach(tab => requestClosePreviewTab(tab.path))
}

/** The fourth verb of the shared tab close group. The strip is ORDERED, so "to
 *  the right" means here exactly what it means on a pane strip — and, like the
 *  other three, it is the ONE close verb applied to each target rather than its
 *  own rewrite of the tab list. */
export function requestClosePreviewTabsToRight(path: string): void {
  const tabs = $previewTabs.get()
  const at = tabs.findIndex(tab => tab.path === path)

  if (at < 0) {
    return
  }

  tabs.slice(at + 1).forEach(tab => requestClosePreviewTab(tab.path))
}

/** How many tabs each close verb would hit — the rail's `PaneTabCloseCounts`. */
export function previewCloseTargets(path: string): { all: number; others: number; right: number } {
  const tabs = $previewTabs.get()
  const at = tabs.findIndex(tab => tab.path === path)

  return {
    all: tabs.length,
    others: at < 0 ? 0 : tabs.length - 1,
    right: at < 0 ? 0 : tabs.length - 1 - at
  }
}
