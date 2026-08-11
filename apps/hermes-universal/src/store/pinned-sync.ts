import { $pinnedSessionIds } from '@/store/layout'

/**
 * Gateway-backed pinned sessions.
 *
 * Pins were localStorage-only, so they described one browser rather than the
 * gateway's session set: pinning on the desktop and then opening the phone
 * showed a different list, with no way to reconcile the two. Whichever client
 * you looked at, the other one's pins had "disappeared".
 *
 * They now live in the gateway's config (`config.get`/`config.set`, key
 * `pinned_sessions`), with localStorage kept as a CACHE so the sidebar still
 * renders its last-known pins before the socket is up — and still works against
 * a gateway too old to know the key.
 *
 * Write-through is last-write-wins, and the gateway pushes `pins.changed` to
 * every other client. Two people racing on the same pin is not a case worth a
 * merge protocol; two clients silently disagreeing forever was.
 */

type Requester = (method: string, params?: Record<string, unknown>) => Promise<unknown>

/** True while applying a list that CAME from the gateway, so the subscription
 *  below doesn't immediately push it back and start a loop. */
let applyingRemote = false

/** The last list the gateway confirmed. Suppresses the redundant write when a
 *  local edit lands on exactly what the server already holds. */
let confirmed: null | string[] = null

/** Bumped per write so a slow response can't overwrite a newer local edit. */
let revision = 0

let unsubscribe: (() => void) | undefined

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index])
}

function readIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  const seen = new Set<string>()

  return value
    .map(item => String(item ?? '').trim())
    .filter(id => id.length > 0 && !seen.has(id) && Boolean(seen.add(id)))
}

/** Apply a gateway-authored list without echoing it back. */
export function applyRemotePinnedSessions(value: unknown): void {
  const ids = readIds(value)
  confirmed = ids

  if (sameIds($pinnedSessionIds.get(), ids)) {
    return
  }

  applyingRemote = true

  try {
    $pinnedSessionIds.set(ids)
  } finally {
    applyingRemote = false
  }
}

/**
 * Pull the authoritative list. Called on `gateway.ready`, i.e. on every connect
 * and reconnect — a reconnect is exactly when this client may have missed a
 * `pins.changed` while it was away.
 *
 * Two cases are deliberately NOT "the gateway wins":
 *
 * - A gateway that predates the key answers with no `value` at all. That is
 *   indistinguishable from "no pins", and wiping the user's local pins because
 *   they connected to an older gateway is worse than not syncing.
 * - A gateway that has the key but nothing stored, while this client has local
 *   pins, is the one-time migration off localStorage. Adopt the local list
 *   upward instead of deleting it.
 */
export async function syncPinnedSessions(request: Requester): Promise<void> {
  const result = (await request('config.get', { key: 'pinned_sessions' })) as { value?: unknown }

  if (!Array.isArray(result?.value)) {
    return
  }

  const remote = readIds(result.value)
  const local = $pinnedSessionIds.get()

  if (remote.length === 0 && local.length > 0) {
    await pushPinnedSessions(request, [...local])

    return
  }

  applyRemotePinnedSessions(remote)
}

/** Push a local edit. Reverts the atom to the last confirmed list on failure,
 *  so the UI never shows a pin the gateway rejected or never received. */
async function pushPinnedSessions(request: Requester, ids: string[]): Promise<void> {
  const mine = ++revision
  const previous = confirmed

  try {
    const result = (await request('config.set', { key: 'pinned_sessions', value: ids })) as { value?: unknown }

    if (revision === mine && Array.isArray(result?.value)) {
      applyRemotePinnedSessions(result.value)
    }
  } catch {
    if (revision === mine && previous) {
      applyRemotePinnedSessions(previous)
    }
  }
}

/**
 * Start mirroring local pin edits to the gateway. Idempotent — the event router
 * calls it on every `gateway.ready`, and only the first call subscribes.
 */
export function startPinnedSessionSync(request: Requester): void {
  if (unsubscribe) {
    return
  }

  // `listen`, not `subscribe`: subscribe fires immediately with the current
  // value, which would push this client's cached list before the pull has
  // decided who wins.
  unsubscribe = $pinnedSessionIds.listen(ids => {
    if (applyingRemote) {
      return
    }

    if (confirmed && sameIds(confirmed, ids)) {
      return
    }

    void pushPinnedSessions(request, [...ids])
  })
}

/** Test seam — drops the subscription and forgets what the gateway confirmed. */
export function resetPinnedSessionSync(): void {
  unsubscribe?.()
  unsubscribe = undefined
  confirmed = null
  revision = 0
  applyingRemote = false
}
