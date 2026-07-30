import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { DropdownMenu, DropdownMenuContent } from '@/components/ui/dropdown-menu'
import { I18nProvider } from '@/i18n'
import type { ModelOptionsResponse } from '@/types/hermes'

// The panel fetches its catalog through requestModelOptions (gateway-first);
// mock it so tests drive the provider list directly.
const requestModelOptions = vi.fn<() => Promise<ModelOptionsResponse>>()

vi.mock('@/lib/model-options', () => ({
  requestModelOptions: (...args: unknown[]) => requestModelOptions(...(args as []))
}))

import { $sessionId } from '@/store/chat'
import { $currentModel, $currentProvider } from '@/store/model'
import { $collapsedProviders, toggleCollapsedProvider } from '@/store/provider-collapse'

import { ModelMenuPanel } from './model-menu-panel'

// Radix calls these on open; jsdom doesn't implement them.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.releasePointerCapture = vi.fn()
})

const DEEPSEEK_PROVIDER = {
  models: ['deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'],
  name: 'DeepSeek',
  slug: 'deepseek'
}

const GOOGLE_PROVIDER = {
  models: ['gemini-3.1-pro', 'gemini-2.5-flash', 'gemini-2.5-pro'],
  name: 'Google',
  slug: 'google'
}

const MOCK_PROVIDERS = [DEEPSEEK_PROVIDER, GOOGLE_PROVIDER]

beforeEach(() => {
  $sessionId.set('runtime-1')
  $currentModel.set('')
  $currentProvider.set('')
  $collapsedProviders.set([])
  requestModelOptions.mockResolvedValue({ providers: MOCK_PROVIDERS } as ModelOptionsResponse)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderPanel(onSelectModel = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  const content = render(
    <I18nProvider>
      <QueryClientProvider client={client}>
        <DropdownMenu open>
          <DropdownMenuContent>
            <ModelMenuPanel onSelectModel={onSelectModel} requestGateway={vi.fn() as never} />
          </DropdownMenuContent>
        </DropdownMenu>
      </QueryClientProvider>
    </I18nProvider>
  )

  return { content, onSelectModel }
}

describe('ModelMenuPanel provider collapse', () => {
  it('shows all provider models by default (none collapsed)', async () => {
    const { content } = renderPanel()

    await content.findByText('DeepSeek')
    expect(content.queryByText('Deepseek V4 Pro')).not.toBeNull()
    expect(content.queryByText('Deepseek Chat')).not.toBeNull()
  })

  it('collapses provider models when the header is clicked', async () => {
    const { content } = renderPanel()

    const header = await content.findByText('DeepSeek')
    fireEvent.click(header)

    // Models disappear but the header stays.
    expect(content.queryByText('Deepseek V4 Pro')).toBeNull()
    expect(content.queryByText('DeepSeek')).not.toBeNull()
  })

  it('expands provider models when the header is clicked again', async () => {
    const { content } = renderPanel()

    const header = await content.findByText('DeepSeek')
    fireEvent.click(header)
    expect(content.queryByText('Deepseek V4 Pro')).toBeNull()

    fireEvent.click(header)
    await vi.waitFor(() => {
      expect(content.queryByText('Deepseek V4 Pro')).not.toBeNull()
    })
  })

  it('collapses the active provider too (no forced auto-expand)', async () => {
    $currentProvider.set('deepseek')
    $currentModel.set('deepseek-v4-pro')
    const { content } = renderPanel()

    const header = await content.findByText('DeepSeek')
    fireEvent.click(header)

    // The current provider is collapsible like any other — clicking its header
    // hides its models rather than forcing them to stay open.
    await vi.waitFor(() => {
      expect(content.queryByText('Deepseek V4 Pro')).toBeNull()
    })
  })

  it('bypasses collapse when search is active', async () => {
    const { content } = renderPanel()

    const header = await content.findByText('DeepSeek')
    fireEvent.click(header)
    expect(content.queryByText('Deepseek V4 Pro')).toBeNull()

    // Type in the search bar (auto-focused by DropdownMenuSearch).
    const input = screen.getByRole('textbox', { name: 'Search models' })
    fireEvent.change(input, { target: { value: 'deepseek' } })

    // Search spans every model regardless of stored collapse state.
    await vi.waitFor(() => {
      expect(content.queryByText('Deepseek V4 Pro')).not.toBeNull()
    })
  })

  it('toggles collapse via keyboard Enter on the header', async () => {
    const { content } = renderPanel()

    const header = await content.findByText('DeepSeek')
    // Radix DropdownMenuItem fires onSelect on Enter via the onKeyDown handler.
    fireEvent.keyDown(header.closest('[role="menuitem"]') ?? header, { key: 'Enter' })

    expect(content.queryByText('Deepseek V4 Pro')).toBeNull()
  })

  // The collapsed set is a global presentation preference
  // (`hermes.collapsed-providers`), but the catalog the picker renders is
  // profile-scoped. Pruning the global set against only the active catalog
  // would silently delete a collapse preference on every profile switch whose
  // configured providers don't include the slug. The set must survive catalog
  // changes; if the provider shows up again later, the collapse is preserved.
  it('preserves the collapsed set across a catalog that lacks the slug', async () => {
    toggleCollapsedProvider('deepseek')
    toggleCollapsedProvider('google')
    expect($collapsedProviders.get()).toEqual(['deepseek', 'google'])

    // Catalog A: both providers present, render + unmount.
    requestModelOptions.mockResolvedValueOnce({ providers: MOCK_PROVIDERS } as ModelOptionsResponse)
    const a = renderPanel()
    await a.content.findByText('DeepSeek')
    a.content.unmount()

    // Catalog B: google dropped (profile switch / revoked key). The
    // previously-collapsed 'google' slug must survive.
    requestModelOptions.mockResolvedValueOnce({ providers: [DEEPSEEK_PROVIDER] } as ModelOptionsResponse)
    const b = renderPanel()
    await b.content.findByText('DeepSeek')

    expect($collapsedProviders.get()).toEqual(['deepseek', 'google'])
  })
})
