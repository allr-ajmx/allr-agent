import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CronJob } from '@/types/hermes'

const job = (over: Partial<CronJob>): CronJob => ({ id: 'x', enabled: true, ...over })

vi.mock('@/hermes', () => ({
  getCronJobs: vi.fn(async () => [
    job({ id: 'a', name: 'A', enabled: true }),
    job({ id: 'b', name: 'B', enabled: false })
  ]),
  triggerCronJob: vi.fn(async (id: string) => job({ id, name: 'triggered' }))
}))

vi.mock('@/store/notifications', () => ({ notifyError: vi.fn() }))

import { getCronJobs, triggerCronJob } from '@/hermes'
import { notifyError } from '@/store/notifications'

import { $cronJobs, refreshCronJobs, triggerCron, updateCronJobs } from './cron'

const list = vi.mocked(getCronJobs)
const trigger = vi.mocked(triggerCronJob)
const errored = vi.mocked(notifyError)

describe('cron store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    $cronJobs.set([])
  })
  afterEach(() => $cronJobs.set([]))

  it('loads the job list', async () => {
    await refreshCronJobs()
    expect($cronJobs.get().map(j => j.id)).toEqual(['a', 'b'])
  })

  it('scopes the listing to the profile it is given', async () => {
    await refreshCronJobs('all')
    expect(list).toHaveBeenCalledWith('all')
  })

  // The poll runs on a timer: a failing tick must leave the last good list on
  // screen (and stay quiet) rather than blanking the sidebar section.
  it('keeps the last good list when a refresh fails', async () => {
    await refreshCronJobs()
    list.mockRejectedValueOnce(new Error('gateway down'))

    await refreshCronJobs()

    expect($cronJobs.get().map(j => j.id)).toEqual(['a', 'b'])
    expect(errored).not.toHaveBeenCalled()
  })

  it('replaces just the triggered job with what the server returned', async () => {
    await refreshCronJobs()

    await triggerCron('a')

    expect(trigger).toHaveBeenCalledWith('a')
    expect($cronJobs.get().map(j => j.name)).toEqual(['triggered', 'B'])
  })

  // A failed trigger IS worth a toast (the user pressed a button), and its
  // message must come from the catalog — this path used to raise a hardcoded
  // English string on every locale.
  it('reports a failed trigger with a translated message', async () => {
    await refreshCronJobs()
    trigger.mockRejectedValueOnce(new Error('nope'))

    await triggerCron('a')

    expect(errored).toHaveBeenCalledWith(expect.any(Error), 'Failed to trigger cron job')
    expect($cronJobs.get().map(j => j.name)).toEqual(['A', 'B'])
  })

  it('edits the list in place for the overlay', async () => {
    await refreshCronJobs()

    updateCronJobs(rows => rows.filter(row => row.id !== 'a'))

    expect($cronJobs.get().map(j => j.id)).toEqual(['b'])
  })
})
