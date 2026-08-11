import { IS_ANDROID, PLATFORM } from '@/lib/platform'

/**
 * Client half of the `hermes-artifact://` scheme (src-tauri/src/artifact.rs).
 *
 * Pure, and deliberately out of the viewer component: the URL shape is the one
 * thing here that differs per platform, it cannot be checked by reading the
 * component (it needs a Tauri runtime to be wrong in), and getting it wrong
 * leaves a silently blank frame on exactly one OS. So it lives where a unit test
 * can pin every branch.
 */

/**
 * The scheme's origin, which differs by platform: Windows and Android serve a
 * custom scheme as `http://<scheme>.localhost`, everything else as
 * `<scheme>://localhost`.
 *
 * Identical branch to `lib/media-stream.ts`'s `mediaSchemeOrigin`, and read from
 * the `PLATFORM` seam rather than sniffing `navigator.userAgent` — the seam is
 * what the rest of the app trusts, it resolves iOS and Android correctly where a
 * UA substring test is guesswork, and it is mockable in tests.
 */
function artifactSchemeOrigin(): string {
  return PLATFORM === 'windows' || IS_ANDROID ? 'http://hermes-artifact.localhost' : 'hermes-artifact://localhost'
}

/**
 * The URL a staged artifact document loads from.
 *
 * The id rides in the PATH under a fixed `localhost` host — the shape Tauri
 * documents for custom schemes and the one `hermes-media://` already proves
 * works on every target. The id used to be the URL's HOST, which asks the URL
 * parser to accept an arbitrary opaque host and to preserve its case on four
 * different engines; there is no reason to find out which of them doesn't.
 */
export function artifactFrameUrl(documentId: string): string {
  return `${artifactSchemeOrigin()}/${encodeURIComponent(documentId)}`
}

/**
 * Wrap an HTML fragment in a minimal document shell; full documents pass through
 * untouched. Keeps generated fragments (no `<html>`/`<body>`) rendering with
 * sane defaults instead of quirks-mode soup.
 */
export function composeArtifactHtml(content: string): string {
  if (/<html[\s>]|<!doctype\s+html/i.test(content)) {
    return content
  }

  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    '<style>body{margin:0;font-family:system-ui,sans-serif}</style></head><body>',
    content,
    '</body></html>'
  ].join('\n')
}
