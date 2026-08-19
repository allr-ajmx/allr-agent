/**
 * WHOSE HOME `~` STANDS FOR.
 *
 * Every filesystem path universal paints in chrome — the statusbar cwd, project
 * and repo roots, the review tree, the remote file picker, preview tabs — is a
 * path on the machine the GATEWAY runs on, not on this client. Sessions run
 * there, `/api/fs` reads there, the project tree is scanned there. So the home
 * directory `~` may stand for is the gateway's, and this client's own `$HOME` is
 * the right answer only in the one mode where the two coincide (a locally
 * spawned backend).
 *
 * `lib/display-path.ts` had no home to work with, so it guessed: any
 * `/home/<x>`, `/Users/<x>` or `C:/Users/<x>` prefix became `~`. That is wrong
 * in both directions — `/home/someone-else/src` on a shared box reads as yours,
 * and a gateway whose user lives outside those layouts never collapses at all.
 *
 * The gateway already tells us where it lives: `StatusResponse.hermes_home`, the
 * backend's own `get_hermes_home()`. Its default is `$HOME/.allr` (POSIX) or
 * `%LOCALAPPDATA%/hermes` (Windows), so the home falls out of it exactly when it
 * has NOT been overridden — and when it has, we say "unknown" and let the old
 * heuristic stand rather than invent an answer.
 */

import { useCallback } from 'react'

import { displayPath, normalizeDisplayPath } from '@/lib/display-path'
import { computed, useStore } from '@/store/atom'
import { $statusSnapshot } from '@/store/system-status'

/** `<home>/AppData/Local` — the Windows default's parents, lowest segment first. */
const WINDOWS_TAIL = ['local', 'appdata']
/** Its leaf. `hermes` is the pre-rename default, still reported by old installs. */
const WINDOWS_LEAVES = ['allr', 'hermes']  // rebrand:keep

/**
 * The gateway user's home directory, derived from the ALLR_HOME it reports.
 * `''` when it cannot be derived — an explicit `ALLR_HOME=/srv/allr` says
 * nothing about where that user's home is, and guessing is what we're replacing.
 */
export function homeFromHermesHome(hermesHome: null | string | undefined): string {
  const path = normalizeDisplayPath(hermesHome || '')

  if (!path) {
    return ''
  }

  const segments = path.split('/')
  const leaf = segments[segments.length - 1]?.toLowerCase() ?? ''
  // POSIX default: `<home>/.allr`.
  const strip = leaf === '.allr' ? 1 : windowsStrip(segments)

  if (strip === 0) {
    return ''
  }

  const home = segments.slice(0, segments.length - strip).join('/')

  // `/.allr` leaves nothing, and `~` for the filesystem root is not a claim
  // worth making. A drive root (`C:`) is the same case.
  return home && home !== '/' && !/^[A-Za-z]:$/.test(home) ? home : ''
}

/** How many trailing segments to drop for the Windows default, or 0 if it isn't one. */
function windowsStrip(segments: string[]): number {
  const depth = WINDOWS_TAIL.length + 1

  if (segments.length <= depth || !WINDOWS_LEAVES.includes(segments[segments.length - 1]?.toLowerCase() ?? '')) {
    return 0
  }

  const matches = WINDOWS_TAIL.every((want, back) => segments[segments.length - 2 - back]?.toLowerCase() === want)

  return matches ? depth : 0
}

/**
 * The home to collapse in displayed paths, live.
 *
 * A `computed` rather than a snapshot read on purpose: subscribing to it mounts
 * `$statusSnapshot`, which is what fetches the status in the first place, so a
 * surface that shows a path in a window with no statusbar still gets a home.
 * `''` until the gateway answers, which is exactly the "unknown" case
 * `displayPath` already handles.
 */
export const $displayHome = computed($statusSnapshot, status => homeFromHermesHome(status?.hermes_home))

/**
 * `displayPath` bound to the gateway's home, re-bound when the gateway changes.
 *
 * Components take this instead of importing `displayPath` directly so that
 * switching gateways repaints every visible path against the new machine's home
 * instead of leaving the old one's `~` on screen.
 */
export function useDisplayPath(): (raw: null | string | undefined) => string {
  const home = useStore($displayHome)

  return useCallback((raw: null | string | undefined) => displayPath(raw, { home }), [home])
}
