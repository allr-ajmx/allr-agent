import { getCronJobs, triggerCronJob } from '@/hermes'
import { translateNow } from '@/i18n'
import { atom } from '@/store/atom'
import { notifyError } from '@/store/notifications'
import type { CronJob } from '@/types/hermes'

// Cron *jobs* (not run sessions) power the sidebar "Cron jobs" section and the
// cron overlay. Listing the job — schedule, state, live next-run countdown —
// makes the job the first-class entity; its runs (sessions) resolve under it in
// the cron detail.
//
// Everything that MUTATES a job (pause/resume/delete/edit) lives at its call
// site — `app/chat/sidebar/cron-jobs-section.tsx` and `app/cron/index.tsx` —
// because both need the job's title and the surface's translated toasts, which
// an id-only store helper cannot produce. This module deliberately keeps only
// what more than one surface shares: the list atom and the two calls the sidebar
// poll makes.
export const $cronJobs = atom<CronJob[]>([])

// Ported from desktop's store/cron.ts — the cron overlay writes through these
// so the sidebar and the overlay never drift (a delete in the overlay clears the
// sidebar row immediately).
export const setCronJobs = (jobs: CronJob[]) => $cronJobs.set(jobs)

// In-place edit so the cron overlay's mutations (create/edit/delete/pause/…)
// land in the same atom the sidebar renders — no stale list until the next poll.
export const updateCronJobs = (fn: (jobs: CronJob[]) => CronJob[]) => $cronJobs.set(fn($cronJobs.get()))

/** `profile` scopes the listing: a concrete profile key, or 'all' for the
 *  all-profiles browse view. Omit for the active profile (the REST default). */
export async function refreshCronJobs(profile?: string): Promise<void> {
  try {
    $cronJobs.set(await getCronJobs(profile))
  } catch {
    // Deliberately silent: this runs on a timer, so a toast per failed tick on a
    // gateway that is merely down would bury every other notification. The
    // sidebar keeps the last good list and the next tick recovers.
  }
}

function replace(job: CronJob) {
  $cronJobs.set($cronJobs.get().map(j => (j.id === job.id ? job : j)))
}

/** Run a job now (the sidebar row's zap button and its menu's "Trigger now").
 *  The returned job carries the new state, so the row repaints without waiting
 *  for the next poll. */
export async function triggerCron(id: string): Promise<void> {
  try {
    replace(await triggerCronJob(id))
  } catch (err) {
    notifyError(err, translateNow('cron.failedTrigger'))
  }
}
