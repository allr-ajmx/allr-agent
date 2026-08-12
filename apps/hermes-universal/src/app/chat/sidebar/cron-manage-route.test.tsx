/**
 * "Manage" on a cron row has to open THAT job (MJXHRM-377).
 *
 * The sidebar knows which row was pressed; the cron surface has to be told. It
 * used to be told nothing — the row's job id was accepted and dropped, so every
 * row opened whichever job sorted first. This renders the real sidebar body so
 * the assertion covers the wiring, not a re-implementation of it: the id has to
 * survive all the way into the URL, which is the only carrier that also crosses
 * into Android's separate cron-screen WebView.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { SidebarScrollBody } from '@/app/chat/sidebar/sidebar-content'
import { SidebarProvider } from '@/app/shell/sidebar'
import { $cronJobs } from '@/store/cron'
import { $sidebarCronOpen } from '@/store/layout'
import type { CronJob } from '@/types/hermes'

const NOW = Date.now()

const jobs: CronJob[] = [
  { enabled: true, id: 'zulu-job', name: 'Zulu digest', next_run_at: new Date(NOW + 60_000).toISOString() },
  { enabled: true, id: 'alpha-job', name: 'Alpha backup', next_run_at: new Date(NOW + 600_000).toISOString() }
]

function renderSidebar() {
  render(
    <MemoryRouter>
      <SidebarProvider>
        <SidebarScrollBody />
      </SidebarProvider>
    </MemoryRouter>
  )
}

/** The row's own "Manage" (watch) button — the same handler its kebab item runs. */
function manageButton(title: string) {
  const row = screen.getByText(title).closest('[class*="group/cron"]')!

  return Array.from(row.querySelectorAll('button')).find(button => button.getAttribute('aria-label') === 'Manage')!
}

beforeEach(() => {
  window.location.hash = ''
  $sidebarCronOpen.set(true)
  $cronJobs.set(jobs)
})

afterEach(() => {
  cleanup()
  $cronJobs.set([])
  window.location.hash = ''
})

describe('cron row → Manage', () => {
  it('deep-links to the row the user pressed, not to the first job in the list', async () => {
    renderSidebar()
    await screen.findByText('Alpha backup')

    // 'Alpha backup' is LAST by next run (the section's sort) and FIRST
    // alphabetically (the cron surface's sort) — so a dropped id shows up as the
    // other job either way.
    fireEvent.click(manageButton('Alpha backup'))

    expect(window.location.hash).toBe('#/cron?job=alpha-job')

    fireEvent.click(manageButton('Zulu digest'))

    expect(window.location.hash).toBe('#/cron?job=zulu-job')
  })
})
