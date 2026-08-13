import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SessionInfo, SessionMessage } from '@/types/hermes'

import { artifactImageSrc, collectArtifactsForSession } from './artifact-utils'

const getSessionMessages = vi.fn()
const listAllProfileSessions = vi.fn()

vi.mock('@/hermes', async importOriginal => ({
  ...((await importOriginal()) as Record<string, unknown>),
  getSessionMessages: (...args: unknown[]) => getSessionMessages(...args),
  listAllProfileSessions: (...args: unknown[]) => listAllProfileSessions(...args)
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

  // Universal loads images straight from the gateway HTTP URL — there is no
  // Electron read-data-url bridge — so artifactImageSrc is the resolved href.
  it('resolves an image src to its gateway download href', async () => {
    const path = '/Users/me/.hermes/skills/x/images/step.jpeg'
    const downloadHref = `https://gw/api/files/download?path=${encodeURIComponent(path)}&token=secret`

    await expect(artifactImageSrc(path, downloadHref)).resolves.toBe(downloadHref)
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
