import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// `vi.mock` is hoisted above every top-level binding, so the spy has to be
// created with `vi.hoisted` to exist by the time the factory runs.
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn(async () => undefined) }))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))

// Per-platform URL form is the single easiest thing to get backwards here, so
// the platform seam is mocked and every branch is asserted. Defaults to Linux;
// individual cases re-import the module under a different platform.
vi.mock('@/lib/platform', () => ({ IS_ANDROID: false, IS_TAURI: true, PLATFORM: 'linux' }))

import { canStreamMedia, isMediaStreamUrl, mediaStreamUrl } from '@/lib/media-stream'
import { $connection } from '@/store/connection'

async function loadOn(platform: string, isAndroid = false) {
  vi.resetModules()
  vi.doMock('@/lib/platform', () => ({ IS_ANDROID: isAndroid, IS_TAURI: true, PLATFORM: platform }))

  return import('@/lib/media-stream')
}

beforeEach(() => {
  invoke.mockClear()
  $connection.set({ authMode: 'none', baseUrl: 'https://gw.example', mode: 'remote' } as never)
})

afterEach(() => {
  $connection.set(null)
  vi.doUnmock('@/lib/platform')
})

describe('mediaStreamUrl', () => {
  it('uses the scheme origin on Linux/macOS/iOS', async () => {
    for (const platform of ['linux', 'macos', 'ios']) {
      const mod = await loadOn(platform)

      expect(mod.mediaStreamUrl('/home/me/clip.mp4')).toBe(
        'hermes-media://localhost/stream?path=%2Fhome%2Fme%2Fclip.mp4'
      )
    }
  })

  // Windows and Android serve a custom scheme as an http:// host instead.
  it('uses the http host form on Windows and Android', async () => {
    const windows = await loadOn('windows')

    expect(windows.mediaStreamUrl('/home/me/clip.mp4')).toBe(
      'http://hermes-media.localhost/stream?path=%2Fhome%2Fme%2Fclip.mp4'
    )

    const android = await loadOn('android', true)

    expect(android.mediaStreamUrl('/home/me/clip.mp4')).toBe(
      'http://hermes-media.localhost/stream?path=%2Fhome%2Fme%2Fclip.mp4'
    )
  })

  it('encodes a path with spaces, hashes and non-ASCII', () => {
    expect(mediaStreamUrl('/a b/c#d/é.mp3')).toBe('hermes-media://localhost/stream?path=%2Fa%20b%2Fc%23d%2F%C3%A9.mp3')
  })

  it('strips a file:// prefix before encoding', () => {
    expect(mediaStreamUrl('file:///home/me/clip.mp4')).toBe(
      'hermes-media://localhost/stream?path=%2Fhome%2Fme%2Fclip.mp4'
    )
  })

  it('encodes a Windows path', () => {
    expect(mediaStreamUrl('C:\\Users\\me\\clip.mp4')).toBe(
      'hermes-media://localhost/stream?path=C%3A%5CUsers%5Cme%5Cclip.mp4'
    )
  })
})

describe('canStreamMedia', () => {
  it('streams the audio and video containers the Rust side serves', () => {
    for (const path of ['/a/x.mp4', '/a/x.MKV', '/a/x.mov', '/a/x.webm', '/a/x.mp3', '/a/x.opus', '/a/x.flac']) {
      expect(canStreamMedia(path), path).toBe(true)
    }
  })

  it('leaves images and documents on the data-URL path', () => {
    for (const path of ['/a/x.png', '/a/x.jpg', '/a/x.pdf', '/a/x.txt', '/a/noext']) {
      expect(canStreamMedia(path), path).toBe(false)
    }
  })

  it('stands down with no gateway to proxy to', () => {
    $connection.set(null)

    expect(canStreamMedia('/a/x.mp4')).toBe(false)
  })
})

describe('isMediaStreamUrl', () => {
  it('recognises both platform forms', () => {
    expect(isMediaStreamUrl('hermes-media://localhost/stream?path=x')).toBe(true)
    expect(isMediaStreamUrl('http://hermes-media.localhost/stream?path=x')).toBe(true)
  })

  it('does not mistake a data URL or a plain http URL for one', () => {
    expect(isMediaStreamUrl('data:audio/mpeg;base64,AAA')).toBe(false)
    expect(isMediaStreamUrl('https://gw.example/api/files/download?path=x')).toBe(false)
  })
})

describe('media target push', () => {
  it('pushes the gateway and the session-token header on connect', async () => {
    invoke.mockClear()
    $connection.set({ authMode: 'token', baseUrl: 'https://gw.example', mode: 'remote', token: 'sekret' } as never)

    expect(invoke).toHaveBeenCalledWith('media_set_target', {
      target: { baseUrl: 'https://gw.example', headers: { 'X-Hermes-Session-Token': 'sekret' } }
    })
  })

  it('sends no header when the gateway is cookie/ticket authed', () => {
    invoke.mockClear()
    $connection.set({ authMode: 'ticket', baseUrl: 'https://gw.example', mode: 'remote' } as never)

    expect(invoke).toHaveBeenCalledWith('media_set_target', {
      target: { baseUrl: 'https://gw.example', headers: {} }
    })
  })

  it('clears the target on disconnect', () => {
    invoke.mockClear()
    $connection.set(null)

    expect(invoke).toHaveBeenCalledWith('media_set_target', { target: null })
  })
})
