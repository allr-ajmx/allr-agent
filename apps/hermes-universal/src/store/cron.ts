import {
  createCronJob,
  deleteCronJob,
  getCronJobs,
  pauseCronJob,
  resumeCronJob,
  triggerCronJob,
  updateCronJob
} from '@/hermes'
import { atom } from '@/store/atom'
import { notifyError } from '@/store/notifications'
import type { CronJob, CronJobCreatePayload, CronJobUpdates } from '@/types/hermes'

// Cron *jobs* (not run sessions) power the sidebar "Cron jobs" section and the
// cron overlay. Listing the job — schedule, state, live next-run countdown —
// makes the job the first-class entity; its runs (sessions) resolve under it in
// the cron detail. The optimistic mutation helpers below back the sidebar rows.
export const $cronJobs = atom<CronJob[]>([])
export const $cronLoading = atom(false)
export const $cronLoadError = atom<string | null>(null)

// Ported from desktop's store/cron.ts — the cron overlay writes through these
// so the sidebar and the overlay never drift (a delete in the overlay clears the
// sidebar row immediately).
export const setCronJobs = (jobs: CronJob[]) => $cronJobs.set(jobs)

// In-place edit so the cron overlay's mutations (create/edit/delete/pause/…)
// land in the same atom the sidebar renders — no stale list until the next poll.
export const updateCronJobs = (fn: (jobs: CronJob[]) => CronJob[]) => $cronJobs.set(fn($cronJobs.get()))

// One-shot focus target: clicking "Manage" on a job sets this, then opens the
// cron overlay, which reads it once to select + scroll to that job. Cleared
// after consumption so re-opening cron normally doesn't re-focus a stale job.
export const $cronFocusJobId = atom<null | string>(null)
export const setCronFocusJobId = (id: null | string) => $cronFocusJobId.set(id)

/** `profile` scopes the listing: a concrete profile key, or 'all' for the
 *  all-profiles browse view. Omit for the active profile (the REST default). */
export async function refreshCronJobs(profile?: string): Promise<void> {
  $cronLoading.set(true)
  $cronLoadError.set(null)

  try {
    $cronJobs.set(await getCronJobs(profile))
  } catch (err) {
    $cronLoadError.set(err instanceof Error ? err.message : 'Failed to load cron jobs')
  } finally {
    $cronLoading.set(false)
  }
}

function replace(job: CronJob) {
  $cronJobs.set($cronJobs.get().map(j => (j.id === job.id ? job : j)))
}

/** Enable/disable a job (resume/pause), optimistic with rollback. */
export async function setCronEnabled(id: string, enabled: boolean): Promise<void> {
  const prev = $cronJobs.get()
  $cronJobs.set(prev.map(j => (j.id === id ? { ...j, enabled } : j)))

  try {
    const updated = enabled ? await resumeCronJob(id) : await pauseCronJob(id)
    replace(updated)
  } catch (err) {
    $cronJobs.set(prev)
    notifyError(err, enabled ? 'Resume failed' : 'Pause failed')
  }
}

export async function triggerCron(id: string): Promise<void> {
  try {
    replace(await triggerCronJob(id))
  } catch (err) {
    notifyError(err, 'Trigger failed')
  }
}

export async function removeCron(id: string): Promise<void> {
  const prev = $cronJobs.get()
  $cronJobs.set(prev.filter(j => j.id !== id))

  try {
    await deleteCronJob(id)
  } catch (err) {
    $cronJobs.set(prev)
    notifyError(err, 'Delete failed')
  }
}

/** Create a new job or update an existing one, then reflect it in the list. */
export async function saveCron(jobId: string | null, payload: CronJobCreatePayload & CronJobUpdates): Promise<boolean> {
  try {
    if (jobId) {
      replace(await updateCronJob(jobId, payload))
    } else {
      $cronJobs.set([await createCronJob(payload), ...$cronJobs.get()])
    }

    return true
  } catch (err) {
    notifyError(err, jobId ? 'Update failed' : 'Create failed')

    return false
  }
}
