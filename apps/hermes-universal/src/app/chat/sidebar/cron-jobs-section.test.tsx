/**
 * The cron sidebar row's action surface (MJXHRM-377).
 *
 * A phone has no hover and no right-click, so the kebab is the ONLY door to
 * pause / resume / delete there — and a menu that opens on one row while acting
 * on another is worse than no menu at all when the verb is "delete". Both are
 * asserted here; before this file the whole section had no test, so the kebab
 * could be deleted outright and every suite still passed.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CronJob } from '@/types/hermes'

const hermes = vi.hoisted(() => ({
  deleteCronJob: vi.fn(async () => ({ ok: true })),
  getCronJobRuns: vi.fn(async () => []),
  pauseCronJob: vi.fn(async (id: string) => ({ enabled: false, id })),
  resumeCronJob: vi.fn(async (id: string) => ({ enabled: true, id })),
  // Reached at import time through store/session → store/profile → store/profiles.
  setApiRequestProfile: vi.fn()
}))

vi.mock('@/hermes', () => hermes)

import { SidebarCronJobsSection } from './cron-jobs-section'

// Two jobs whose alphabetical order is the REVERSE of their next-run order, so a
// row that acted on "the first job" instead of its own would be caught: the
// section sorts by next run, and the ids don't follow the titles.
const NOW = Date.now()

const job = (over: Partial<CronJob>): CronJob => ({ enabled: true, id: 'x', ...over })

const jobs: CronJob[] = [
  job({ id: 'zulu-job', name: 'Zulu digest', next_run_at: new Date(NOW + 60_000).toISOString() }),
  job({ id: 'alpha-job', name: 'Alpha backup', next_run_at: new Date(NOW + 600_000).toISOString() })
]

function renderSection(overrides: Partial<Parameters<typeof SidebarCronJobsSection>[0]> = {}) {
  const props = {
    jobs,
    label: 'Cron jobs',
    onManageJob: vi.fn(),
    onOpenRun: vi.fn(),
    onTriggerJob: vi.fn(),
    onToggle: vi.fn(),
    open: true,
    ...overrides
  }

  render(<SidebarCronJobsSection {...props} />)

  return props
}

/** Open the kebab belonging to the row whose title is `title`. */
function openRowMenu(title: string) {
  const row = screen.getByText(title).closest('[class*="group/cron"]')!

  const kebab = Array.from(row.querySelectorAll('button')).find(
    button => button.getAttribute('aria-label') === 'Cron job actions'
  )!

  fireEvent.pointerDown(kebab, { button: 0, pointerType: 'mouse' })

  return kebab
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('cron sidebar row actions', () => {
  it('offers every verb in the kebab — the only route a finger has', async () => {
    renderSection()

    openRowMenu('Zulu digest')

    // Trigger and Manage also have their own buttons; pause/resume and delete
    // have nowhere else to be reached from without a right-click.
    expect(await screen.findByRole('menuitem', { name: 'Trigger now' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Pause cron' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Manage' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument()
  })

  // `state` is what the gateway sends for a paused job — `cron/jobs.py`
  // `effective_job_state` turns `enabled: false` into "paused" before the list
  // ever reaches us, so that (not the bare flag) is what the row reads.
  it('offers Resume, not Pause, on a paused job', async () => {
    renderSection({ jobs: [job({ enabled: false, id: 'zulu-job', name: 'Zulu digest', state: 'paused' })] })

    openRowMenu('Zulu digest')

    expect(await screen.findByRole('menuitem', { name: 'Resume cron' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Pause cron' })).not.toBeInTheDocument()
  })

  it('acts on ITS OWN row, not on whichever job the list happens to sort first', async () => {
    const props = renderSection()

    // Both verbs are asked of 'Alpha backup', which the section sorts LAST (it
    // runs later) and the cron surface sorts FIRST (alphabetically). A handler
    // bound to "the first row" instead of its own hits 'Zulu digest' either way.
    openRowMenu('Alpha backup')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Pause cron' }))

    await waitFor(() => expect(hermes.pauseCronJob).toHaveBeenCalledWith('alpha-job'))
    expect(hermes.pauseCronJob).toHaveBeenCalledTimes(1)

    openRowMenu('Alpha backup')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Manage' }))

    expect(props.onManageJob).toHaveBeenCalledWith('alpha-job')
    expect(props.onManageJob).toHaveBeenCalledTimes(1)

    // …and the row's own trigger button, which shares the same prop chain.
    openRowMenu('Zulu digest')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Trigger now' }))

    expect(props.onTriggerJob).toHaveBeenCalledWith('zulu-job')
  })

  it('asks before deleting, and deletes the row it was opened on', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)

    renderSection()
    openRowMenu('Alpha backup')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }))

    // Declined: nothing is destroyed, and the prompt named the right job.
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Alpha backup'))
    expect(hermes.deleteCronJob).not.toHaveBeenCalled()

    confirm.mockReturnValue(true)
    openRowMenu('Alpha backup')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }))

    await waitFor(() => expect(hermes.deleteCronJob).toHaveBeenCalledWith('alpha-job'))

    confirm.mockRestore()
  })

  it('reaches the same actions by right-click, from one shared item set', async () => {
    renderSection()

    const row = screen.getByText('Zulu digest').closest('[class*="group/cron"]')!
    fireEvent.pointerDown(row, { button: 2, pointerType: 'mouse' })
    fireEvent.contextMenu(row, { button: 2 })

    expect(await screen.findByRole('menuitem', { name: 'Trigger now' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Pause cron' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument()
  })

  it('keeps the action cluster visible without hover — the touch layout is the base', () => {
    renderSection()

    const kebab = openRowMenu('Zulu digest')
    const cluster = kebab.parentElement!.className.split(/\s+/)

    // `hidden` must be reachable ONLY through the `fine:` (mouse) variant. A bare
    // `hidden` or a bare `group-hover:` gate would make the cluster — and with it
    // the only touch route to pause/delete — invisible on a phone forever.
    expect(cluster).not.toContain('hidden')
    expect(cluster).toContain('fine:hidden')
    expect(cluster.filter(name => name.startsWith('group-hover'))).toEqual([])
  })
})
