import { translateNow } from '@/i18n'
import { readDesktopFileDataUrl } from '@/lib/desktop-fs'
import { filePathFromMediaPath, isFileMediaPath, isInlineMediaSrc, mediaName } from '@/lib/media-format'
import { canStreamMedia, mediaStreamUrl } from '@/lib/media-stream'
import { IS_TAURI } from '@/lib/platform'
import { isRecording, recordSpan } from '@/observability'
import { $connection } from '@/store/connection'

// Media resolver for the universal (Tauri) client. Ported from
// apps/desktop/src/lib/media.ts, keeping only the remote-gateway branch: the
// universal client is ALWAYS a remote gateway client (the workspace lives on
// the gateway, not this device), so file/media paths resolve to gateway bytes
// fetched over the authenticated Rust transport.
//
// Fetching through `readDesktopFileDataUrl` (→ /api/fs/read-data-url over the
// Rust HTTP transport, which carries the shared cookie jar) is what lets media
// load under cookie/ticket auth too — the raw `<img src>` download endpoint
// only authenticated in token mode. That closes the former cookie/ticket-auth
// gap (was tracked as K4) for display; the `&token=` download URL below is kept
// only as an "open/download" affordance.
//
// Audio and video take a different route: the `hermes-media://` scheme
// (lib/media-stream.ts + src-tauri/src/media.rs), which proxies bounded HTTP
// ranges so a clip is seekable and never fully in memory. Images and everything
// else keep the data URL — they are small, and a data URL needs no scheme or CSP
// surface. `MediaAttachment` falls back to the data URL once if the stream
// errors, which covers a gateway that confines its download endpoint or caps
// file size.
//
// The pure path/kind helpers live in lib/media-format.ts (no store/transport
// deps); re-exported here so existing `@/lib/media` importers are unchanged.

export {
  filePathFromMediaPath,
  isInlineMediaSrc,
  mediaDisplayLabel,
  mediaKind,
  type MediaKind,
  mediaMarkdownHref,
  mediaMime,
  mediaName,
  mediaPathFromMarkdownHref
} from '@/lib/media-format'

/**
 * How many media resolves are in flight right now.
 *
 * Every image in a transcript resolves through here, and each one is a HEIGHT
 * CHANGE waiting to happen: the placeholder is one line of text and the resolved
 * image is however tall it is. Opening one code-heavy chat fired twelve of these
 * within a millisecond of each other, and the transcript stepped twelve times as
 * they landed.
 *
 * So the transcript's reveal gate (thread/list.tsx) waits on this: a stable
 * scroll height while a dozen images are still in flight is not a settled
 * transcript, it is a transcript that has not been told yet.
 *
 * A count rather than a store: the gate polls it once a frame from a
 * `requestAnimationFrame` loop it already runs, and a nanostores atom here would
 * put a subscriber notification on a path that fires per image per chat open.
 */
let mediaInFlight = 0

export function pendingMediaCount(): number {
  return mediaInFlight
}

// Resolve a media path to a src the webview can display. Inline sources
// (http(s):/data:) pass through; gateway-local file paths are fetched over the
// authenticated Rust transport and returned as a data URL.
export async function resolveMediaDisplaySrc(path: string): Promise<string> {
  if (isInlineMediaSrc(path) || !isFileMediaPath(path)) {
    return path
  }

  // Synchronous for the streaming branch — no base64 round trip before the
  // element even mounts, which the data-URL path always paid.
  if (canStreamMedia(path)) {
    return mediaStreamUrl(path)
  }

  mediaInFlight += 1

  const startedAt = performance.now()

  try {
    return await gatewayMediaDataUrl(path)
  } finally {
    mediaInFlight -= 1

    if (isRecording()) {
      // Named by basename, not the full path: a gateway path is long, often
      // identifying, and the only question this span answers is "which of the
      // twelve was still in flight when the transcript settled".
      recordSpan('media.resolve', startedAt, performance.now(), { file: mediaName(path) })
    }
  }
}

// Resolve a media path to a URL the OS shell / download can use. Gateway-local
// paths become an authenticated /api/files/download URL (the file lives on the
// gateway, not this device); http(s):/data: pass through.
export function mediaExternalUrl(path: string): string {
  if (/^https?:/i.test(path) || /^data:/i.test(path)) {
    return path
  }

  const conn = $connection.get()

  if (conn?.baseUrl) {
    const file = encodeURIComponent(filePathFromMediaPath(path))
    const token = conn.token ? `&token=${encodeURIComponent(conn.token)}` : ''

    return `${conn.baseUrl}/api/files/download?path=${file}${token}`
  }

  return /^file:/i.test(path) ? path : `file://${path}`
}

// Fetch gateway-local media as a data URL over the authenticated fs bridge.
// Gateway artifacts can live anywhere the gateway can read (workspace, skills,
// ~/.allr/cache, …); /api/fs/read-data-url is the general reader.
export async function gatewayMediaDataUrl(path: string): Promise<string> {
  return readDesktopFileDataUrl(filePathFromMediaPath(path))
}

// Codes `src-tauri/src/files.rs` returns, mapped to localized messages. Rust
// returns codes rather than prose so the only English in a translated UI isn't
// coming from the native layer.
const DOWNLOAD_ERRORS: Record<string, string> = {
  download_failed: 'failed',
  file_forbidden: 'forbidden',
  file_not_found: 'notFound',
  file_too_large: 'tooLarge',
  gateway_unreachable: 'unreachable',
  no_gateway: 'noGateway',
  unauthorized: 'unauthorized',
  write_failed: 'writeFailed'
}

function downloadError(err: unknown): Error {
  const code = typeof err === 'string' ? err : (err as Error)?.message
  const key = DOWNLOAD_ERRORS[code ?? '']

  return new Error(translateNow(`common.fileDownload.${key ?? 'failed'}`))
}

/**
 * Save a gateway file to a local path the user picks.
 *
 * The bytes never enter the webview: Rust fetches `/api/files/download` over
 * the authenticated transport and writes the file itself. That is what makes
 * this work at all —
 *
 *  * a raw download URL can't authenticate from the webview under a gated
 *    gateway (no `?token=` outside token mode, and the `SameSite=Lax` session
 *    cookie never rides on a cross-site subresource);
 *  * the previous route read the file as a `data:` URL and `fetch`ed it, which
 *    the app CSP (`connect-src 'self' ipc:`) blocks outright;
 *  * `/api/fs/read-data-url` also caps at 16 MB, against 100 MB here;
 *  * and the `<a download>` it ended in is not honoured by the mobile webview.
 *
 * Resolves to `false` when the user dismisses the save dialog.
 *
 * Off Tauri (plain-web dev, vitest) there is no native side, so it falls back
 * to the blob route — which is fine there: a browser has no CSP of ours and
 * honours `<a download>`.
 */
export async function downloadGatewayMediaFile(path: string): Promise<boolean> {
  if (!IS_TAURI) {
    await browserDownloadFallback(path)

    return true
  }

  const [{ save }, { invoke }] = await Promise.all([
    import('@tauri-apps/plugin-dialog'),
    import('@tauri-apps/api/core')
  ])

  const dest = await save({ defaultPath: mediaName(path) })

  if (!dest) {
    return false
  }

  try {
    await invoke('download_file', { dest, path: filePathFromMediaPath(path) })
  } catch (err) {
    throw downloadError(err)
  }

  return true
}

async function browserDownloadFallback(path: string): Promise<void> {
  const dataUrl = await gatewayMediaDataUrl(path)

  if (!dataUrl) {
    throw new Error('Gateway returned no file data')
  }

  const response = await fetch(dataUrl)
  const blobUrl = URL.createObjectURL(await response.blob())
  const anchor = document.createElement('a')
  anchor.href = blobUrl
  anchor.download = mediaName(path)
  anchor.rel = 'noopener noreferrer'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(blobUrl), 30_000)
}
