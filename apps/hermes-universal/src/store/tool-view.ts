import { type Codec, persistentAtom } from '@/lib/persisted'
import { atom, computed, type ReadableAtom } from '@/store/atom'

// Tool-call display mode (mirrors desktop `store/tool-view.ts`). `product` hides
// raw tool payloads; `technical` shows full input/output. Persisted per-device.
export type ToolViewMode = 'product' | 'technical'

const codec: Codec<ToolViewMode> = {
  decode: raw => (raw === 'technical' ? 'technical' : 'product'),
  encode: value => value
}

export const $toolViewMode = persistentAtom<ToolViewMode>('hermes.toolView', 'product', codec)

export const setToolViewMode = (mode: ToolViewMode) => $toolViewMode.set(mode)

// --- Per-row disclosure open/closed state (ported from desktop) ---------------
// A map of disclosureId → open, so a tool row's expanded state survives the
// thread virtualizer unmounting/remounting the row as it scrolls. Persisted to
// localStorage (a device-local UI preference), capped so it can't grow forever.
type ToolDisclosureStates = Record<string, boolean>

const TOOL_DISCLOSURE_STORAGE_KEY = 'hermes.toolDisclosure.v1'
const MAX_DISCLOSURE_STATES = 240

export const $toolDisclosureStates = atom<ToolDisclosureStates>(loadToolDisclosureStates())
const disclosureOpenCache = new Map<string, ReadableAtom<boolean | undefined>>()
const anyDisclosureOpenCache = new Map<string, ReadableAtom<boolean>>()

$toolDisclosureStates.subscribe(persistToolDisclosureStates)

export function $toolDisclosureOpen(id: string): ReadableAtom<boolean | undefined> {
  let cached = disclosureOpenCache.get(id)

  if (!cached) {
    cached = computed($toolDisclosureStates, states => states[id])
    disclosureOpenCache.set(id, cached)
  }

  return cached
}

/**
 * Whether any of a set of disclosures is open — a run asking about its rows.
 *
 * Computed rather than reading the whole map so a toggle anywhere in the
 * transcript only re-renders the runs whose own answer changed.
 */
export function $anyToolDisclosureOpen(ids: readonly string[]): ReadableAtom<boolean> {
  const key = ids.join('|')
  let cached = anyDisclosureOpenCache.get(key)

  if (!cached) {
    cached = computed($toolDisclosureStates, states => ids.some(id => Boolean(states[id])))
    anyDisclosureOpenCache.set(key, cached)
  }

  return cached
}

function loadToolDisclosureStates(): ToolDisclosureStates {
  if (typeof window === 'undefined') {
    return {}
  }

  try {
    const raw = window.localStorage.getItem(TOOL_DISCLOSURE_STORAGE_KEY)

    if (!raw) {
      return {}
    }

    const parsed = JSON.parse(raw) as unknown

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }

    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .filter((entry): entry is [string, boolean] => typeof entry[0] === 'string' && typeof entry[1] === 'boolean')
        .slice(-MAX_DISCLOSURE_STATES)
    )
  } catch {
    return {}
  }
}

function persistToolDisclosureStates(states: ToolDisclosureStates) {
  if (typeof window === 'undefined') {
    return
  }

  try {
    const entries = Object.entries(states).slice(-MAX_DISCLOSURE_STATES)

    window.localStorage.setItem(TOOL_DISCLOSURE_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)))
  } catch {
    // Tool disclosure is a local UI preference; ignore storage failures.
  }
}

export function setToolDisclosureOpen(id: string, open: boolean) {
  if (!id) {
    return
  }

  const current = $toolDisclosureStates.get()

  if (current[id] === open) {
    return
  }

  $toolDisclosureStates.set({ ...current, [id]: open })
}
