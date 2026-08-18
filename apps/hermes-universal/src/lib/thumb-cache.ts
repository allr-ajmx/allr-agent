import { loadString, removeKey, saveString } from '@/lib/persist'

// Persistent LRU for pet thumbnail data URIs.
//
// The gateway already crops + disk-caches each thumbnail (`~/.allr/pets/.thumbs`),
// but the client's in-memory map dies with the webview — so every restart re-paid one
// `pet.thumb` RPC per visible card. That RPC rides the gateway's shared 8-worker pool,
// so the burst is expensive far beyond the pet picker (MJX-14).
//
// Entries are small (96x104 PNG as base64, ~3-6 KB), so localStorage is the right size
// of hammer: synchronous reads mean a warm thumb paints on the first render, with no
// RPC and no loading flash. Every path is failure-swallowing — this is a perf cache and
// must never throw into the UI.

const PREFIX = 'hermes.pet.thumb.'
const INDEX_KEY = `${PREFIX}index`

/** Entries kept before the oldest are evicted (~500 KB of base64 at the cap). */
export const THUMB_CACHE_MAX = 150

function readIndex(): string[] {
  try {
    const parsed: unknown = JSON.parse(loadString(INDEX_KEY, '[]'))

    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : []
  } catch {
    return []
  }
}

function writeIndex(slugs: string[]): void {
  saveString(INDEX_KEY, JSON.stringify(slugs))
}

function drop(slugs: string[]): void {
  for (const slug of slugs) {
    removeKey(PREFIX + slug)
  }
}

/** Cached data URI for `slug`, or null. Bumps recency on a hit. */
export function readThumb(slug: string): string | null {
  const value = loadString(PREFIX + slug)

  if (!value) {
    return null
  }

  const index = readIndex()

  // Only rewrite the index when the slug isn't already the most recent — a full
  // grid of cache hits would otherwise write the index once per card.
  if (index[index.length - 1] !== slug) {
    writeIndex([...index.filter(s => s !== slug), slug])
  }

  return value
}

/** Store a thumbnail, evicting the oldest entries past the cap. */
export function writeThumb(slug: string, dataUri: string): void {
  const index = [...readIndex().filter(s => s !== slug), slug]

  if (index.length > THUMB_CACHE_MAX) {
    drop(index.splice(0, index.length - THUMB_CACHE_MAX))
  }

  try {
    localStorage.setItem(PREFIX + slug, dataUri)
  } catch {
    // Quota: evict the oldest half and try once more. If that still fails,
    // give up quietly — the thumb just won't survive this restart.
    const survivors = index.slice(Math.floor(index.length / 2))
    drop(index.slice(0, index.length - survivors.length))
    index.length = 0
    index.push(...survivors)

    try {
      localStorage.setItem(PREFIX + slug, dataUri)
    } catch {
      index.pop()
      writeIndex(index)

      return
    }
  }

  writeIndex(index)
}

/** Forget one thumbnail — a removed/renamed slug must not paint a stale sprite. */
export function evictThumb(slug: string): void {
  removeKey(PREFIX + slug)
  const index = readIndex()

  if (index.includes(slug)) {
    writeIndex(index.filter(s => s !== slug))
  }
}
