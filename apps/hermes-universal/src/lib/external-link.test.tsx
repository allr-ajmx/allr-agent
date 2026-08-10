import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// `vi.mock` is hoisted above every top-level binding, so the spy has to be
// created with `vi.hoisted` to exist by the time the factory runs.
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn(async (_command: string, _args?: unknown) => '') }))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))

// The title fetch and the external open both go through Tauri commands, so the
// platform seam has to report Tauri or every case short-circuits to ''.
vi.mock('@/lib/platform', () => ({ IS_ANDROID: false, IS_MOBILE: false, IS_TAURI: true, PLATFORM: 'linux' }))

import {
  __resetLinkTitleCache,
  ExternalLink,
  fetchLinkTitle,
  hostPathLabel,
  isTitleFetchable,
  LinkifiedText,
  PrettyLink,
  urlSlugTitleLabel
} from '@/lib/external-link'

const FORGEJO_URL = 'https://forgejo.home.example/homelab/homelab-ops/issues/101'

/** `invoke(cmd, args)` is the single native seam; route the two commands this
 *  module uses through one spy so a test can assert on either. */
function mockTitle(title: string) {
  invoke.mockImplementation(async command => (command === 'fetch_link_title' ? title : ''))

  return invoke
}

function titleCalls() {
  return invoke.mock.calls.filter(([command]) => command === 'fetch_link_title')
}

beforeEach(() => {
  invoke.mockReset()
  invoke.mockImplementation(async () => '')
})

afterEach(() => {
  __resetLinkTitleCache()
  cleanup()
})

describe('external link helpers', () => {
  it('formats URL fallbacks as host + path', () => {
    expect(
      hostPathLabel(
        'https://www.getyourguide.com/culebra-island-l145468/from-fajardo-full-day-cordillera-islands-catamaran-tour-t19894/'
      )
    ).toBe('getyourguide.com/culebra-island-l145468/from-fajardo-full-day-cordillera-islands-catamaran-tour-t19894')
  })

  it('derives readable title fallbacks from URL slugs', () => {
    expect(
      urlSlugTitleLabel(
        'https://www.getyourguide.com/fajardo-l882/from-fajardo-icacos-island-full-day-catamaran-trip-t19891/'
      )
    ).toBe('From Fajardo Icacos Island Full Day Catamaran Trip')
  })

  it('filters out local/non-http targets for title fetches', () => {
    expect(isTitleFetchable('https://www.expedia.com/things-to-do/foo')).toBe(true)
    expect(isTitleFetchable('http://localhost:5174')).toBe(false)
    expect(isTitleFetchable('file:///tmp/demo.html')).toBe(false)
    expect(isTitleFetchable('mailto:hello@example.com')).toBe(false)
  })

  it('deduplicates in-flight title fetches and caches results', async () => {
    mockTitle('El Yunque Tour Water Slide, Rope Swing & Pickup')

    const url = 'https://www.expedia.com/things-to-do/puerto-rico-el-yunque-rainforest-adventure.activity-details'
    const [first, second] = await Promise.all([fetchLinkTitle(url), fetchLinkTitle(url)])

    expect(first).toBe('El Yunque Tour Water Slide, Rope Swing & Pickup')
    expect(second).toBe('El Yunque Tour Water Slide, Rope Swing & Pickup')
    expect(titleCalls()).toHaveLength(1)

    await expect(fetchLinkTitle(url)).resolves.toBe('El Yunque Tour Water Slide, Rope Swing & Pickup')
    expect(titleCalls()).toHaveLength(1)
  })

  it('shares cache across protocol/www URL variants', async () => {
    mockTitle('Shared Canonical Title')

    const first = 'https://www.getyourguide.com/san-juan-puerto-rico-l355/sunset-tours-tc306/'
    const second = 'http://getyourguide.com/san-juan-puerto-rico-l355/sunset-tours-tc306/'
    const [a, b] = await Promise.all([fetchLinkTitle(first), fetchLinkTitle(second)])

    expect(a).toBe('Shared Canonical Title')
    expect(b).toBe('Shared Canonical Title')
    expect(titleCalls()).toHaveLength(1)
  })

  it('opens links through the native open_external command', async () => {
    render(<ExternalLink href="https://example.com/path/to/resource">Example link</ExternalLink>)

    fireEvent.click(screen.getByRole('link', { name: 'Example link' }))

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('open_external', { url: 'https://example.com/path/to/resource' })
    })
  })

  it('hides the trailing external-link icon by default', () => {
    render(<ExternalLink href="https://example.com/path/to/resource">Example link</ExternalLink>)

    expect(screen.getByRole('link', { name: 'Example link' }).querySelector('svg')).toBeNull()
  })

  it('shows a trailing external-link icon when opted in', () => {
    render(
      <ExternalLink href="https://example.com/path/to/resource" showExternalIcon>
        Example link
      </ExternalLink>
    )

    expect(screen.getByRole('link', { name: 'Example link' }).querySelector('svg')).toBeTruthy()
  })

  it('renders pretty links with fetched titles and no host suffix', async () => {
    mockTitle('From Fajardo: Full-Day Culebra Islands Catamaran Tour')

    const url =
      'https://www.getyourguide.com/culebra-island-l145468/from-fajardo-full-day-cordillera-islands-catamaran-tour-t19894/'

    render(<LinkifiedText text={`Read ${url}`} />)

    const link = screen.getByTitle(url)
    expect(link.textContent).toContain('From Fajardo Full Day Cordillera Islands Catamaran Tour')

    await waitFor(() => {
      expect(link.textContent).toContain('From Fajardo: Full-Day Culebra Islands Catamaran Tour')
    })
    expect(link.textContent).not.toContain('getyourguide.com')
  })

  it('shows host/path fallback when title is unavailable', () => {
    render(<PrettyLink href="https://www.expedia.com/things-to-do/puerto-rico-el-yunque" />)

    expect(screen.getByTitle('https://www.expedia.com/things-to-do/puerto-rico-el-yunque').textContent).toBe(
      'Puerto Rico El Yunque'
    )
  })

  it('ignores error-like fetched titles and falls back to the slug label', async () => {
    mockTitle('GetYourGuide – Error')

    const url =
      'https://www.getyourguide.com/culebra-island-l145468/from-fajardo-full-day-cordillera-islands-catamaran-tour-t19894/'

    render(<PrettyLink href={url} />)

    await waitFor(() => {
      expect(screen.getByTitle(url).textContent).toBe('From Fajardo Full Day Cordillera Islands Catamaran Tour')
    })
  })

  it('treats not-found fetched titles as unusable', async () => {
    mockTitle('Page not found - Forgejo')

    await expect(fetchLinkTitle(FORGEJO_URL)).resolves.toBe('')
    expect(titleCalls()).toHaveLength(1)
  })

  it('keeps an authored fallbackLabel ahead of a fetched title, and skips the fetch', async () => {
    mockTitle('Kinkolino Forgejo')

    // Chat markdown passes authored link text as `fallbackLabel`, not `label`.
    render(<PrettyLink fallbackLabel="FJ #101" href={FORGEJO_URL} />)

    const link = screen.getByTitle(FORGEJO_URL)

    await waitFor(() => {
      expect(link.textContent).toContain('FJ #101')
    })
    expect(link.textContent).not.toContain('Kinkolino Forgejo')
    expect(titleCalls()).toHaveLength(0)
  })

  it('still resolves a title when no label was authored', async () => {
    mockTitle('Homelab Ops Issue 101')

    render(<PrettyLink href={FORGEJO_URL} />)

    await waitFor(() => {
      expect(screen.getByTitle(FORGEJO_URL).textContent).toContain('Homelab Ops Issue 101')
    })
    expect(titleCalls()).toHaveLength(1)
  })

  it('normalizes scheme-less links before opening', () => {
    render(<LinkifiedText text="Source expedia.com/things-to-do/puerto-rico-el-yunque-rainforest-adventure" />)

    expect(screen.getByRole('link').getAttribute('href')).toBe(
      'https://expedia.com/things-to-do/puerto-rico-el-yunque-rainforest-adventure'
    )
  })

  it('explicitOnly skips bare filename/domain tokens and only links explicit URLs', () => {
    render(
      <LinkifiedText
        explicitOnly
        pretty={false}
        text={'Report  https://paste.rs/abc\nagent.log  https://paste.rs/def\nerrors.log'}
      />
    )

    const links = screen.getAllByRole('link')
    expect(links.map(a => a.getAttribute('href'))).toEqual(['https://paste.rs/abc', 'https://paste.rs/def'])
    // Bare filename-shaped tokens stay as plain text, not links.
    expect(screen.queryByText(content => content.includes('agent.log'))).toBeTruthy()
    expect(links.some(a => (a.textContent ?? '').includes('.log'))).toBe(false)
  })

  it('without explicitOnly, bare filename tokens are still linkified (default behavior)', () => {
    render(<LinkifiedText pretty={false} text="open agent.log please" />)

    expect(screen.getByRole('link', { name: 'agent.log' }).getAttribute('href')).toBe('https://agent.log')
  })

  it('prefixes a pretty link to a known host with its brand glyph', () => {
    const url = 'https://github.com/NousResearch/hermes-agent/pull/123'

    render(<PrettyLink fallbackLabel="#123" href={url} />)

    const link = screen.getByTitle(url)

    expect(link.querySelector('svg')).toBeTruthy()
    // The glyph is decorative — it must not pollute the link's accessible name.
    expect(link.textContent).toBe('#123')
  })

  it('renders no brand glyph for an unknown host', () => {
    const url = 'https://example.com/some/page'

    render(<PrettyLink fallbackLabel="Some Page" href={url} />)

    expect(screen.getByTitle(url).querySelector('svg')).toBeNull()
  })
})
