/**
 * MJXHRM-408. The config support floor is ONE rule and the gateway owns it —
 * `/api/status` reports `config_floor_warning`. The client kept an
 * approximation only for gateways predating the field, and that approximation
 * had drifted from the backend's `below_support_floor()`.
 *
 * Nothing covered this surface before: the verdict function had no test at all,
 * so neither the "prefer the gateway" rule nor the fallback could fail.
 */

import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getStatus = vi.hoisted(() => vi.fn())
const getLogs = vi.hoisted(() => vi.fn())

vi.mock('@/hermes', () => ({ getLogs, getStatus }))
vi.mock('@/store/windows', () => ({ openSystemScreen: vi.fn() }))

import { I18nProvider } from '@/i18n'
import type { StatusResponse } from '@/types/hermes'

import { configFloorVerdict, GatewayDiagnostics } from './gateway-diagnostics'

/** A modern gateway's status: current config, floor verdict reported. */
function statusOf(overrides: Partial<StatusResponse> = {}): StatusResponse {
  return {
    active_sessions: 0,
    config_floor_warning: { below_floor: false, support_floor_version: 12 },
    config_version: 34,
    gateway_exit_reason: null,
    gateway_platforms: {},
    gateway_running: true,
    gateway_state: 'running',
    gateway_updated_at: null,
    hermes_home: '/home/alice/.hermes',
    latest_config_version: 34,
    release_date: '2026-08-01',
    version: '1.2.3',
    ...overrides
  }
}

describe('configFloorVerdict — the gateway decides', () => {
  // Every case here reports a verdict the client's own arithmetic would NOT
  // reach. A case where the two agree proves nothing: it passes just as well
  // against a client that ignores the field entirely, which is the bug.
  it('takes the reported floor version even when it has moved off the client literal', () => {
    // The whole point of shipping the floor: the client must not need a release
    // to follow the backend's policy.
    expect(
      configFloorVerdict(
        statusOf({ config_floor_warning: { below_floor: true, support_floor_version: 20 }, config_version: 15 })
      )
    ).toEqual({ below: true, floor: 20 })
  })

  it('trusts a reported "not below" over its own arithmetic', () => {
    // A literal `_config_version: 0` vs. a missing key: only the gateway can
    // tell those apart, and it says this one is fine.
    expect(
      configFloorVerdict(
        statusOf({ config_floor_warning: { below_floor: false, support_floor_version: 12 }, config_version: 3 })
      ).below
    ).toBe(false)
  })

  it('trusts a reported "below" even for a config the client would pass', () => {
    expect(
      configFloorVerdict(
        statusOf({ config_floor_warning: { below_floor: true, support_floor_version: 40 }, config_version: 34 })
      ).below
    ).toBe(true)
  })
})

describe('configFloorVerdict — fallback for a gateway predating the field', () => {
  const legacy = (overrides: Partial<StatusResponse>) =>
    configFloorVerdict(statusOf({ config_floor_warning: undefined, ...overrides }))

  it('warns about an explicitly ancient config', () => {
    expect(legacy({ config_version: 11, latest_config_version: 34 })).toEqual({ below: true, floor: 12 })
  })

  it('does not warn at the floor itself', () => {
    expect(legacy({ config_version: 12, latest_config_version: 34 }).below).toBe(false)
  })

  it('does not warn on version 0, which is also how a missing key arrives', () => {
    expect(legacy({ config_version: 0, latest_config_version: 34 }).below).toBe(false)
  })

  it('does not warn when the gateway has nothing newer to migrate to', () => {
    // `below_support_floor()` is `current < floor AND current < latest`. A
    // gateway old enough to omit the field can have a `latest` below 12 of its
    // own; its config is current and there is no migration to offer.
    expect(legacy({ config_version: 5, latest_config_version: 5 }).below).toBe(false)
    expect(legacy({ config_version: 6, latest_config_version: 5 }).below).toBe(false)
  })

  it('still warns when the old gateway does have a newer schema', () => {
    expect(legacy({ config_version: 5, latest_config_version: 11 }).below).toBe(true)
  })

  it('treats an explicit null the same as an absent field', () => {
    expect(configFloorVerdict(statusOf({ config_floor_warning: null, config_version: 11 })).below).toBe(true)
  })
})

describe('GatewayDiagnostics banner', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getLogs.mockResolvedValue({ lines: [] })
  })

  const renderPanel = () =>
    render(
      <I18nProvider>
        <GatewayDiagnostics />
      </I18nProvider>
    )

  it('shows the remediation banner while the gateway reports below-floor', async () => {
    getStatus.mockResolvedValue(
      statusOf({ config_floor_warning: { below_floor: true, support_floor_version: 12 }, config_version: 11 })
    )
    renderPanel()
    expect(await screen.findByText(/Config v11 predates the v12 support floor/)).toBeInTheDocument()
  })

  it('shows nothing once the config is fixed — the banner is not sticky', async () => {
    getStatus.mockResolvedValue(statusOf())
    renderPanel()
    // Wait for the readout, then assert the banner is absent alongside it,
    // so this cannot pass by merely rendering before the fetch resolves.
    expect(await screen.findByText(/config v34/)).toBeInTheDocument()
    expect(screen.queryByText(/support floor/)).not.toBeInTheDocument()
  })

  it('drops the hermes-home segment, separator and all, when a gated gateway withholds it', async () => {
    getStatus.mockResolvedValue(statusOf({ hermes_home: undefined }))
    renderPanel()
    const readout = await screen.findByText(/config v34/)
    // JSX renders the absent value as nothing, so the visible symptom was a
    // headless " · config v34" — the separator has to go with the segment.
    expect(readout.textContent).toBe('config v34')
  })

  it('keeps the hermes home when the gateway does report it', async () => {
    getStatus.mockResolvedValue(statusOf())
    renderPanel()
    const readout = await screen.findByText(/config v34/)
    expect(readout.textContent).toBe('/home/alice/.hermes · config v34')
  })
})
