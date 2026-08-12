/**
 * The other half of "Manage opens THIS job" (MJXHRM-377): the cron surface
 * reading the job out of its own route.
 *
 * The gate on `loading` is the Android case in one assertion — opened as a
 * native screen activity this view boots in a FRESH WebView whose job list is
 * still empty, so a focus resolved on the first render would resolve against
 * nothing and be thrown away. Here the list also arrives late (the fetch is a
 * promise), so removing that gate fails this test.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CronJob } from '@/types/hermes'

const jobs: CronJob[] = [
  { enabled: true, id: 'alpha-job', name: 'Alpha backup' },
  { enabled: true, id: 'zulu-job', name: 'Zulu digest' }
]

const hermes = vi.hoisted(() => ({
  createCronJob: vi.fn(),
  deleteCronJob: vi.fn(),
  getAutomationBlueprints: vi.fn(async () => []),
  getCronDeliveryTargets: vi.fn(async () => []),
  getCronJobRuns: vi.fn(async () => []),
  getCronJobs: vi.fn(),
  instantiateAutomationBlueprint: vi.fn(),
  pauseCronJob: vi.fn(),
  resumeCronJob: vi.fn(),
  // Reached at import time through store/profile → store/profiles.
  setApiRequestProfile: vi.fn(),
  triggerCronJob: vi.fn(),
  updateCronJob: vi.fn()
}))

vi.mock('@/hermes', () => hermes)

import { $cronJobs } from '@/store/cron'

import { CronView } from './index'

function renderCron(route: string) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[route]}>
        <CronView onClose={() => undefined} />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

/** The detail pane's heading — the job the surface actually opened on. */
const openedJob = () => screen.getByRole('heading', { level: 3 }).textContent

beforeEach(() => {
  $cronJobs.set([])
  // Resolve on a later tick, like a real fetch: the view renders empty first.
  hermes.getCronJobs.mockImplementation(async () => jobs)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  $cronJobs.set([])
})

describe('cron surface focus', () => {
  it('opens the job named in the route, not the first one', async () => {
    renderCron('/cron?job=zulu-job')

    // 'Alpha backup' is what this surface selects on its own (it sorts first),
    // so landing on 'Zulu digest' can only come from the route.
    await waitFor(() => expect(openedJob()).toBe('Zulu digest'))
  })

  it('accepts a job NAME as well as an id', async () => {
    renderCron(`/cron?job=${encodeURIComponent('Zulu digest')}`)

    await waitFor(() => expect(openedJob()).toBe('Zulu digest'))
  })

  it('falls back to its own selection when the route names nothing', async () => {
    renderCron('/cron')

    await waitFor(() => expect(openedJob()).toBe('Alpha backup'))
  })

  it('falls back when the route names a job that is gone', async () => {
    renderCron('/cron?job=deleted-job')

    await waitFor(() => expect(openedJob()).toBe('Alpha backup'))
  })
})
