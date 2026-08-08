import { invoke } from '@tauri-apps/api/core'

import { filePathFromMediaPath, mediaKind } from '@/lib/media-format'
import { IS_ANDROID, IS_TAURI, PLATFORM } from '@/lib/platform'
import { $connection } from '@/store/connection'

/**
 * Client half of the `hermes-media://` streaming scheme (src-tauri/src/media.rs).
 *
 * Audio and video used to load as base64 data URLs — the whole file in memory
 * before the first frame, and no seeking. This builds the scheme URL a media
 * element can range-fetch instead, and keeps the Rust handler supplied with the
 * gateway it should proxy to.
 */

// Mirrors `streamable_mime` in media.rs and desktop's STREAMABLE_MEDIA_EXTS.
// Anything outside this set keeps the data-URL path.
const STREAMABLE_EXTS = new Set(['avi', 'flac', 'm4a', 'm4v', 'mkv', 'mov', 'mp3', 'mp4', 'ogg', 'opus', 'wav', 'webm'])

/**
 * The scheme's origin, which differs by platform: Windows and Android serve a
 * custom scheme as `http://<scheme>.localhost`, everything else as
 * `<scheme>://localhost`.
 *
 * Hand-rolled rather than calling Tauri's `convertFileSrc` (which makes the same
 * branch) so this stays a pure function — `convertFileSrc` reads
 * `window.__TAURI_INTERNALS__` and throws under vitest.
 */
function mediaSchemeOrigin(): string {
  return PLATFORM === 'windows' || IS_ANDROID ? 'http://hermes-media.localhost' : 'hermes-media://localhost'
}

/**
 * The streaming URL for a gateway media path.
 *
 * The path rides in the QUERY, not a path segment: a `%2F` inside a URL path is
 * normalized by some engines, and the Rust side forwards the encoded value
 * verbatim into the gateway's own `?path=` with no decode/re-encode round trip.
 */
export function mediaStreamUrl(path: string): string {
  return `${mediaSchemeOrigin()}/stream?path=${encodeURIComponent(filePathFromMediaPath(path))}`
}

/** Whether `path` should go through the scheme rather than a data URL. */
export function canStreamMedia(path: string): boolean {
  if (!IS_TAURI || !$connection.get()?.baseUrl) {
    return false
  }

  const kind = mediaKind(path)

  if (kind !== 'audio' && kind !== 'video') {
    return false
  }

  const ext = path.split(/[?#]/, 1)[0]?.split('.').pop()?.toLowerCase()

  return Boolean(ext) && STREAMABLE_EXTS.has(ext as string)
}

/** True when `src` came from {@link mediaStreamUrl} — the retry path's cue that
 *  a failure is worth one attempt at the data URL. */
export function isMediaStreamUrl(src: string): boolean {
  return src.startsWith('hermes-media://') || src.startsWith('http://hermes-media.localhost')
}

// The scheme handler runs outside the webview and can't read `$connection`, so
// the gateway base URL and the session-token header are pushed into Rust on
// every connection change. Same shape and lifecycle as voice's TranscribeTarget.
//
// The token goes in a HEADER, never in the URL: a URL lands in the DOM and in
// any devtools network panel, which would undo the whole point of fetching
// media over the authenticated transport.
if (IS_TAURI) {
  $connection.subscribe(conn => {
    void invoke('media_set_target', {
      target: conn?.baseUrl
        ? {
            baseUrl: conn.baseUrl,
            headers: conn.token ? { 'X-Hermes-Session-Token': conn.token } : {}
          }
        : null
    }).catch(() => undefined)
  })
}
