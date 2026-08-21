/**
 * MOBILE "chat bubbles" — a touch-first parallel-session strip that lives above
 * the composer input on mobile. Each bubble is one parallel chat; the row lets a
 * user drag-switch between them and drag-up to close one. This is the mobile
 * analog of desktop's session TILES, but decoupled from the layout-tree: there is
 * no pane graph on a phone, just an ordered list of sessions.
 *
 * Runtime model: every bubble — foreground or background, saved or draft — is
 * just a session in `$sessionStates`. Switching moves `$activeSessionKey`; it
 * does not move state anywhere.
 *
 * This used to be a hybrid: the active bubble lived in the global chat atoms and
 * a background bubble was demoted into a slice on every switch, then DROPPED and
 * re-resumed on the way back. Two async, unsynchronized steps per switch, with
 * the live slice discarded in the middle — which is how a background turn's
 * tokens ended up in the chat on screen (MJX-132). Now the only thing a switch
 * has to do is point at a different key, and a session that was streaming keeps
 * streaming into its own slice throughout.
 *
 * The store itself is platform-agnostic (directly unit-testable); only the UI
 * mount and the new-session call sites are gated to `IS_MOBILE`. On desktop the
 * list simply stays empty, so every subscription here is inert.
 */

import { readJson, writeJson } from '@/lib/storage'
import { atom, computed } from '@/store/atom'
import { requestClose } from '@/store/close-confirm'
import { $activeGatewayProfile, normalizeProfileKey } from '@/store/profile'
import { $activeStoredSessionId, newSession, openSession, sameStoredSession } from '@/store/session'
import { $activeSessionKey, isDraftKey } from '@/store/session-state-types'
import {
  dropSessionState,
  runtimeKeyForStoredSession,
  sessionKeyNeedsCloseConfirm,
  sessionTileDelegate
} from '@/store/session-states'
import { isSecondaryWindow, ownsPersistedAppState } from '@/store/windows'

/** Prompt id for the draft bubble before it owns a slice — it has no stored id
 *  and there is only ever one of it. */
const DRAFT_BUBBLE_ID = 'bubble:draft'

/** One parallel chat. `storedSessionId === null` is the DRAFT bubble (a
 *  fresh/unsaved chat with no id yet). `runtimeId` is the live session KEY when
 *  the bubble has one; it is process-scoped and never persisted. Prefer
 *  `bubbleRuntimeKey`, which also resolves a session whose stored id rotated
 *  under a background compaction (MJX-133). */
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
export const $chatBubbles = atom<ChatBubble[]>(isSecondaryWindow() ? [] : hydrate(bubblesByProfile[profileKey()] ?? []))

function persistBubbles() {
  if (!ownsPersistedAppState()) {
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
if (ownsPersistedAppState()) {
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
export const $activeBubbleIndex = computed([$chatBubbles, $activeStoredSessionId], (bubbles, activeId) =>
  bubbles.findIndex(b => b.storedSessionId === activeId)
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

/**
 * The live session key behind a bubble, following a compaction id rotation.
 *
 * The DRAFT bubble (`storedId === null`) names no session, so there is nothing
 * to look up — but it still owns a slice, the active `draft:` one, exactly like
 * the draft TILE does. Resolving it here is what makes the draft a bubble like
 * any other: its busy state and its close-confirm read through this one
 * function, so a first turn sent from a fresh chat is no longer closeable
 * without a prompt merely because its stored id hasn't landed yet.
 *
 * `isDraftKey`, not `isPlaceholderKey`: a `hydrating:` key belongs to a STORED
 * session that has a bubble of its own, and claiming it here would point the
 * draft bubble at another chat's slice — and hand its close the other chat's
 * eviction.
 */
export function bubbleRuntimeKey(storedId: null | string): null | string {
  if (!storedId) {
    const active = $activeSessionKey.get()

    return isDraftKey(active) ? active : null
  }

  return runtimeKeyForStoredSession(storedId) ?? bubbleFor(storedId)?.runtimeId ?? null
}

/** Make a COLD stored session live in its own slice, so its bubble shows real
 *  busy/unread state without being on screen. A session that already has a slice
 *  is left alone — re-resuming it would rebind the gateway's transport for that
 *  session and, mid-turn, tear its stream away from us. Best-effort: if the
 *  resume fails the bubble simply hydrates when it is next opened. */
function ensureLiveSession(storedId: null | string) {
  if (!storedId || bubbleRuntimeKey(storedId)) {
    return
  }

  void sessionTileDelegate()
    ?.resumeTile(storedId)
    .then(runtimeId => patchBubbleRuntime(storedId, runtimeId))
    .catch(() => {
      /* leave the bubble slice-less; opening it hydrates from scratch */
    })
}

/** Show a bubble. A draft starts a fresh chat; anything else opens its session —
 *  synchronously when it already has a slice.
 *
 *  Note what is NOT here: the outgoing session is not demoted, and the incoming
 *  session's slice is not dropped and re-resumed. Both sessions keep the state
 *  they had, which is the point. */
function promote(storedId: null | string) {
  if (storedId === null) {
    newSession()

    return
  }

  void openSession(storedId)
}

// ---------------------------------------------------------------------------
// Actions.
// ---------------------------------------------------------------------------

/** "Open in bubble" — add a stored session as a live BACKGROUND parallel chat
 *  WITHOUT switching to it (the mobile analog of `openSessionTile`). No-ops on the
 *  active session or one already in the row. Seeds the current session as a bubble
 *  too, so the row shows both.
 *
 *  Both no-ops compare CONVERSATIONS, not id strings — a bubble keeps the id it
 *  was opened with while auto-compression rotates the session's live one, so the
 *  sidebar row for a compacted chat names it differently from the bubble already
 *  showing it. On identity, "Open in bubble" added a second bubble onto the same
 *  `$sessionStates` slice (MJXHRM-423 — the mobile half of `openSessionTile`). */
export function addBubble(storedSessionId: string) {
  if (sameStoredSession(storedSessionId, $activeStoredSessionId.get())) {
    return
  }

  if ($chatBubbles.get().some(b => sameStoredSession(b.storedSessionId, storedSessionId))) {
    return
  }

  ensureBubble($activeStoredSessionId.get())
  setBubbles([...$chatBubbles.get(), { storedSessionId }])
  ensureLiveSession(storedSessionId)
}

/** Switch the active chat to another bubble (drag-release / tap). The outgoing
 *  session needs nothing done to it — it already owns its slice and, if it is
 *  mid-turn, keeps streaming into it. */
export function switchToBubble(target: null | string) {
  if (target === $activeStoredSessionId.get()) {
    return
  }

  promote(target)
}

/**
 * Close a bubble (drag-up → red → release) — CONFIRMING FIRST if its chat is
 * still working, exactly as the desktop tile close does.
 *
 * This is the mobile half of MJXHRM-390's close verb, and it was the half that
 * did not ask. A tile close has always run `requestCloseSessionTile`; the same
 * session behind a bubble was evicted mid-turn on a drag-up, with no prompt and
 * no undo (there is no ⌘⇧T on a phone). The prompt could not have appeared
 * either way — its dialog was mounted inside `ContribController`, which the
 * mobile shell never renders — so the fix is two-sided: the gate is shared here
 * and the dialog is mounted per window (see app/close-confirm.tsx).
 */
export function requestRemoveBubble(target: null | string) {
  if (!$chatBubbles.get().some(b => b.storedSessionId === target)) {
    return
  }

  const runtimeKey = bubbleRuntimeKey(target)

  requestClose(
    // The DRAFT bubble has no stored id, so its prompt is keyed by the slice it
    // owns — there is exactly one draft bubble, and `DRAFT_BUBBLE_ID` is the
    // floor for the moment it has no slice either.
    { close: () => removeBubble(target), id: target ?? runtimeKey ?? DRAFT_BUBBLE_ID, kind: 'session' },
    sessionKeyNeedsCloseConfirm(runtimeKey)
  )
}

/** Close a bubble unconditionally. NON-DESTRUCTIVE: removes it from the row
 *  only — the session stays in history. Its background slice is evicted. If it
 *  was the active chat, a neighbor is promoted; if the row empties, a fresh chat
 *  opens. User-facing callers want `requestRemoveBubble`. */
export function removeBubble(target: null | string) {
  const list = $chatBubbles.get()
  const idx = list.findIndex(b => b.storedSessionId === target)

  if (idx === -1) {
    return
  }

  const wasActive = target === $activeStoredSessionId.get()
  const runtimeKey = bubbleRuntimeKey(list[idx].storedSessionId)

  if (runtimeKey) {
    dropSessionState(runtimeKey)
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

/**
 * Mobile "new session": if on an EXISTING session, show a fresh draft chat and
 * keep the current one as its own bubble; if already on the draft, do nothing.
 *
 * `side` is which END of the strip the draft occupies. The overdrag gesture
 * opens a gap on one specific side and grows a ghost bubble in it, so the real
 * bubble has to land there — landing it on the other end moves the chat you
 * just watched appear. Callers with NO side (the ⌘N keybind, the sidebar row)
 * are not looking at a particular gap: they append a new draft and leave an
 * existing one exactly where it is.
 *
 * There is only ever ONE draft bubble — it is the bubble with no stored id, and
 * `bubbleRuntimeKey(null)` resolves the single active `draft:` slice for it. So
 * when one already exists, a side-bearing call MOVES it rather than adding a
 * second. It used to leave it in place and call `newSession()` anyway, which
 * switched you to a draft sitting at the far end of the strip: the row then
 * re-homed on it and every other chat was stacked on one side of the one you
 * had just asked to appear on the other.
 *
 * Returns whether a fresh chat is actually being shown, so the gesture that
 * offers this can stop offering it (bubble-row) instead of arming, buzzing and
 * then doing nothing.
 */
export function newChatBubble(side?: 'end' | 'start'): boolean {
  const active = $activeStoredSessionId.get()

  if (active === null) {
    return false
  }

  // May PREPEND, so every index below has to be read after it.
  ensureBubble(active)

  const list = $chatBubbles.get()
  const draftIdx = list.findIndex(b => b.storedSessionId === null)

  if (draftIdx === -1) {
    const draft: ChatBubble = { storedSessionId: null }

    setBubbles(side === 'start' ? [draft, ...list] : [...list, draft])
  } else if (side) {
    const draft = list[draftIdx]
    const rest = list.filter((_, i) => i !== draftIdx)

    setBubbles(side === 'start' ? [draft, ...rest] : [...rest, draft])
  }

  newSession()

  return true
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

  // A draft is the active chat but has no bubble of its own — the boot case. The
  // row hydrates from persisted ids, so `findIndex` misses, and bubble-row's
  // cold-load `?: 0` fallback then centres and highlights bubble[0]: a real,
  // unrelated chat wearing the "New session" label. Giving the draft its own
  // bubble is what stops it borrowing a neighbour's, and the fallback goes back
  // to doing only the job it was written for.
  //
  // Only when the row already HAS bubbles: there is no neighbour to squat on
  // otherwise, and seeding one here would put a bubble in a row that is empty by
  // design everywhere but mobile (see the module header).
  if (id === null) {
    if ($chatBubbles.get().length > 0) {
      ensureBubble(null)
    }

    return
  }

  // Only a fresh save transitions from a draft (null) to a brand-new id.
  if (was !== null) {
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
