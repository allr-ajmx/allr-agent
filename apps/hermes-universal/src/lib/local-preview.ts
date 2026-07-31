// STUB — desktop's local-preview resolves a path/URL into a rich preview target
// (local file read vs remote fs facade vs localhost dev server) for the preview
// pane. Universal's preview store is a leaner tab model, so this returns just the
// target descriptor; setCurrentSessionPreviewTarget (store/preview) opens the tab.
// FLAG(chat-port): no local byte-reading / dev-server detection yet.
//
// In particular it never produces the `.url` desktop's "open preview in browser"
// path consumes. The composer's PreviewStatusRow deliberately doesn't need one:
// it classifies the raw target itself (URL → system browser via openExternalLink,
// path → right-pane file tab), so no resolution step sits in between.

export interface LocalPreviewTarget {
  target: string
  dataUrl?: string
  previewKind?: 'image'
  [key: string]: unknown
}

export async function normalizeOrLocalPreviewTarget(target: string, _cwd?: string): Promise<LocalPreviewTarget | null> {
  const trimmed = target.trim()

  return trimmed ? { target: trimmed } : null
}
