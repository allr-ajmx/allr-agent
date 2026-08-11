import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import type { ModelOptionsResponse } from '@/types/hermes'

// The dialog fetches its catalog through requestModelOptions; mock it so the
// tests drive the provider list directly.
const requestModelOptions = vi.fn<() => Promise<ModelOptionsResponse>>()

vi.mock('@/lib/model-options', () => ({
  modelOptionsQueryKey: (profile: null | string | undefined, sessionId?: null | string) => [
    'model-options',
    (profile ?? '').trim() || 'default',
    sessionId || 'global'
  ],
  requestModelOptions: (...args: unknown[]) => requestModelOptions(...(args as []))
}))

import { $visibleModels } from '@/store/model-visibility'
import { $collapsedProviders } from '@/store/provider-collapse'

import { ModelVisibilityDialog } from './model-visibility-dialog'

// Radix calls these on open; jsdom doesn't implement them.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.releasePointerCapture = vi.fn()
})

const DEEPSEEK = {
  models: ['deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'],
  name: 'DeepSeek',
  slug: 'deepseek'
}

beforeEach(() => {
  $visibleModels.set(null)
  $collapsedProviders.set([])
  requestModelOptions.mockResolvedValue({ providers: [DEEPSEEK] } as ModelOptionsResponse)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  $visibleModels.set(null)
})

function renderDialog(props: Partial<Parameters<typeof ModelVisibilityDialog>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  return render(
    <I18nProvider>
      <QueryClientProvider client={client}>
        <ModelVisibilityDialog onOpenChange={vi.fn()} open {...props} />
      </QueryClientProvider>
    </I18nProvider>
  )
}

// The switch that owns one model row, found through the row's label text.
const rowSwitch = (label: string): HTMLElement => {
  const row = screen.getByText(label).closest('label')

  if (!row) {
    throw new Error(`no row for ${label}`)
  }

  const control = row.querySelector('[data-slot="switch"]')

  if (!control) {
    throw new Error(`no switch in the ${label} row`)
  }

  return control as HTMLElement
}

describe('Edit models select-all', () => {
  it('reads checked when every model of a provider is on', async () => {
    const { findByLabelText } = renderDialog()

    expect(await findByLabelText('DeepSeek')).toHaveAttribute('data-state', 'checked')
  })

  it('reads indeterminate once one model is switched off', async () => {
    const { findByLabelText } = renderDialog()

    await findByLabelText('DeepSeek')
    fireEvent.click(rowSwitch('Deepseek Chat'))

    await vi.waitFor(async () => {
      expect(await findByLabelText('DeepSeek')).toHaveAttribute('data-state', 'indeterminate')
    })
  })

  it('round-trips off then on across the whole provider', async () => {
    const { findByLabelText } = renderDialog()

    fireEvent.click(await findByLabelText('DeepSeek'))

    await vi.waitFor(() => {
      expect(rowSwitch('Deepseek V4 Pro')).toHaveAttribute('data-state', 'unchecked')
      expect(rowSwitch('Deepseek Chat')).toHaveAttribute('data-state', 'unchecked')
    })

    fireEvent.click(await findByLabelText('DeepSeek'))

    await vi.waitFor(() => {
      expect(rowSwitch('Deepseek V4 Pro')).toHaveAttribute('data-state', 'checked')
      expect(rowSwitch('Deepseek Chat')).toHaveAttribute('data-state', 'checked')
    })
  })

  it('lists hidden models too — visibility is the switch, not the filter', async () => {
    // Only one model on: the other two must still be listed (this dialog is
    // where a hidden model is found again), just switched off.
    $visibleModels.set(new Set(['deepseek::deepseek-v4-pro']))

    const { findByText } = renderDialog()

    await findByText('Deepseek V4 Pro')
    expect(rowSwitch('Deepseek Chat')).toHaveAttribute('data-state', 'unchecked')
  })
})

describe('Edit models provider hand-off', () => {
  it('offers "Add provider" when the host can show one', async () => {
    const onOpenProviders = vi.fn()
    const { findByText } = renderDialog({ onOpenProviders })

    fireEvent.click(await findByText('Add provider…'))
    expect(onOpenProviders).toHaveBeenCalled()
  })

  it('stands the row down in a host with no provider surface', async () => {
    const { findByText, queryByText } = renderDialog()

    await findByText('DeepSeek')
    expect(queryByText('Add provider…')).toBeNull()
  })
})
