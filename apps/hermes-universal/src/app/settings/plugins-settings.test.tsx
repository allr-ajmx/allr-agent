import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as PluginDiskModule from '@/contrib/plugin-disk'
import type * as PluginsStoreModule from '@/contrib/plugins-store'
import type * as AgentPluginsModule from '@/store/agent-plugins'

const resolvePluginDisk = vi.hoisted(() => vi.fn())
const discoverRuntimePlugins = vi.hoisted(() => vi.fn())
const reveal = vi.hoisted(() => vi.fn(async () => {}))
const toggleAgentPlugin = vi.hoisted(() => vi.fn())

vi.mock('@/contrib/runtime-loader', () => ({ discoverRuntimePlugins }))
vi.mock('@/contrib/plugin-disk', async importActual => {
  const actual = await importActual<typeof PluginDiskModule>()

  return { ...actual, resolvePluginDisk }
})

// Only the RPC edge is stubbed: the atoms below are the real ones, so what the
// section renders is driven by real store state. `$gatewayState` stays 'idle' in
// vitest, so the section's load effect never fires over the fixtures.
vi.mock('@/store/agent-plugins', async importActual => {
  const actual = await importActual<typeof AgentPluginsModule>()

  return { ...actual, toggleAgentPlugin }
})

import { $restDoorEnabled } from '@/contrib/plugin-disk'
import { $pluginRecords, type PluginRecord, setPluginEnabled } from '@/contrib/plugins-store'
import { I18nProvider } from '@/i18n'
import {
  $agentPluginBusy,
  $agentPlugins,
  $agentPluginsError,
  $agentPluginsStatus,
  type AgentPluginRow,
  resetAgentPlugins
} from '@/store/agent-plugins'
import { $connection } from '@/store/connection'

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

// Every field the backend's `plugins.manage list` row carries, defaulted to a
// keyed user plugin; tests override only what they are about.
const agentRow = (over: Partial<AgentPluginRow> = {}): AgentPluginRow => ({
  description: 'Generates images',
  key: 'image_gen/fal',
  name: 'fal',
  source: 'user',
  status: 'enabled',
  version: '1.0.0',
  ...over
})

/** Put the section in its loaded state with `rows`, bypassing the RPC. */
const loadedWith = (rows: AgentPluginRow[]) => {
  $agentPlugins.set(rows)
  $agentPluginsStatus.set('ready')
}

beforeEach(() => {
  $pluginRecords.set({})
  $restDoorEnabled.set(true)
  resetAgentPlugins()
  resolvePluginDisk.mockResolvedValue(localDoor)
})

afterEach(() => {
  $pluginRecords.set({})
  $connection.set(null)
  resetAgentPlugins()
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

// The BACKEND half of the page. Every kind of row `plugins.manage list` can
// return has to arrive here — including the ones an older backend returns
// without a canonical key, which used to throw inside render and take the whole
// Plugins page down rather than degrading one row.
describe('PluginsSettings ▸ agent plugins', () => {
  it('renders every source the backend reports, with its real on/off state', async () => {
    loadedWith([
      agentRow({ key: 'image_gen/fal', name: 'fal', source: 'user', status: 'enabled' }),
      agentRow({ key: 'kanban', name: 'kanban', source: 'git', status: 'disabled' }),
      agentRow({ key: 'web', name: 'web', source: 'bundled', status: 'not enabled' }),
      agentRow({ key: 'acme', name: 'acme', source: 'entrypoint', status: 'enabled' })
    ])
    renderPage()

    expect(await screen.findByText('fal')).toBeInTheDocument()

    for (const label of ['user', 'git', 'bundled', 'pip']) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }

    expect(screen.getByRole('switch', { name: 'Disable fal' })).toBeChecked()
    expect(screen.getByRole('switch', { name: 'Enable kanban' })).not.toBeChecked()
    // 'not enabled' is OFF, not a third visual state.
    expect(screen.getByRole('switch', { name: 'Enable web' })).not.toBeChecked()
    expect(screen.getByRole('switch', { name: 'Disable acme' })).toBeChecked()
  })

  // What the user installed themselves comes first and the always-there bundled
  // set comes last — the same order `hermes plugins list` uses.
  it('puts user plugins first and bundled ones last', async () => {
    loadedWith([
      agentRow({ key: 'web', name: 'web', source: 'bundled' }),
      agentRow({ key: 'acme', name: 'acme', source: 'entrypoint' }),
      agentRow({ key: 'image_gen/fal', name: 'fal', source: 'user' })
    ])
    renderPage()

    await screen.findByText('fal')

    const rendered = document.body.textContent ?? ''
    expect(rendered.indexOf('fal')).toBeLessThan(rendered.indexOf('acme'))
    expect(rendered.indexOf('acme')).toBeLessThan(rendered.indexOf('web'))
  })

  it('marks the Agent Plugins v1 packages as portable', async () => {
    loadedWith([agentRow({ portable: true })])
    renderPage()

    expect(await screen.findByText('portable')).toBeInTheDocument()
  })

  // A pre-contract-v6 backend sends no `key`. Reading `.startsWith` off it threw
  // during render, so ONE legacy row blanked the entire page.
  it('keeps a keyless row, read-only, and says why', async () => {
    loadedWith([agentRow({ key: undefined, name: 'legacy' })])
    renderPage()

    expect(await screen.findByText('legacy')).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Disable legacy' })).toBeDisabled()
    expect(screen.getByText('Update the Hermes backend to turn this one on or off from here.')).toBeInTheDocument()
  })

  // `busy === row.key` compares undefined to undefined, so an unrelated in-flight
  // toggle used to grey out every keyless row at once.
  it('greys out only the row whose toggle is in flight', async () => {
    loadedWith([
      agentRow({ key: 'image_gen/fal', name: 'fal' }),
      agentRow({ key: 'kanban', name: 'kanban' }),
      agentRow({ key: undefined, name: 'legacy' })
    ])
    $agentPluginBusy.set('image_gen/fal')
    renderPage()

    expect(await screen.findByRole('switch', { name: 'Disable fal' })).toBeDisabled()
    expect(screen.getByRole('switch', { name: 'Disable kanban' })).not.toBeDisabled()
  })

  // Names collide across category dirs; the canonical key is what disambiguates
  // them, and the click must carry the key of the row it landed on.
  it('toggles the row that was clicked, not the one that sorts first', async () => {
    loadedWith([
      agentRow({ key: 'image_gen/fal', name: 'fal', source: 'user' }),
      agentRow({ key: 'video_gen/fal', name: 'fal', source: 'git' })
    ])
    renderPage()

    const switches = await screen.findAllByRole('switch', { name: 'Disable fal' })

    fireEvent.click(switches[1]!)

    expect(toggleAgentPlugin).toHaveBeenCalledTimes(1)
    expect(toggleAgentPlugin).toHaveBeenCalledWith(expect.anything(), 'video_gen/fal', false, 'Could not toggle fal')
  })

  // Both guards together, deliberately: the `disabled` switch is what stops the
  // click, and the `if (!key) return` inside the handler is unreachable from the
  // DOM while it holds — so no test can tell that guard apart on its own. What
  // this pins is the invariant they jointly own.
  it('does not send a toggle for a row it cannot address', async () => {
    loadedWith([agentRow({ key: undefined, name: 'legacy' })])
    renderPage()

    fireEvent.click(await screen.findByRole('switch', { name: 'Disable legacy' }))

    expect(toggleAgentPlugin).not.toHaveBeenCalled()
  })

  // Without a key there is no unique React identity, and two same-named keyless
  // rows would share one — which is how a list starts showing the wrong row's
  // state after a re-sort.
  it('gives same-named keyless rows distinct identities', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})

    loadedWith([
      agentRow({ description: 'the old one', key: undefined, name: 'fal', version: '1.0.0' }),
      agentRow({ description: 'the new one', key: undefined, name: 'fal', version: '2.0.0' })
    ])
    renderPage()

    expect(await screen.findAllByRole('switch', { name: 'Disable fal' })).toHaveLength(2)
    expect(warn.mock.calls.flat().join(' ')).not.toMatch(/same key/i)

    warn.mockRestore()
  })

  it('hides the categories other surfaces own', async () => {
    loadedWith([
      agentRow({ key: 'model-providers/openai', name: 'openai' }),
      agentRow({ key: 'platforms/slack', name: 'slack' }),
      agentRow({ key: 'dashboard_auth/basic', name: 'basic' }),
      agentRow({ key: 'kanban', name: 'kanban' })
    ])
    renderPage()

    expect(await screen.findByText('kanban')).toBeInTheDocument()
    expect(screen.queryByText('openai')).not.toBeInTheDocument()
    expect(screen.queryByText('slack')).not.toBeInTheDocument()
    expect(screen.queryByText('basic')).not.toBeInTheDocument()
  })

  it('searches name, key and description without tripping over a keyless row', async () => {
    loadedWith([
      agentRow({ description: 'Generates images', key: 'image_gen/fal', name: 'fal' }),
      agentRow({ description: 'A board', key: 'kanban', name: 'kanban' }),
      agentRow({ description: 'no key here', key: undefined, name: 'legacy' })
    ])
    renderPage()

    const search = await screen.findByPlaceholderText('Search plugins…')

    fireEvent.change(search, { target: { value: 'image_gen' } })
    expect(screen.getByText('fal')).toBeInTheDocument()
    expect(screen.queryByText('kanban')).not.toBeInTheDocument()
    expect(screen.queryByText('legacy')).not.toBeInTheDocument()

    fireEvent.change(search, { target: { value: 'no key' } })
    expect(screen.getByText('legacy')).toBeInTheDocument()

    // A query that matches nothing is not the same as having nothing installed.
    fireEvent.change(search, { target: { value: 'zzzz' } })
    expect(screen.getByText('No plugins match your search.')).toBeInTheDocument()
    expect(screen.queryByText('No agent plugins installed yet.')).not.toBeInTheDocument()
  })

  it('surfaces a load failure instead of an endless skeleton', async () => {
    $agentPluginsStatus.set('error')
    $agentPluginsError.set('gateway down')
    renderPage()

    expect(await screen.findByText('Could not load agent plugins')).toBeInTheDocument()
    expect(screen.getByText('gateway down')).toBeInTheDocument()
  })

  // Revealing a folder is an OS file-manager act with no mobile/plain-web
  // equivalent, and the native call fails silently — so the affordance must not
  // exist here rather than being a click that reports nothing.
  it('offers no Open folder button for the backend plugins off desktop', async () => {
    // A local connection is the ONE state that would otherwise show it, so the
    // assertion has to be made from there — with no connection the button is
    // already hidden for an unrelated reason.
    $connection.set({ authMode: 'token', baseUrl: 'http://127.0.0.1:8765', mode: 'local' })
    loadedWith([agentRow()])
    renderPage()

    await screen.findByText('fal')
    // Exactly one — the client half's, for the local door. A second would be the
    // agent section's, which cannot work on this platform (jsdom is not Tauri,
    // and neither is Android or iOS).
    expect(screen.getAllByRole('button', { name: /Open plugins folder/ })).toHaveLength(1)
  })
})
