import { afterEach, describe, expect, it, vi } from 'vitest'

// The per-platform URL form is the one thing here that cannot be checked by
// reading the component — it needs a Tauri runtime to be wrong in — so the
// platform seam is mocked and every branch is asserted. Same shape as
// `lib/media-stream.test.ts`, which pins the sibling scheme.
vi.mock('@/lib/platform', () => ({ IS_ANDROID: false, PLATFORM: 'linux' }))

import { artifactFrameUrl, composeArtifactHtml } from '@/lib/artifact-frame'

async function loadOn(platform: string, isAndroid = false) {
  vi.resetModules()
  vi.doMock('@/lib/platform', () => ({ IS_ANDROID: isAndroid, PLATFORM: platform }))

  return import('@/lib/artifact-frame')
}

afterEach(() => {
  vi.doUnmock('@/lib/platform')
})

describe('artifactFrameUrl', () => {
  it('serves the custom scheme on Linux, macOS and iOS', async () => {
    for (const platform of ['linux', 'macos', 'ios']) {
      const mod = await loadOn(platform)

      expect(mod.artifactFrameUrl('k3n9zq')).toBe('hermes-artifact://localhost/k3n9zq')
    }
  })

  // Windows and Android rewrite a custom scheme to an http host. Both spellings
  // are named in the app CSP's `frame-src`, and both are read by the Rust
  // handler — but only one of them is correct per platform, and getting it
  // backwards is a silently blank frame on exactly one OS.
  it('serves the http rewrite on Windows and Android', async () => {
    const windows = await loadOn('windows')

    expect(windows.artifactFrameUrl('k3n9zq')).toBe('http://hermes-artifact.localhost/k3n9zq')

    const android = await loadOn('android', true)

    expect(android.artifactFrameUrl('k3n9zq')).toBe('http://hermes-artifact.localhost/k3n9zq')
  })

  // The id rides in the PATH under a fixed host, never as the host itself:
  // an arbitrary opaque host is parsed (and cased) differently by the four
  // engines this app ships on.
  it('puts the id on the path, not the host', () => {
    expect(new URL(artifactFrameUrl('abc')).pathname).toBe('/abc')
  })

  it('encodes an id that is not URL-safe', () => {
    expect(artifactFrameUrl('a/b c')).toBe('hermes-artifact://localhost/a%2Fb%20c')
  })
})

describe('composeArtifactHtml', () => {
  it('leaves a full document untouched', () => {
    const doc = '<!doctype html>\n<html><body>hi</body></html>'

    expect(composeArtifactHtml(doc)).toBe(doc)
  })

  it('leaves a document that opens with <html> untouched', () => {
    const doc = '<html lang="en"><body>hi</body></html>'

    expect(composeArtifactHtml(doc)).toBe(doc)
  })

  it('wraps a bare fragment in a document shell', () => {
    const wrapped = composeArtifactHtml('<p>hi</p>')

    expect(wrapped.startsWith('<!doctype html>')).toBe(true)
    expect(wrapped).toContain('<p>hi</p>')
    expect(wrapped).toContain('width=device-width')
  })
})
