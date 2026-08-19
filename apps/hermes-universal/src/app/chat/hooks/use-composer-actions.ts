// Minimal port of the pure DataTransfer helpers from desktop's
// app/chat/hooks/use-composer-actions.ts. The desktop file's full
// `useComposerActions` hook is Electron-coupled (window.hermesDesktop file IO);
// universal handles OS file drops via Tauri's onDragDropEvent (app/chat/
// use-file-drop.ts), so only these DataTransfer parsers are needed by the
// composer's inline-refs / drop hooks.

const IMAGE_EXTENSION_PATTERN = /\.(png|jpe?g|gif|webp|bmp|tiff?|svg|ico)$/i

export function isImagePath(filePath: string): boolean {
  return IMAGE_EXTENSION_PATTERN.test(filePath)
}

export interface DroppedFile {
  /** Browser-native File handle. Absent for in-app drags (e.g. project tree). */
  file?: File
  /** Absolute filesystem path. Empty when an OS drop didn't carry one. */
  path: string
  /** True if the entry is a directory. */
  isDirectory?: boolean
  /** First line number for in-app line-ref drags (source view gutter). */
  line?: number
  /** Last line number for line-range drags (`line..lineEnd` inclusive). */
  lineEnd?: number
}

/** MIME emitted by in-app drag sources (project tree, gutter line numbers).
 *  Payload is JSON `{ path; isDirectory?; line?; lineEnd? }[]`. */
export const ALLR_PATHS_MIME = 'application/x-hermes-paths'

/**
 * Resolve files from a drop event into DroppedFile entries. Internal Allr
 * sources (project tree) ride on a custom MIME and produce path-only entries; OS
 * drops produce File-bearing entries. On Tauri/WebKitGTK a browser drop carries
 * no filesystem path (Tauri routes real OS drops through onDragDropEvent), so
 * native entries here are File-only (path empty).
 *
 * Must be called synchronously inside the drop handler — DataTransfer items
 * detach as soon as the handler returns.
 */
export function extractDroppedFiles(transfer: DataTransfer): DroppedFile[] {
  const result: DroppedFile[] = []
  const seenPaths = new Set<string>()
  const seenFiles = new Set<File>()

  // In-app drags first — richer metadata (isDirectory) than the File fallback.
  try {
    const internalRaw = transfer.getData(ALLR_PATHS_MIME)

    if (internalRaw) {
      const parsed = JSON.parse(internalRaw) as {
        path?: unknown
        isDirectory?: unknown
        line?: unknown
        lineEnd?: unknown
      }[]

      const positiveInt = (value: unknown) => (typeof value === 'number' && value > 0 ? Math.floor(value) : undefined)

      for (const entry of parsed) {
        if (!entry || typeof entry.path !== 'string' || !entry.path) {
          continue
        }

        const line = positiveInt(entry.line)
        const rawEnd = positiveInt(entry.lineEnd)
        const lineEnd = line && rawEnd && rawEnd > line ? rawEnd : undefined
        const dedupKey = line ? `${entry.path}:${line}-${lineEnd ?? line}` : entry.path

        if (seenPaths.has(dedupKey)) {
          continue
        }

        seenPaths.add(dedupKey)
        result.push({ isDirectory: entry.isDirectory === true, line, lineEnd, path: entry.path })
      }
    }
  } catch {
    // Malformed payload — fall through to native files.
  }

  const pushNativeEntry = (file: File, isDirectory: boolean) => {
    if (seenFiles.has(file)) {
      return
    }

    seenFiles.add(file)

    if (isDirectory) {
      // A dropped directory has no byte content — skip (universal folder attach
      // comes through the folder picker / Tauri drop path).
      return
    }

    result.push({ file, path: '' })
  }

  const items = transfer.items

  if (items) {
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i]

      if (!item || item.kind !== 'file') {
        continue
      }

      let isDirectory = false

      try {
        const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null
        isDirectory = entry?.isDirectory === true
      } catch {
        isDirectory = false
      }

      const file = item.getAsFile()

      if (!file) {
        continue
      }

      pushNativeEntry(file, isDirectory)
    }
  }

  const fileList = transfer.files

  if (fileList) {
    for (let i = 0; i < fileList.length; i += 1) {
      const file = fileList.item(i)

      if (!file) {
        continue
      }

      pushNativeEntry(file, false)
    }
  }

  return result
}

/**
 * Split dropped entries by origin. OS/Finder drops carry a native `File` handle;
 * in-app drags (project tree, gutter line refs) are path-only.
 */
export function partitionDroppedFiles(candidates: DroppedFile[]): {
  osDrops: DroppedFile[]
  inAppRefs: DroppedFile[]
} {
  const osDrops: DroppedFile[] = []
  const inAppRefs: DroppedFile[] = []

  for (const candidate of candidates) {
    if (candidate.file) {
      osDrops.push(candidate)
    } else {
      inAppRefs.push(candidate)
    }
  }

  return { osDrops, inAppRefs }
}
