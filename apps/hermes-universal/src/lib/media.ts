import { readDesktopFileDataUrl } from '@/lib/desktop-fs'
import { filePathFromMediaPath, isFileMediaPath, isInlineMediaSrc, mediaName } from '@/lib/media-format'
import { canStreamMedia, mediaStreamUrl } from '@/lib/media-stream'
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

  return gatewayMediaDataUrl(path)
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
// ~/.hermes/cache, …); /api/fs/read-data-url is the general reader.
export async function gatewayMediaDataUrl(path: string): Promise<string> {
  return readDesktopFileDataUrl(filePathFromMediaPath(path))
}

// Fetch gateway-local bytes over the fs bridge and hand them to the webview as
// a browser download (the file lives on the gateway, so there's no local path
// to open directly).
export async function downloadGatewayMediaFile(path: string): Promise<void> {
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
