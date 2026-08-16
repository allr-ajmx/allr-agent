/**
 * Media path resolution — the layer every inline image, clip and download goes
 * through, and the one module of the media stack that had no test at all.
 *
 * Adapted from apps/desktop/src/lib/media.remote.test.ts. Desktop's suite is
 * organised around a local-vs-remote split (`isRemoteGateway`, an Electron
 * streaming protocol, a separate `resolveMediaPlaybackSrc`) that universal does
 * not have and deliberately does not want: the universal client is ALWAYS a
 * remote-gateway client, so there is one route and the audio/video branch is
 * folded into `resolveMediaDisplaySrc` behind `canStreamMedia`. The cases below
 * are the ones that survive that difference, with the transport re-pointed from
 * `window.hermesDesktop.api` to the Rust fs bridge.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// jsdom is not Tauri, so `canStreamMedia` stands down and audio/video take the
// same data-URL route as everything else. That is the branch under test here;
// the `hermes-media://` branch is `lib/media-stream.test.ts`'s.
const readDesktopFileDataUrl = vi.fn(async (_path: string) => 'data:image/png;base64,Ynl0ZXM=')

vi.mock('@/lib/desktop-fs', async importOriginal => ({
  ...((await importOriginal()) as Record<string, unknown>),
  readDesktopFileDataUrl: (path: string) => readDesktopFileDataUrl(path)
}))

const {
  downloadGatewayMediaFile,
  filePathFromMediaPath,
  gatewayMediaDataUrl,
  isInlineMediaSrc,
  mediaExternalUrl,
  mediaKind,
  resolveMediaDisplaySrc
} = await import('@/lib/media')

const { $connection } = await import('@/store/connection')

beforeEach(() => {
  readDesktopFileDataUrl.mockClear()
  readDesktopFileDataUrl.mockResolvedValue('data:image/png;base64,Ynl0ZXM=')
  $connection.set({ authMode: 'none', baseUrl: 'https://gw.example', mode: 'remote' } as never)
})

afterEach(() => {
  $connection.set(null)
})

describe('filePathFromMediaPath', () => {
  it('passes through a plain path', () => {
    expect(filePathFromMediaPath('/tmp/a.png')).toBe('/tmp/a.png')
  })

  it('decodes a file:// URL with encoded characters', () => {
    expect(filePathFromMediaPath('file:///tmp/my%20shot%20%231.png')).toBe('/tmp/my shot #1.png')
  })
})

describe('isInlineMediaSrc', () => {
  it('recognises the sources that need no resolution', () => {
    expect(isInlineMediaSrc('https://cdn.example/a.png')).toBe(true)
    expect(isInlineMediaSrc('data:image/png;base64,AAA')).toBe(true)
    expect(isInlineMediaSrc('/tmp/a.png')).toBe(false)
    expect(isInlineMediaSrc('file:///tmp/a.png')).toBe(false)
  })
})

describe('mediaExternalUrl', () => {
  it('passes through http(s) and data URLs untouched', () => {
    expect(mediaExternalUrl('https://cdn.example/a.png')).toBe('https://cdn.example/a.png')
    expect(mediaExternalUrl('data:image/png;base64,AAA')).toBe('data:image/png;base64,AAA')
  })

  it('rewrites gateway-local paths to a download URL, carrying the token when there is one', () => {
    expect(mediaExternalUrl('/work/a b.png')).toBe('https://gw.example/api/files/download?path=%2Fwork%2Fa%20b.png')

    $connection.set({ authMode: 'token', baseUrl: 'https://gw.example', mode: 'remote', token: 't/k' } as never)

    expect(mediaExternalUrl('/work/a.png')).toBe(
      'https://gw.example/api/files/download?path=%2Fwork%2Fa.png&token=t%2Fk'
    )
  })

  // Deliberate divergence from desktop, which drops to file:// whenever the
  // connection carries no token. Universal's transport authenticates by cookie
  // or ticket as often as by token, so the download URL is still the right
  // answer without one — only a connection with no base URL at all falls back.
  it('falls back to a file URL only when there is no gateway to ask', () => {
    $connection.set(null)

    expect(mediaExternalUrl('/work/a.png')).toBe('file:///work/a.png')
    expect(mediaExternalUrl('file:///work/a.png')).toBe('file:///work/a.png')
  })
})

describe('resolveMediaDisplaySrc', () => {
  it('leaves web, data and relative markdown sources unchanged', async () => {
    await expect(resolveMediaDisplaySrc('https://cdn.example/a.png')).resolves.toBe('https://cdn.example/a.png')
    await expect(resolveMediaDisplaySrc('data:image/png;base64,AAA')).resolves.toBe('data:image/png;base64,AAA')
    // Not an absolute/file path, so there is nothing for the gateway to read.
    await expect(resolveMediaDisplaySrc('images/a.png')).resolves.toBe('images/a.png')
    expect(readDesktopFileDataUrl).not.toHaveBeenCalled()
  })

  it('reads a gateway-local path back as bytes over the fs bridge', async () => {
    await expect(resolveMediaDisplaySrc('/work/out.png')).resolves.toBe('data:image/png;base64,Ynl0ZXM=')
    expect(readDesktopFileDataUrl).toHaveBeenCalledWith('/work/out.png')
  })

  it('strips the file:// prefix before asking for it', async () => {
    await resolveMediaDisplaySrc('file:///work/out.png')

    expect(readDesktopFileDataUrl).toHaveBeenCalledWith('/work/out.png')
  })
})

describe('gatewayMediaDataUrl', () => {
  it('goes through the fs bridge rather than an /api/media root', async () => {
    await expect(gatewayMediaDataUrl('file:///work/out.png')).resolves.toBe('data:image/png;base64,Ynl0ZXM=')
    expect(readDesktopFileDataUrl).toHaveBeenCalledWith('/work/out.png')
  })
})

describe('downloadGatewayMediaFile', () => {
  it('hands the bytes to the webview as a named download', async () => {
    const created: string[] = []
    const clicks: string[] = []

    vi.stubGlobal('fetch', async (url: string) => new Response(new Blob([url])))
    URL.createObjectURL = vi.fn(() => {
      created.push('blob:made')

      return 'blob:made'
    })
    URL.revokeObjectURL = vi.fn()

    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push(this.download)
    })

    await downloadGatewayMediaFile('/work/report card.pdf')

    expect(created).toHaveLength(1)
    // The NAME matters: without it the browser saves the blob id.
    expect(clicks).toEqual(['report card.pdf'])
    // …and the anchor is gone again, so the transcript is not littered with them.
    expect(document.querySelector('a[download]')).toBeNull()

    click.mockRestore()
    vi.unstubAllGlobals()
  })

  it('rejects when the gateway refuses the file read', async () => {
    readDesktopFileDataUrl.mockResolvedValue('')

    await expect(downloadGatewayMediaFile('/work/missing.png')).rejects.toThrow('Gateway returned no file data')
  })
})

describe('mediaKind', () => {
  it('classifies by extension, which is what picks the element that renders it', () => {
    expect(mediaKind('/tmp/clip.mp4')).toBe('video')
    expect(mediaKind('/tmp/note.mp3')).toBe('audio')
    expect(mediaKind('/tmp/pic.PNG')).toBe('image')
    expect(mediaKind('/tmp/notes.txt')).toBe('file')
    expect(mediaKind('/tmp/no-extension')).toBe('file')
  })
})
