/**
 * The cron surface's delivery half, mounted (MJXHRM-397).
 *
 * The pure rules live in `cron-job-model.test.ts`; what this file pins is that
 * the DETAIL PANE actually renders them — every target of a fanned-out job,
 * from whichever shape the job stored them in.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CronJob } from '@/types/hermes'

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

function renderCron(job: CronJob) {
  hermes.getCronJobs.mockImplementation(async () => [job])

  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/cron']}>
        <CronView onClose={() => undefined} />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

/** The value cell of the detail pane's "Deliver to" row. */
async function deliverRow(): Promise<string> {
  const label = await screen.findByText('Deliver to')

  return label.nextElementSibling?.textContent ?? ''
}

beforeEach(() => {
  $cronJobs.set([])
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  $cronJobs.set([])
})

describe('cron detail delivery summary', () => {
  it('names every target of a fanned-out job', async () => {
    renderCron({ deliver: 'local,telegram', enabled: true, id: 'fan', name: 'Fan out' })

    await waitFor(async () => expect(await deliverRow()).toBe('This desktop, Telegram'))
  })

  it('reads a job whose stored deliver is still the legacy list', async () => {
    renderCron({ deliver: ['telegram', 'discord'], enabled: true, id: 'legacy', name: 'Legacy list' })

    // Not 'This desktop': treating the list as unreadable would show the job
    // as local-only and then save that back over its real routes.
    await waitFor(async () => expect(await deliverRow()).toBe('Telegram, Discord'))
  })
})
