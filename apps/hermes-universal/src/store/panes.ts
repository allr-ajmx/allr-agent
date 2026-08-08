import { atom, computed, type ReadableAtom } from 'nanostores'

// Generic pane state (open + resize overrides), keyed by pane id. Ported from
// desktop's `store/panes.ts` — pure nanostores + localStorage, no Electron. The
// PaneShell reads this to size/collapse each pane; `store/layout.ts` wraps the
// chat-sidebar pane with named helpers.

export interface PaneStateSnapshot {
  open: boolean
  widthOverride?: number
  /** Vertical size override (px) for panes that resize on the Y axis (e.g. a bottom-row terminal). */
  heightOverride?: number
}

export interface PaneRegisterDefaults {
  open: boolean
  widthOverride?: number
}

const STORAGE_KEY = 'hermes.paneStates.v1'

function isSnapshot(value: unknown): value is PaneStateSnapshot {
  if (!value || typeof value !== 'object') {
    return false
  }

  const r = value as Record<string, unknown>

  if (typeof r.open !== 'boolean') {
    return false
  }

  const widthOk =
    r.widthOverride === undefined || (typeof r.widthOverride === 'number' && Number.isFinite(r.widthOverride))

  const heightOk =
    r.heightOverride === undefined || (typeof r.heightOverride === 'number' && Number.isFinite(r.heightOverride))

  return widthOk && heightOk
}

function load(): Record<string, PaneStateSnapshot> {
  if (typeof window === 'undefined') {
    return {}
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)

    if (raw) {
      const parsed = JSON.parse(raw) as unknown

      if (parsed && typeof parsed === 'object') {
        const out: Record<string, PaneStateSnapshot> = {}

        for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (isSnapshot(value)) {
            out[id] = { open: value.open, widthOverride: value.widthOverride, heightOverride: value.heightOverride }
          }
        }

        return out
      }
    }
  } catch {
    // Treat unparseable persisted state as missing.
  }

  return {}
}

// Persists both open state and resize width; load() validates each snapshot.
function persist(states: Record<string, PaneStateSnapshot>) {
  if (typeof window === 'undefined') {
    return
  }

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(states))
  } catch {
    // Storage failures are nonfatal.
  }
}

export const $paneStates = atom<Record<string, PaneStateSnapshot>>(load())

// Coalesce writes. `persist` is JSON.stringify + a synchronous localStorage
// write, and a pane drag changes this atom once per frame — paying that on the
// same frame as the relayout it triggers is measurable jank for a value nothing
// reads until the next launch. A trailing timer is enough: the last state
// within the window is the one worth keeping.
const PERSIST_DELAY_MS = 250

let persistTimer: null | ReturnType<typeof setTimeout> = null
let persistPending: null | Record<string, PaneStateSnapshot> = null

function flushPersist() {
  // Clear rather than just drop the handle: an out-of-band flush (pagehide,
  // visibilitychange) can land while a timer is pending, and leaving it armed
  // would let the next change schedule a second one alongside it.
  if (persistTimer !== null) {
    clearTimeout(persistTimer)
    persistTimer = null
  }

  if (persistPending) {
    persist(persistPending)
    persistPending = null
  }
}

$paneStates.subscribe(states => {
  persistPending = states

  if (persistTimer === null) {
    persistTimer = setTimeout(flushPersist, PERSIST_DELAY_MS)
  }
})

// Don't lose the last drag if the window goes away inside the debounce window.
// Both events, because neither is sufficient alone: `pagehide` covers reload and
// in-page navigation, but a Tauri webview being destroyed (window close, app
// quit) does not reliably fire it — `visibilitychange` to hidden is what tends
// to arrive there. Double-firing is harmless; the flush is idempotent.
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushPersist)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushPersist()
    }
  })
}

// Cached per-pane derived atoms keep useStore subscriptions referentially stable.
function memoized<T>(
  cache: Map<string, ReadableAtom<T>>,
  id: string,
  selector: (s: PaneStateSnapshot | undefined) => T
) {
  let cached = cache.get(id)

  if (!cached) {
    cached = computed($paneStates, states => selector(states[id]))
    cache.set(id, cached)
  }

  return cached
}

const openCache = new Map<string, ReadableAtom<boolean>>()
const stateCache = new Map<string, ReadableAtom<PaneStateSnapshot | undefined>>()
const widthCache = new Map<string, ReadableAtom<number | undefined>>()
const heightCache = new Map<string, ReadableAtom<number | undefined>>()

export const $paneOpen = (id: string) => memoized(openCache, id, s => s?.open ?? false)
export const $paneState = (id: string) => memoized(stateCache, id, s => s)
export const $paneWidthOverride = (id: string) => memoized(widthCache, id, s => s?.widthOverride)
export const $paneHeightOverride = (id: string) => memoized(heightCache, id, s => s?.heightOverride)

export function ensurePaneRegistered(id: string, defaults: PaneRegisterDefaults) {
  const current = $paneStates.get()

  if (current[id] !== undefined) {
    return
  }

  $paneStates.set({ ...current, [id]: { open: defaults.open, widthOverride: defaults.widthOverride } })
}

export function setPaneOpen(id: string, open: boolean) {
  const current = $paneStates.get()
  const existing = current[id]

  if (existing?.open === open) {
    return
  }

  $paneStates.set({ ...current, [id]: { ...existing, open } })
}

export function togglePane(id: string) {
  const current = $paneStates.get()
  const existing = current[id]
  $paneStates.set({ ...current, [id]: { ...existing, open: !(existing?.open ?? false) } })
}

/** Carry a pane's saved state to a new id. Paired with `renameTreePane` — a pane
 *  that keeps its slot but loses its dragged width has not really been renamed. */
export function renamePaneState(from: string, to: string) {
  const current = $paneStates.get()
  const existing = current[from]

  if (!existing) {
    return
  }

  const next = { ...current, [to]: existing }

  delete next[from]

  $paneStates.set(next)
}

export function setPaneWidthOverride(id: string, width: number | undefined) {
  const current = $paneStates.get()
  const existing = current[id] ?? { open: false }

  if (existing.widthOverride === width) {
    return
  }

  $paneStates.set({ ...current, [id]: { ...existing, widthOverride: width } })
}

export function setPaneHeightOverride(id: string, height: number | undefined) {
  const current = $paneStates.get()
  const existing = current[id] ?? { open: false }

  if (existing.heightOverride === height) {
    return
  }

  $paneStates.set({ ...current, [id]: { ...existing, heightOverride: height } })
}

export const clearPaneWidthOverride = (id: string) => setPaneWidthOverride(id, undefined)
export const clearPaneHeightOverride = (id: string) => setPaneHeightOverride(id, undefined)
export const getPaneStateSnapshot = (id: string) => $paneStates.get()[id]

/** Drop every pane's width/height override at once — a layout reset returns all
 *  zones to their weight/default sizing without touching open/closed state. */
export function clearAllPaneSizeOverrides() {
  const current = $paneStates.get()
  let changed = false
  const next: Record<string, PaneStateSnapshot> = {}

  for (const [id, state] of Object.entries(current)) {
    if (state.widthOverride !== undefined || state.heightOverride !== undefined) {
      changed = true
      next[id] = { open: state.open }
    } else {
      next[id] = state
    }
  }

  if (changed) {
    $paneStates.set(next)
  }
}
