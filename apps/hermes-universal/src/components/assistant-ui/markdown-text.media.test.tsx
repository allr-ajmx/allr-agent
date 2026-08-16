/**
 * Markdown IMAGE syntax the model wrote itself — `![alt](src)`.
 *
 * Adapted from apps/desktop/src/components/assistant-ui/markdown-text.media.test.tsx.
 * Desktop mounts `MarkdownImage` directly and stubs `window.hermesDesktop.api`;
 * universal does not export the component and has no Electron bridge, so these
 * drive the real streamdown pipeline and mock the one transport underneath it —
 * `readDesktopFileDataUrl`, the authenticated fs read every gateway-local byte
 * comes back over.
 *
 * THE DEFECT THESE PIN. Universal's `img:` renderer handed its `src` straight to
 * `ZoomableImage`: no kind check, no resolution. So `![clip](clip.mp4)` — which
 * is how generated media routinely arrives — painted a broken-image glyph over a
 * perfectly good video, and a bare gateway path like `/work/out.png` was resolved
 * by the webview against the APP's origin (there is no such file on this device;
 * universal is always a remote-gateway client) and 404'd. Both were live on
 * main-sync; desktop has classified and resolved here since #40896.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const REMOTE_IMAGE_PATH = '/home/user/project/images/remote-preview.png'
const REMOTE_IMAGE_DATA_URL = 'data:image/png;base64,cmVtb3RlLWltYWdl'
const VIDEO_DATA_URL = 'data:video/mp4;base64,Y2xpcA=='
const AUDIO_DATA_URL = 'data:audio/mpeg;base64,bm90ZQ=='

// Answers per path, and answers something DIFFERENT from what was asked for —
// a component that echoed its raw `src` instead of resolving it cannot pass.
const readDesktopFileDataUrl = vi.fn(async (path: string) => {
  if (path.endsWith('.mp4')) {
    return VIDEO_DATA_URL
  }

  if (path.endsWith('.mp3')) {
    return AUDIO_DATA_URL
  }

  return REMOTE_IMAGE_DATA_URL
})

vi.mock('@/lib/desktop-fs', async importOriginal => ({
  ...((await importOriginal()) as Record<string, unknown>),
  readDesktopFileDataUrl: (path: string) => readDesktopFileDataUrl(path)
}))

const { MarkdownTextContent } = await import('./markdown-text')

beforeEach(() => {
  readDesktopFileDataUrl.mockClear()
})

afterEach(cleanup)

describe('MarkdownTextContent remote images', () => {
  it('passes the gateway bridge data URL through Streamdown to the zoomable image', async () => {
    render(<MarkdownTextContent isRunning={false} text={`![Remote preview](${REMOTE_IMAGE_PATH})`} />)

    const image = await screen.findByRole('img', { name: 'Remote preview' })

    await waitFor(() => expect(image.getAttribute('src')).toBe(REMOTE_IMAGE_DATA_URL))
    expect(readDesktopFileDataUrl).toHaveBeenCalledWith(REMOTE_IMAGE_PATH)
  })

  it('leaves an http source alone rather than asking the gateway for it', async () => {
    const remote = 'https://cdn.example/pic.png'

    render(<MarkdownTextContent isRunning={false} text={`![Hosted](${remote})`} />)

    const image = await screen.findByRole('img', { name: 'Hosted' })

    expect(image.getAttribute('src')).toBe(remote)
    expect(readDesktopFileDataUrl).not.toHaveBeenCalled()
  })
})

// Regression for desktop #40896: generated media often arrives as image markdown
// (`![clip](clip.mp4)`). A raw <img> with a video/audio source paints a
// broken-image icon even though the file is valid, so the source's KIND has to
// pick the element.
describe('markdown image media routing', () => {
  it('renders a <video> (not a broken <img>) for a video source', async () => {
    const { container } = render(<MarkdownTextContent isRunning={false} text="![clip](/tmp/clip.mp4)" />)

    await waitFor(() => expect(container.querySelector('video')).not.toBeNull())
    expect(container.querySelector('video')?.getAttribute('src')).toBe(VIDEO_DATA_URL)
    expect(container.querySelector('img')).toBeNull()
  })

  it('renders an <audio> element for an audio source', async () => {
    const { container } = render(<MarkdownTextContent isRunning={false} text="![note](/tmp/note.mp3)" />)

    await waitFor(() => expect(container.querySelector('audio')).not.toBeNull())
    expect(container.querySelector('audio')?.getAttribute('src')).toBe(AUDIO_DATA_URL)
    expect(container.querySelector('img')).toBeNull()
  })

  it('still renders an <img> for an image source', async () => {
    const { container } = render(<MarkdownTextContent isRunning={false} text="![pic](/tmp/pic.png)" />)

    await waitFor(() => expect(container.querySelector('img')).not.toBeNull())
    expect(container.querySelector('video')).toBeNull()
    expect(container.querySelector('audio')).toBeNull()
  })
})
