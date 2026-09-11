// The pure half of the downloads spine (rule 35): every decision about what a
// download's row should say, with no Tauri, no network and no clock of its own.
//
// It exists apart from `store/downloads.ts` for two reasons. The obvious one is
// testability — the reducer is where the ordering and lifecycle bugs live (a
// progress event arriving after a cancel, a terminal state being overwritten by
// a stale chunk count), and none of those need a webview to reproduce. The
// second is rule 21: the SAME reducer runs in the window that owns the transfer
// (fed by Tauri progress events) and in every peer window (fed by broadcasts),
// so a peer's tray is not a second implementation that can drift from the
// owner's.

/** The type name is `Status`, not `State`, so it never reads as the store. */
export type DownloadStatus = 'cancelled' | 'done' | 'failed' | 'queued' | 'running'

export type DownloadKind = 'file' | 'folder'

export interface DownloadItem {
  id: string
  /** What to show in the tray — a basename, never the full gateway path. */
  name: string
  /** The path ON THE GATEWAY. For a folder download this is the directory. */
  srcPath: string
  /** Where it lands on THIS device. `.zip` already appended for a folder. */
  dest: string
  received: number
  /** `null` while unknown — a streamed archive has no `Content-Length`. */
  total: null | number
  status: DownloadStatus
  kind: DownloadKind
  /** A stable code from Rust (`file_not_found`, …), not a sentence. */
  error?: string
  /** The WebView that is actually running the transfer (rule 21). */
  owner: string
  startedAt: number
  finishedAt?: number
}

export type DownloadRecord = Record<string, DownloadItem>

export type DownloadEvent =
  | { type: 'cancelled'; id: string }
  | { type: 'dismissed'; id: string }
  | { type: 'failed'; id: string; error: string }
  | { type: 'finished'; id: string; received: number }
  | { type: 'merged'; item: DownloadItem }
  | { type: 'progress'; id: string; received: number; total: null | number }
  | { type: 'queued'; item: DownloadItem }
  | { type: 'started'; id: string }

const TERMINAL: ReadonlySet<DownloadStatus> = new Set<DownloadStatus>(['cancelled', 'done', 'failed'])

export function isActive(item: DownloadItem): boolean {
  return !TERMINAL.has(item.status)
}

/**
 * How many finished rows the tray keeps.
 *
 * Rule 22 is about persistence, and this record is deliberately NOT persisted
 * (see the note in `store/downloads.ts`) — but "not persisted" is not "not
 * unbounded": a long-lived window that downloads all afternoon would otherwise
 * grow this map forever and re-render the tray over an ever longer list. The
 * cap is on FINISHED rows only; a running transfer is never evicted, because
 * evicting it would orphan a transfer that is still writing to disk.
 *
 * 50 rather than 20 because the tray panel is now the ONLY route back to a past
 * download — the button no longer auto-hides, and nothing is persisted across a
 * restart — so the cap is what a session's history is worth, not what a
 * transient notification is worth.
 */
export const MAX_FINISHED_TRACKED = 50

/**
 * The completion fraction, or `null` when there is no endpoint to measure
 * against — which is the honest answer for a streamed archive and is what makes
 * the bar render indeterminate instead of pretending to know.
 */
export function downloadFraction(item: DownloadItem): null | number {
  if (item.status === 'done') {
    return 1
  }

  if (item.total === null || item.total <= 0) {
    return null
  }

  return Math.min(1, item.received / item.total)
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

/**
 * A byte count a human can read at a glance.
 *
 * Decimal units (1000, not 1024) on purpose: the number beside it is a download
 * size, and the size every OS download panel, every browser and the file
 * manager the user will check it against are all decimal. Being "correct" in
 * KiB here would only ever mean disagreeing with the receipt.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B'
  }

  let value = bytes
  let unit = 0

  while (value >= 1000 && unit < BYTE_UNITS.length - 1) {
    value /= 1000
    unit += 1
  }

  // Whole bytes read as noise with a decimal; everything else gets one place,
  // which is the precision a progress readout can actually change at.
  return `${unit === 0 ? Math.round(value) : value.toFixed(1)} ${BYTE_UNITS[unit]}`
}

/**
 * Drop the oldest finished rows past the cap.
 *
 * Ordered by `finishedAt` rather than insertion: a small download started
 * second can finish first, and the tray reads newest-finished-first.
 */
function trim(record: DownloadRecord): DownloadRecord {
  const finished = Object.values(record).filter(item => !isActive(item))

  if (finished.length <= MAX_FINISHED_TRACKED) {
    return record
  }

  const doomed = finished
    .sort((a, b) => (a.finishedAt ?? a.startedAt) - (b.finishedAt ?? b.startedAt))
    .slice(0, finished.length - MAX_FINISHED_TRACKED)

  const next = { ...record }

  for (const item of doomed) {
    delete next[item.id]
  }

  return next
}

function replace(record: DownloadRecord, id: string, patch: Partial<DownloadItem>): DownloadRecord {
  const existing = record[id]

  if (!existing) {
    return record
  }

  return trim({ ...record, [id]: { ...existing, ...patch } })
}

/**
 * Fold one event into the download table.
 *
 * Returns the SAME reference when nothing changed, so a re-render costs nothing
 * for the events that are dropped — and a great many are: a peer window
 * rebroadcasting progress for a download it does not know about, a chunk that
 * lands after the user hit cancel, an event for an id that has been trimmed.
 */
export function applyDownloadEvent(record: DownloadRecord, event: DownloadEvent): DownloadRecord {
  switch (event.type) {
    case 'queued':
      return trim({ ...record, [event.item.id]: event.item })
    case 'merged': {
      const existing = record[event.item.id]

      // A peer's snapshot never un-finishes a row this window already saw end.
      // Broadcasts are best-effort and unordered by design (`emit` resolves when
      // the message left, not when it landed), so the terminal state has to be a
      // one-way door or a late "running" snapshot would resurrect a finished
      // download and leave a row spinning forever.
      if (existing && !isActive(existing) && isActive(event.item)) {
        return record
      }

      return trim({ ...record, [event.item.id]: event.item })
    }

    case 'started':
      return record[event.id]?.status === 'queued' ? replace(record, event.id, { status: 'running' }) : record
    case 'progress': {
      const existing = record[event.id]

      if (!existing || !isActive(existing)) {
        return record
      }

      // Monotonic: `received` only ever moves forward. A retry or a duplicated
      // event must not make the bar jump backwards.
      const received = Math.max(existing.received, event.received)

      if (received === existing.received && event.total === existing.total && existing.status === 'running') {
        return record
      }

      return replace(record, event.id, { received, status: 'running', total: event.total ?? existing.total })
    }

    case 'finished':
      return replace(record, event.id, {
        error: undefined,
        finishedAt: Date.now(),
        received: event.received,
        status: 'done',
        // A finished download IS its own total, whatever the header claimed —
        // this is what closes an indeterminate archive bar at 100%.
        total: event.received
      })

    case 'failed':
      return replace(record, event.id, { error: event.error, finishedAt: Date.now(), status: 'failed' })

    case 'cancelled':
      return replace(record, event.id, { error: undefined, finishedAt: Date.now(), status: 'cancelled' })
    case 'dismissed': {
      if (!record[event.id]) {
        return record
      }

      const next = { ...record }

      delete next[event.id]

      return next
    }

    default:
      return record
  }
}
