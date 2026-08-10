import { atom, computed } from '@/store/atom'

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

/** Drop every artifact tab — the registry they reference is gone. */
export function closeArtifactPreviewTabs(): void {
  const remaining = $previewTabs.get().filter(tab => !isArtifactTab(tab.path))
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
  afterClose(
    $previewTabs.get().filter(tab => tab.path !== path),
    path
  )
}

export function closeOtherPreviewTabs(path: string): void {
  const keep = $previewTabs.get().filter(tab => tab.path === path)
  $previewTabs.set(keep)
  $activePreviewPath.set(keep.length ? path : null)
}

export function closeAllPreviewTabs(): void {
  $previewTabs.set([])
  $activePreviewPath.set(null)
}

/** The fourth verb of the shared tab close group. The strip is ORDERED, so
 *  "to the right" means here exactly what it means on a pane strip — the rail
 *  simply never wired it, even though its label has been sitting in the
 *  translations unused. */
export function closePreviewTabsToRight(path: string): void {
  const tabs = $previewTabs.get()
  const at = tabs.findIndex(tab => tab.path === path)

  if (at < 0 || at === tabs.length - 1) {
    return
  }

  const keep = tabs.slice(0, at + 1)
  $previewTabs.set(keep)

  const active = $activePreviewPath.get()

  if (active && !keep.some(tab => tab.path === active)) {
    $activePreviewPath.set(path)
  }
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
