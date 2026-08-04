import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as PluginDiskModule from '@/contrib/plugin-disk'
import type * as PluginsStoreModule from '@/contrib/plugins-store'

const resolvePluginDisk = vi.hoisted(() => vi.fn())
const discoverRuntimePlugins = vi.hoisted(() => vi.fn())
const reveal = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('@/contrib/runtime-loader', () => ({ discoverRuntimePlugins }))
vi.mock('@/contrib/plugin-disk', async importActual => {
  const actual = await importActual<typeof PluginDiskModule>()

  return { ...actual, resolvePluginDisk }
})

import { $restDoorEnabled } from '@/contrib/plugin-disk'
import { $pluginRecords, type PluginRecord, setPluginEnabled } from '@/contrib/plugins-store'
import { I18nProvider } from '@/i18n'

import { PluginsSettings } from './plugins-settings'

vi.mock('@/contrib/plugins-store', async importActual => {
  const actual = await importActual<typeof PluginsStoreModule>()

  return { ...actual, setPluginEnabled: vi.fn() }
})

const localDoor = { kind: 'local' as const, reveal, root: async () => '/home/u/.hermes/desktop-plugins' }
const gatewayDoor = { kind: 'rest' as const, root: async () => '/srv/hermes/desktop-plugins' }

const record = (over: Partial<PluginRecord> & { id: string }): PluginRecord => ({
  kind: 'disk',
  name: over.id,
  status: 'loaded',
  ...over
})

const renderPage = () =>
  render(
    <MemoryRouter>
      <I18nProvider>
        <PluginsSettings />
      </I18nProvider>
    </MemoryRouter>
  )

beforeEach(() => {
  $pluginRecords.set({})
  $restDoorEnabled.set(true)
  resolvePluginDisk.mockResolvedValue(localDoor)
})

afterEach(() => {
  $pluginRecords.set({})
  vi.clearAllMocks()
})

describe('PluginsSettings', () => {
  it('shows the empty state with no plugins', async () => {
    renderPage()

    expect(await screen.findByText('No plugins installed yet.')).toBeInTheDocument()
  })

  it('lists a plugin with its kind, and toggles it live', async () => {
    $pluginRecords.set({ kanban: record({ id: 'kanban', name: 'Kanban' }) })
    renderPage()

    expect(await screen.findByText('Kanban')).toBeInTheDocument()
    expect(screen.getByText('on disk')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('switch', { name: /Disable Kanban/ }))

    expect(setPluginEnabled).toHaveBeenCalledWith('kanban', false)
  })

  it('surfaces a failed plugin with its error', async () => {
    $pluginRecords.set({ bad: record({ error: 'unsupported import: lodash', id: 'bad', status: 'error' }) })
    renderPage()

    expect(await screen.findByText('failed')).toBeInTheDocument()
    expect(screen.getByText('unsupported import: lodash')).toBeInTheDocument()
  })

  // The dual door is invisible otherwise: two machines' plugin folders look
  // identical in the list.
  it('names the active door and its root', async () => {
    renderPage()

    expect(await screen.findByText('Reading from this device')).toBeInTheDocument()
    expect(screen.getByText('/home/u/.hermes/desktop-plugins')).toBeInTheDocument()
  })

  it('names the gateway door when that is what is in force', async () => {
    resolvePluginDisk.mockResolvedValue(gatewayDoor)
    renderPage()

    expect(await screen.findByText('Reading from the connected backend')).toBeInTheDocument()
    expect(screen.getByText('/srv/hermes/desktop-plugins')).toBeInTheDocument()
  })

  it('hides Open folder for the gateway door — the path is not on this device', async () => {
    resolvePluginDisk.mockResolvedValue(gatewayDoor)
    renderPage()

    await screen.findByText('Reading from the connected backend')
    expect(screen.queryByRole('button', { name: /Open plugins folder/ })).not.toBeInTheDocument()
  })

  it('reveals the local root', async () => {
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: /Open plugins folder/ }))

    await waitFor(() => expect(reveal).toHaveBeenCalledWith('/home/u/.hermes/desktop-plugins'))
  })

  it('rescans on demand', async () => {
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: /Rescan/ }))

    expect(discoverRuntimePlugins).toHaveBeenCalledOnce()
  })

  it('exposes the gateway-door switch with its authority warning', async () => {
    renderPage()

    const toggle = await screen.findByRole('switch', { name: /Load plugins from the connected backend/ })

    expect(toggle).toBeChecked()
    expect(
      screen.getByText('Plugin code from the backend runs with the same access as the app itself.')
    ).toBeInTheDocument()

    fireEvent.click(toggle)
    expect($restDoorEnabled.get()).toBe(false)
  })

  it('says so when the gateway door is on but the backend has no plugin folder', async () => {
    resolvePluginDisk.mockResolvedValue(null)
    renderPage()

    expect(await screen.findByText('This backend did not report a plugins folder.')).toBeInTheDocument()
    expect(screen.getByText('No plugin folder available')).toBeInTheDocument()
  })

  it('sorts disk plugins before bundled ones, then by name', async () => {
    $pluginRecords.set({
      a: record({ id: 'a', kind: 'bundled', name: 'Alpha' }),
      z: record({ id: 'z', kind: 'disk', name: 'Zeta' })
    })
    renderPage()

    await screen.findByText('Zeta')

    // Name and kind pill live in sibling nodes, so compare document order rather
    // than trying to match a row's combined text.
    const rendered = document.body.textContent ?? ''
    expect(rendered.indexOf('Zeta')).toBeLessThan(rendered.indexOf('Alpha'))
  })
})
