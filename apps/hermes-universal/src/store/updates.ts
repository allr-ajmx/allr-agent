import type { UpdateStatus } from '@/lib/updates'
import { checkAppUpdate, installAppUpdate } from '@/lib/updates'
import { atom } from '@/store/atom'

// App-update state (MJX-6). Deliberately pull-only: the About page checks once
// on mount and on "Check now" — there is no background poller, because the
// native side already caches a result for 6h and nothing outside About consumes
// this. `$appUpdateFailed` is separate from a status carrying `reason` so the UI
// can tell "the command didn't answer" from "the store didn't know".

export const $appUpdate = atom<null | UpdateStatus>(null)
export const $appUpdateChecking = atom(false)
export const $appUpdateFailed = atom(false)
// Set while the desktop updater is downloading/swapping. It is only ever
// cleared on FAILURE: a successful install replaces the process, so the state
// dies with it and leaving the button spinning until then is the honest UI.
export const $appUpdateInstalling = atom(false)
export const $appUpdateInstallFailed = atom(false)

let inflight: null | Promise<null | UpdateStatus> = null
let installing: null | Promise<void> = null

/**
 * Run a check, deduping concurrent callers (mount + a quick "Check now" tap
 * would otherwise race and leave the spinner stuck). Resolves to the status, or
 * null when the native command is unavailable (plain-web dev / vitest).
 */
export function runUpdateCheck(force = false): Promise<null | UpdateStatus> {
  if (inflight) {
    return inflight
  }

  $appUpdateChecking.set(true)

  inflight = checkAppUpdate(force)
    .then(status => {
      $appUpdate.set(status)
      $appUpdateFailed.set(status === null)

      return status
    })
    .catch(() => {
      $appUpdateFailed.set(true)

      return null
    })
    .finally(() => {
      inflight = null
      $appUpdateChecking.set(false)
    })

  return inflight
}

/**
 * Install the update the last check found and restart into it.
 *
 * Deduped like `runUpdateCheck`: a double-tap must not start two downloads.
 * Resolves either way — the caller reads `$appUpdateInstallFailed` — because
 * the success path does not come back at all.
 */
export function runUpdateInstall(): Promise<void> {
  if (installing) {
    return installing
  }

  $appUpdateInstalling.set(true)
  $appUpdateInstallFailed.set(false)

  installing = installAppUpdate()
    .catch(() => {
      $appUpdateInstallFailed.set(true)
      $appUpdateInstalling.set(false)
    })
    .finally(() => {
      installing = null
    })

  return installing
}

/** Test seam — drop cached state between cases. */
export function __resetUpdateState(): void {
  inflight = null
  installing = null
  $appUpdate.set(null)
  $appUpdateChecking.set(false)
  $appUpdateFailed.set(false)
  $appUpdateInstalling.set(false)
  $appUpdateInstallFailed.set(false)
}
