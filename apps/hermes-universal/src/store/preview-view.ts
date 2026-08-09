import { atom } from '@/store/atom'

/**
 * How each open preview is being VIEWED — source, rendered markdown, or diff.
 *
 * This used to be `useState` inside `PreviewFile`, which was fine while the
 * preview owned its own toolbar. Now that a preview is a layout-tree tile, the
 * switch belongs on the zone's tab strip (`preview-strip-tools.tsx`) — and a
 * strip glyph cannot reach into the pane's local state. Keyed by path, like
 * every other per-preview map, so the mode survives a tab round-trip the same
 * way the dirty flag does.
 */

export type PreviewViewMode = 'diff' | 'rendered' | 'source'

/** What a LOADED file can actually be shown as. Registered by the pane once it
 *  has read the file, so the strip offers only modes that exist: an image has
 *  no source view, a non-markdown file has no rendered one. Absent until the
 *  read lands, which is what leaves the glyphs disabled while it's in flight. */
export interface PreviewViewCaps {
  rendered: boolean
  source: boolean
}

export const $previewModes = atom<Readonly<Record<string, PreviewViewMode>>>({})
export const $previewCaps = atom<Readonly<Record<string, PreviewViewCaps>>>({})

export function previewMode(path: string): PreviewViewMode {
  return $previewModes.get()[path] ?? 'source'
}

export function setPreviewMode(path: string, mode: PreviewViewMode): void {
  if (previewMode(path) !== mode) {
    $previewModes.set({ ...$previewModes.get(), [path]: mode })
  }
}

export function previewCaps(path: string): PreviewViewCaps | undefined {
  return $previewCaps.get()[path]
}

export function setPreviewCaps(path: string, caps: PreviewViewCaps): void {
  const current = previewCaps(path)

  if (current?.rendered !== caps.rendered || current?.source !== caps.source) {
    $previewCaps.set({ ...$previewCaps.get(), [path]: caps })
  }
}

/** Drop a closed preview's view state so a long-lived window doesn't pin every
 *  file it ever opened. */
export function forgetPreviewView(path: string): void {
  const modes = $previewModes.get()
  const caps = $previewCaps.get()

  if (path in modes) {
    const { [path]: _mode, ...rest } = modes
    $previewModes.set(rest)
  }

  if (path in caps) {
    const { [path]: _caps, ...rest } = caps
    $previewCaps.set(rest)
  }
}
