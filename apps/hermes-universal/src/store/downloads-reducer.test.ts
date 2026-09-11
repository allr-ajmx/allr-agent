import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  applyDownloadEvent,
  downloadFraction,
  type DownloadItem,
  type DownloadRecord,
  formatBytes,
  isActive,
  MAX_FINISHED_TRACKED
} from './downloads-reducer'

/**
 * The pure half of the downloads spine (rule 35). No Tauri, no network, no
 * webview — which is the point: every lifecycle bug worth having a test for is
 * an ORDERING bug (a chunk landing after a cancel, a peer's stale snapshot
 * arriving after the owner's terminal one), and none of them need a device.
 */

function item(overrides: Partial<DownloadItem> = {}): DownloadItem {
  return {
    dest: '/home/me/Downloads/report.pdf',
    id: 'dl-1',
    kind: 'file',
    name: 'report.pdf',
    owner: 'wv-a',
    received: 0,
    srcPath: '/work/out/report.pdf',
    startedAt: 1000,
    status: 'queued',
    total: null,
    ...overrides
  }
}

function seeded(overrides: Partial<DownloadItem> = {}): DownloadRecord {
  const seed = item(overrides)

  return { [seed.id]: seed }
}

beforeEach(() => {
  vi.useRealTimers()
})

describe('applyDownloadEvent', () => {
  it('returns the same reference when nothing changed, so a drop costs no render', () => {
    const record = seeded()

    // Every one of these is a real event the store fires: progress for a row
    // that has been trimmed, a start for a row already running, a dismiss for
    // an id nobody has.
    expect(applyDownloadEvent(record, { id: 'unknown', received: 5, total: null, type: 'progress' })).toBe(record)
    expect(applyDownloadEvent(record, { id: 'unknown', type: 'dismissed' })).toBe(record)
    expect(applyDownloadEvent(seeded({ status: 'running' }), { id: 'dl-1', type: 'started' })).toEqual(
      seeded({ status: 'running' })
    )
  })

  it('moves a queued download to running and folds progress into it', () => {
    let record = applyDownloadEvent(seeded(), { id: 'dl-1', type: 'started' })

    expect(record['dl-1']?.status).toBe('running')

    record = applyDownloadEvent(record, { id: 'dl-1', received: 2048, total: 8192, type: 'progress' })

    expect(record['dl-1']).toMatchObject({ received: 2048, status: 'running', total: 8192 })
  })

  /**
   * The bug this pins: reqwest emits progress from a loop and the cancel flag is
   * read between chunks, so a chunk that was already in flight lands AFTER the
   * command has rejected with `download_cancelled`. Folding it would flip a
   * cancelled row back to running, and the tray would show a spinner for a
   * transfer that no longer exists.
   */
  it('never lets a late progress event resurrect a finished download', () => {
    for (const status of ['cancelled', 'done', 'failed'] as const) {
      const record = seeded({ status })
      const after = applyDownloadEvent(record, { id: 'dl-1', received: 999, total: null, type: 'progress' })

      expect(after).toBe(record)
    }
  })

  it('only ever moves the byte count forward', () => {
    const record = seeded({ received: 5000, status: 'running' })
    const after = applyDownloadEvent(record, { id: 'dl-1', received: 12, total: null, type: 'progress' })

    expect(after['dl-1']?.received).toBe(5000)
  })

  /**
   * A streamed archive has no `Content-Length`, so `total` is null the whole way
   * down and the bar is indeterminate. On completion the received count IS the
   * total — without this the bar would still be indeterminate on a row that says
   * "Saved".
   */
  it('closes an unknown-total download at 100% when it finishes', () => {
    const record = applyDownloadEvent(seeded({ kind: 'folder', received: 900, status: 'running' }), {
      id: 'dl-1',
      received: 1234,
      type: 'finished'
    })

    expect(record['dl-1']).toMatchObject({ received: 1234, status: 'done', total: 1234 })
    expect(downloadFraction(record['dl-1']!)).toBe(1)
  })

  it('keeps a failure code rather than a sentence', () => {
    const record = applyDownloadEvent(seeded({ status: 'running' }), {
      error: 'file_forbidden',
      id: 'dl-1',
      type: 'failed'
    })

    expect(record['dl-1']).toMatchObject({ error: 'file_forbidden', status: 'failed' })
    expect(record['dl-1']?.finishedAt).toBeTypeOf('number')
  })

  /**
   * Rule 21: a peer window's snapshot arrives over `broadcastToPeers`, which is
   * best-effort and unordered by design (`emit` resolves when the message left,
   * not when it landed). A "running" snapshot that overtakes the owner's "done"
   * must lose, or a finished download spins forever in the peer's tray.
   */
  it('treats a terminal state as a one-way door against a stale peer snapshot', () => {
    const finished = { ...item({ status: 'done' }), finishedAt: 2000 }
    const record = { 'dl-1': finished }
    const stale = applyDownloadEvent(record, { item: item({ received: 40, status: 'running' }), type: 'merged' })

    expect(stale).toBe(record)

    // A peer's terminal snapshot for a row this window has not seen still lands.
    const fresh = applyDownloadEvent({}, { item: finished, type: 'merged' })

    expect(fresh['dl-1']?.status).toBe('done')
  })

  /**
   * Not persisted (see `store/downloads.ts`), but "not persisted" is not "not
   * unbounded": a window left open all afternoon would otherwise accumulate a
   * row per download forever and re-render the tray over an ever longer list.
   */
  it('bounds finished rows without ever evicting a live transfer', () => {
    let record: DownloadRecord = {}

    for (let index = 0; index < MAX_FINISHED_TRACKED + 5; index += 1) {
      record = applyDownloadEvent(record, {
        item: item({ finishedAt: 1000 + index, id: `done-${index}`, status: 'done' }),
        type: 'merged'
      })
    }

    record = applyDownloadEvent(record, { item: item({ id: 'live', status: 'running' }), type: 'merged' })

    const finished = Object.values(record).filter(entry => !isActive(entry))

    expect(finished).toHaveLength(MAX_FINISHED_TRACKED)
    // Oldest-finished go first, and the running one is untouched — evicting it
    // would orphan a transfer that is still writing to this device's disk.
    expect(record['done-0']).toBeUndefined()
    expect(record[`done-${MAX_FINISHED_TRACKED + 4}`]).toBeDefined()
    expect(record.live?.status).toBe('running')
  })
})

describe('downloadFraction', () => {
  it('is null when there is no endpoint to measure against', () => {
    expect(downloadFraction(item({ received: 500, status: 'running', total: null }))).toBeNull()
    expect(downloadFraction(item({ received: 500, status: 'running', total: 0 }))).toBeNull()
  })

  it('clamps, so a Content-Length that undercounts cannot overflow the bar', () => {
    expect(downloadFraction(item({ received: 50, status: 'running', total: 100 }))).toBe(0.5)
    expect(downloadFraction(item({ received: 150, status: 'running', total: 100 }))).toBe(1)
  })
})

describe('formatBytes', () => {
  /** Decimal, because every OS download panel this is checked against is. */
  it('reads the way a download panel reads', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(-1)).toBe('0 B')
    expect(formatBytes(999)).toBe('999 B')
    expect(formatBytes(1000)).toBe('1.0 KB')
    expect(formatBytes(1_500_000)).toBe('1.5 MB')
    expect(formatBytes(4_000_000_000)).toBe('4.0 GB')
  })

  it('does not run off the end of the unit table', () => {
    expect(formatBytes(Number.MAX_SAFE_INTEGER)).toMatch(/ TB$/)
  })
})
