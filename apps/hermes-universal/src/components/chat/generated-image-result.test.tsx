import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A generated image lands on the GATEWAY's disk (`~/.hermes/cache/images/…`), so
 * the only way this renderer can paint it is over the authenticated Rust
 * transport. Pointing `<img>` at the gateway's `/api/files/download` URL instead
 * put an unauthenticated request on the wire: behind a gated gateway it comes
 * back 401 (nothing outside the transport can sign it — `?token=` exists only in
 * token mode, and the SameSite=Lax session cookie is never sent on a cross-site
 * subresource), `onError` fires, and this component renders `null`. A successful
 * generation therefore showed NOTHING in the transcript while the file sat in
 * the cache folder — the failure these tests exist to keep out.
 */

const DATA_URL = 'data:image/png;base64,Ynl0ZXM='
const readDesktopFileDataUrl = vi.fn(async (_path: string) => DATA_URL)

vi.mock('@/lib/desktop-fs', async importOriginal => ({
  ...((await importOriginal()) as Record<string, unknown>),
  readDesktopFileDataUrl: (path: string) => readDesktopFileDataUrl(path)
}))

const { GeneratedImage } = await import('./generated-image-result')

const GATEWAY_PATH = '/Users/me/.hermes/cache/images/gen-1.png'

beforeEach(() => {
  readDesktopFileDataUrl.mockClear()
  readDesktopFileDataUrl.mockResolvedValue(DATA_URL)
})

describe('GeneratedImage', () => {
  it('paints a gateway-local image through the authenticated fs bridge', async () => {
    render(<GeneratedImage result={{ host_image: GATEWAY_PATH }} />)

    await waitFor(() => expect(screen.getByRole('img')).toHaveAttribute('src', DATA_URL))
    expect(readDesktopFileDataUrl).toHaveBeenCalledWith(GATEWAY_PATH)
  })

  it('leaves an inline source alone rather than asking the gateway to read it', async () => {
    render(<GeneratedImage result={{ host_image: DATA_URL }} />)

    await waitFor(() => expect(screen.getByRole('img')).toHaveAttribute('src', DATA_URL))
    expect(readDesktopFileDataUrl).not.toHaveBeenCalled()
  })

  it('holds the pulse frame while the read is in flight, never an empty box', () => {
    // The read is async, so the first paint has no src. Showing the sized
    // placeholder is what keeps the transcript from shifting under the image.
    render(<GeneratedImage result={{ host_image: GATEWAY_PATH }} />)

    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('renders nothing when the gateway cannot read the file', async () => {
    readDesktopFileDataUrl.mockRejectedValue(new Error('gone'))

    const { container } = render(<GeneratedImage result={{ host_image: GATEWAY_PATH }} />)

    await waitFor(() => expect(container).toBeEmptyDOMElement())
  })
})
