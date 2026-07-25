/**
 * MOBILE "chat bubbles" — a touch-first parallel-session strip that lives above
 * the composer input on mobile. Each bubble is one parallel chat; the row lets a
 * user drag-switch between them and drag-up to close one. This is the mobile
 * analog of desktop's session TILES, but decoupled from the layout-tree: there is
 * no pane graph on a phone, just an ordered list of sessions.
 *
 * Runtime model (hybrid, least-invasive):
 *  - The ACTIVE bubble is always the PRIMARY chat (`store/chat.ts` globals,
 *    rendered by the existing mobile ChatScreen). This also makes a not-yet-saved
 *    DRAFT bubble work for free — a draft has no id, so it can only live in the
 *    primary globals, never in `$sessionStates` (which is keyed by runtime id).
 *  - BACKGROUND bubbles are kept live as `$sessionStates` slices via the existing
 *    tile delegate (`sessionTileDelegate().resumeTile`) — the exact "keep a stored
 *    session live in its own slice" primitive, with no layout-tree dependency.
 *  - Switching = demote the outgoing primary into a slice + promote the target via
 *    `openSession` (which re-hydrates the primary and sets `$activeStoredSessionId`).
 *
 * The store itself is platform-agnostic (directly unit-testable); only the UI
 * mount and the new-session call sites are gated to `IS_MOBILE`. On desktop the
 * list simply stays empty, so every subscription here is inert.
 */

import { readJson, writeJson } from '@/lib/storage'
import { atom, computed } from '@/store/atom'
import { $activeGatewayProfile, normalizeProfileKey } from '@/store/profile'
import { $activeStoredSessionId, newSession, openSession } from '@/store/session'
import { dropSessionState, sessionTileDelegate } from '@/store/session-states'
import { isSecondaryWindow } from '@/store/windows'

/** One parallel chat. `storedSessionId === null` is the single DRAFT bubble (a
 *  fresh/unsaved chat with no id yet). `runtimeId` is set only while the bubble is
 *  a live BACKGROUND slice; it is process-scoped and never persisted. */
export interface ChatBubble {
  storedSessionId: null | string
  runtimeId?: string
}

// ---------------------------------------------------------------------------
// Per-profile persistence (mirrors store/session-states.ts tile persistence).
// Only real stored ids are persisted — drafts + runtime ids are ephemeral.
// ---------------------------------------------------------------------------

const BUBBLES_KEY = 'hermes.chatBubbles.v1'

function parseIdList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
}

function loadBubblesByProfile(): Record<string, string[]> {
  const byProfile: Record<string, string[]> = {}
  const parsed = readJson<unknown>(BUBBLES_KEY)

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (const [profile, list] of Object.entries(parsed as Record<string, unknown>)) {
      const ids = parseIdList(list)

      if (ids.length > 0) {
        byProfile[normalizeProfileKey(profile)] = ids
      }
    }
  }

  return byProfile
}

const bubblesByProfile = loadBubblesByProfile()
const profileKey = () => normalizeProfileKey($activeGatewayProfile.get())

const hydrate = (ids: string[]): ChatBubble[] => ids.map(storedSessionId => ({ storedSessionId }))

/** Ordered parallel chats. A secondary window shows none (single live gateway). */
export const $chatBubbles = atom<ChatBubble[]>(
  isSecondaryWindow() ? [] : hydrate(bubblesByProfile[profileKey()] ?? [])
)

function persistBubbles() {
  if (isSecondaryWindow()) {
    return
  }

  writeJson(BUBBLES_KEY, Object.keys(bubblesByProfile).length === 0 ? null : bubblesByProfile)
}

function setBubbles(bubbles: ChatBubble[]) {
  $chatBubbles.set(bubbles)

  const stored = bubbles.map(b => b.storedSessionId).filter((id): id is string => Boolean(id))

  if (stored.length > 0) {
    bubblesByProfile[profileKey()] = stored
  } else {
    delete bubblesByProfile[profileKey()]
  }

  persistBubbles()
}

// Profile switch: surface the new profile's bubbles with runtime ids cleared.
if (!isSecondaryWindow()) {
  $activeGatewayProfile.subscribe(() => {
    $chatBubbles.set(hydrate(bubblesByProfile[profileKey()] ?? []))
  })
}

// ---------------------------------------------------------------------------
// Derivations.
// ---------------------------------------------------------------------------

/** Index of the active bubble — the one whose `storedSessionId` matches the
 *  active stored id, or the DRAFT bubble when nothing is loaded. `-1` when the
 *  active session isn't represented in the row. */
export const $activeBubbleIndex = computed(
  [$chatBubbles, $activeStoredSessionId],
  (bubbles, activeId) => bubbles.findIndex(b => b.storedSessionId === activeId)
)

// ---------------------------------------------------------------------------
// Internals.
// ---------------------------------------------------------------------------

const bubbleFor = (storedId: null | string) => $chatBubbles.get().find(b => b.storedSessionId === storedId)

function patchBubbleRuntime(storedId: null | string, runtimeId: string | undefined) {
  setBubbles($chatBubbles.get().map(b => (b.storedSessionId === storedId ? { ...b, runtimeId } : b)))
}

/** Seed the current session as a bubble at the front of the row if it isn't one
 *  already — so opening a second chat shows BOTH (the current + the new one). */
function ensureBubble(storedId: null | string) {
  if (!$chatBubbles.get().some(b => b.storedSessionId === storedId)) {
    setBubbles([{ storedSessionId: storedId }, ...$chatBubbles.get()])
  }
}

/** Keep a stored session LIVE in a background `$sessionStates` slice. A draft has
 *  no id and nothing to keep live, so it is a no-op. Best-effort: if the resume
 *  fails the bubble simply re-hydrates from scratch when next promoted. */
function demote(storedId: null | string) {
  if (!storedId) {
    return
  }

  void sessionTileDelegate()
    ?.resumeTile(storedId)
    .then(runtimeId => patchBubbleRuntime(storedId, runtimeId))
    .catch(() => {
      /* leave the bubble slice-less; a later promote re-hydrates it */
    })
}

/** Make a bubble the PRIMARY chat. A draft resets to a fresh chat; a stored
 *  session hydrates via `openSession` and its background slice (if any) is
 *  dropped, since it now lives on the primary atoms. */
function promote(storedId: null | string) {
  if (storedId === null) {
    newSession()

    return
  }

  const bubble = bubbleFor(storedId)

  if (bubble?.runtimeId) {
    dropSessionState(bubble.runtimeId)
    patchBubbleRuntime(storedId, undefined)
  }

  void openSession(storedId)
}

// ---------------------------------------------------------------------------
// Actions.
// ---------------------------------------------------------------------------

/** "Open in bubble" — add a stored session as a live BACKGROUND parallel chat
 *  WITHOUT switching to it (the mobile analog of `openSessionTile`). No-ops on the
 *  active session or one already in the row. Seeds the current session as a bubble
 *  too, so the row shows both. */
export function addBubble(storedSessionId: string) {
  if (storedSessionId === $activeStoredSessionId.get()) {
    return
  }

  if ($chatBubbles.get().some(b => b.storedSessionId === storedSessionId)) {
    return
  }

  ensureBubble($activeStoredSessionId.get())
  setBubbles([...$chatBubbles.get(), { storedSessionId }])
  demote(storedSessionId)
}

/** Switch the active chat to another bubble (drag-release / tap). Demotes the
 *  outgoing primary into a live slice, promotes the target. */
export function switchToBubble(target: null | string) {
  const prev = $activeStoredSessionId.get()

  if (target === prev) {
    return
  }

  demote(prev)
  promote(target)
}

/** Close a bubble (drag-up → red → release). NON-DESTRUCTIVE: removes it from the
 *  row only — the session stays in history. Its background slice is evicted. If it
 *  was the active chat, a neighbor is promoted; if the row empties, a fresh chat
 *  opens. */
export function removeBubble(target: null | string) {
  const list = $chatBubbles.get()
  const idx = list.findIndex(b => b.storedSessionId === target)

  if (idx === -1) {
    return
  }

  const wasActive = target === $activeStoredSessionId.get()
  const removed = list[idx]

  if (removed.runtimeId) {
    dropSessionState(removed.runtimeId)
  }

  const next = list.filter((_, i) => i !== idx)
  setBubbles(next)

  if (!wasActive) {
    return
  }

  if (next.length === 0) {
    newSession()

    return
  }

  // Promote the bubble that slid into this slot (or the new last one).
  const neighbor = next[Math.min(idx, next.length - 1)]
  promote(neighbor.storedSessionId)
}

/** Mobile "new session": if on an EXISTING session, spawn a NEW draft bubble and
 *  keep the current one as its own bubble; if already on a draft, do nothing. */
export function newChatBubble() {
  const active = $activeStoredSessionId.get()

  if (active === null) {
    return
  }

  ensureBubble(active)
  demote(active)

  if (!$chatBubbles.get().some(b => b.storedSessionId === null)) {
    setBubbles([...$chatBubbles.get(), { storedSessionId: null }])
  }

  newSession()
}

// ---------------------------------------------------------------------------
// Draft-id adoption. When a draft bubble's chat is saved on first submit
// (`registerNewSession` sets the active id null → <id>), fold that id into the
// draft bubble so it becomes a real, persisted bubble. We must NOT do this on a
// plain switch away from the draft (also null → <id>): those target a session
// that already has its own bubble, so guard on "the id isn't already a bubble".
// ---------------------------------------------------------------------------

let prevActiveId = $activeStoredSessionId.get()

$activeStoredSessionId.subscribe(id => {
  const was = prevActiveId
  prevActiveId = id

  // Only a fresh save transitions from a draft (null) to a brand-new id.
  if (was !== null || id === null) {
    return
  }

  const list = $chatBubbles.get()
  const draftIdx = list.findIndex(b => b.storedSessionId === null)

  // No draft to adopt, or this id already has a bubble ⇒ it's a switch, not a save.
  if (draftIdx === -1 || list.some(b => b.storedSessionId === id)) {
    return
  }

  const next = list.slice()
  next[draftIdx] = { storedSessionId: id }
  setBubbles(next)
})
