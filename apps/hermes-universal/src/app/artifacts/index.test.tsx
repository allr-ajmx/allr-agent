import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SessionInfo, SessionMessage } from '@/types/hermes'

import { artifactImageSrc, collectArtifactsForSession } from './artifact-utils'

const getSessionMessages = vi.fn()
const listAllProfileSessions = vi.fn()

const DATA_URL = 'data:image/jpeg;base64,Ynl0ZXM='
const readDesktopFileDataUrl = vi.fn(async (_path: string) => DATA_URL)
const downloadPath = vi.fn(async (_path: string) => 'download-1')
const openExternalLink = vi.fn(async (_href: string) => undefined)

// jsdom is not Tauri, and `IS_TAURI` is a load-time const — without this the
// artifact click would take the plain-browser blob fallback and never reach the
// downloads tray, which is the branch that actually ships.
vi.mock('@/lib/platform', async importOriginal => ({
  ...((await importOriginal()) as Record<string, unknown>),
  IS_TAURI: true
}))

vi.mock('@/store/downloads', async importOriginal => ({
  ...((await importOriginal()) as Record<string, unknown>),
  downloadPath: (path: string) => downloadPath(path)
}))

vi.mock('@/lib/external-link', async importOriginal => ({
  ...((await importOriginal()) as Record<string, unknown>),
  openExternalLink: (href: string) => openExternalLink(href)
}))

vi.mock('@/hermes', async importOriginal => ({
  ...((await importOriginal()) as Record<string, unknown>),
  getSessionMessages: (...args: unknown[]) => getSessionMessages(...args),
  listAllProfileSessions: (...args: unknown[]) => listAllProfileSessions(...args)
}))

// The fs bridge is the transport-backed read (/api/fs/read-data-url); stubbing it
// is what lets the src assertions below distinguish it from the raw download URL.
vi.mock('@/lib/desktop-fs', async importOriginal => ({
  ...((await importOriginal()) as Record<string, unknown>),
  readDesktopFileDataUrl: (path: string) => readDesktopFileDataUrl(path)
}))

const { ArtifactsView } = await import('./index')

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    ended_at: null,
    id: 'session-1',
    input_tokens: 0,
    is_active: false,
    last_active: 1000,
    message_count: 1,
    model: null,
    output_tokens: 0,
    preview: null,
    source: null,
    started_at: 1000,
    title: 'Session',
    tool_call_count: 0,
    ...overrides
  }
}

describe('collectArtifactsForSession', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('indexes plain https links from assistant text', () => {
    const artifacts = collectArtifactsForSession(makeSession(), [
      {
        content: 'Reference: https://example.com/docs/getting-started',
        role: 'assistant',
        timestamp: 2000
      }
    ])

    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]).toMatchObject({
      href: 'https://example.com/docs/getting-started',
      kind: 'link',
      value: 'https://example.com/docs/getting-started'
    })
  })

  it('indexes http links present in tool JSON payloads', () => {
    const messages: SessionMessage[] = [
      {
        content: JSON.stringify({ source_url: 'https://example.com/changelog/latest' }),
        role: 'tool',
        timestamp: 3000
      }
    ]

    const artifacts = collectArtifactsForSession(makeSession({ id: 'session-2' }), messages)

    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]).toMatchObject({
      href: 'https://example.com/changelog/latest',
      kind: 'link',
      value: 'https://example.com/changelog/latest'
    })
  })

  // The regression this pins: a gateway-local image must come over the
  // authenticated transport, NOT from the raw /api/files/download href. Nothing
  // outside the transport can authenticate that URL behind a gated gateway, so
  // pointing `<img>` at it renders a broken card and a 401 in the network log.
  it('reads a gateway-local image over the authenticated transport, not its download href', async () => {
    const path = '/Users/me/.allr/skills/x/images/step.jpeg'
    const downloadHref = `https://gw/api/files/download?path=${encodeURIComponent(path)}&token=secret`

    await expect(artifactImageSrc(path, downloadHref)).resolves.toBe(DATA_URL)
    expect(readDesktopFileDataUrl).toHaveBeenCalledWith(path)
  })

  // …while a link artifact is somebody else's URL: it must NOT be handed to the
  // fs bridge, which would ask the gateway to read a path that does not exist.
  it('passes an http artifact through untouched', async () => {
    const href = 'https://example.com/diagram.png'

    await expect(artifactImageSrc(href, href)).resolves.toBe(href)
    expect(readDesktopFileDataUrl).not.toHaveBeenCalled()
  })
})

/**
 * Desktop's `loads transcripts serially and continues after a session fails`
 * splits in two here. The SERIAL half does not apply: universal fans the loads
 * out with `Promise.allSettled` rather than desktop's memory-bounded `for…of`,
 * so there is no interleaving to assert. The FAILURE-TOLERANCE half does, and
 * matters more — one unreadable transcript must not blank the whole gallery.
 */
describe('ArtifactsView transcript loading', () => {
  const session = (id: string): SessionInfo => makeSession({ id, title: id })

  it('keeps the artifacts of the sessions that loaded when one transcript fails', async () => {
    listAllProfileSessions.mockResolvedValue({ sessions: [session('bad'), session('good')] })
    getSessionMessages.mockImplementation(async (id: string) => {
      if (id === 'bad') {
        throw new Error('transcript unreadable')
      }

      return {
        messages: [
          { content: 'Reference: https://example.com/survivor', role: 'assistant', timestamp: 2000 }
        ] satisfies SessionMessage[]
      }
    })

    render(
      <MemoryRouter>
        <ArtifactsView />
      </MemoryRouter>
    )

    // The surviving session's link is indexed even though its neighbour threw.
    await waitFor(() => expect(screen.getByText(/example\.com\/survivor/)).toBeTruthy())
    expect(getSessionMessages).toHaveBeenCalledTimes(2)
  })
})

/**
 * The dead click target the user reported: "by clicking the image title it does
 * nothing, it should download."
 *
 * `ArtifactImageCard` was never handed the `CellCtx` the table cells get, so its
 * label and path were bare <div>s with no handler on them — the only live
 * targets on the card were the zoom trigger and Chat.
 */
describe('ArtifactImageCard activation', () => {
  const imageSession = () => {
    listAllProfileSessions.mockResolvedValue({ sessions: [makeSession({ id: 'shots', title: 'Shots' })] })
    getSessionMessages.mockResolvedValue({
      messages: [
        { content: '![step one](/Users/me/out/step.png)', role: 'assistant', timestamp: 2000 }
      ] satisfies SessionMessage[]
    })
  }

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('queues the gateway file through the downloads tray when the title is activated', async () => {
    imageSession()

    render(
      <MemoryRouter>
        <ArtifactsView />
      </MemoryRouter>
    )

    fireEvent.click(await screen.findByText('step.png'))

    // The PATH, not the record's href: the href is /api/files/download with a
    // token, and nothing outside the Rust transport can authenticate it.
    await waitFor(() => expect(downloadPath).toHaveBeenCalledWith('/Users/me/out/step.png'))
    expect(openExternalLink).not.toHaveBeenCalled()
  })

  it('leaves Chat alone — it navigates, it does not also download', async () => {
    // Chat is a SIBLING of the new download target rather than a child of it,
    // so it cannot bubble into one. Pinned because the obvious way to make a
    // whole card clickable — a handler on the <article> — would have made every
    // press of this button start a transfer as well.
    imageSession()

    render(
      <MemoryRouter initialEntries={['/artifacts']}>
        <Routes>
          <Route element={<ArtifactsView />} path="/artifacts" />
          <Route element={<div>chat route</div>} path="*" />
        </Routes>
      </MemoryRouter>
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Chat' }))

    expect(await screen.findByText('chat route')).toBeTruthy()
    expect(downloadPath).not.toHaveBeenCalled()
  })
})
