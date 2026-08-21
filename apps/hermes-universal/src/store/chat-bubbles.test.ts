import { afterEach, describe, expect, it, vi } from 'vitest'

// Isolate the bubble list logic from the runtime: a controllable active-id atom
// stands in for the real session store, and the tile delegate / slice eviction
// are inert spies. This keeps the store platform-agnostic and directly testable.
vi.mock('@/store/session', async () => {
  const { atom } = await import('nanostores')
  const $activeStoredSessionId = atom<null | string>(null)
  // The loaded recents page. `sameStoredSession` is the only thing that reads it
  // here, and the rule is reproduced rather than stubbed to `a === b`, so a test
  // can actually drive the lineage branch — a stub comparing identity would pin
  // the defect this file now covers as the contract.
  const $sessions = atom<{ _lineage_root_id?: string; id: string }[]>([])

  const matches = (row: { _lineage_root_id?: string; id: string }, id: string) =>
    row.id === id || row._lineage_root_id === id

  return {
    $activeStoredSessionId,
    $sessions,
    $unreadFinishedSessionIds: atom<string[]>([]),
    $workingSessionIds: atom(new Set<string>()),
    newSession: () => $activeStoredSessionId.set(null),
    openSession: (id: string) => {
      $activeStoredSessionId.set(id)

      return Promise.resolve()
    },
    sameStoredSession: (a: null | string, b: null | string) => {
      if (!a || !b) {
        return false
      }

      if (a === b) {
        return true
      }

      const row = $sessions.get().find(session => matches(session, a))

      return Boolean(row && matches(row, b))
    }
  }
})

// The reverse index stands in for the real session map: `live` holds the stored
// ids that currently have a slice, so the store's "is this session already
// live?" questions are answerable without booting the whole session graph.
const live = new Map<string, string>()

// Which slices are "still working" — the predicate the close gate consults.
const busyKeys = new Set<string>()

vi.mock('@/store/session-states', () => ({
  dropSessionState: vi.fn(),
  runtimeKeyForStoredSession: (id: null | string) => (id ? (live.get(id) ?? null) : null),
  sessionKeyNeedsCloseConfirm: (key: null | string) => Boolean(key && busyKeys.has(key)),
  sessionTileDelegate: () => ({
    resumeTile: (id: string) => {
      live.set(id, `rt-${id}`)

      return Promise.resolve(`rt-${id}`)
    }
  })
}))

import { $activeStoredSessionId, $sessions } from '@/store/session'
import { $activeSessionKey } from '@/store/session-state-types'
import { dropSessionState, sessionTileDelegate } from '@/store/session-states'

import {
  $chatBubbles,
  addBubble,
  newChatBubble,
  removeBubble,
  requestRemoveBubble,
  switchToBubble
} from './chat-bubbles'
import { $pendingClose, resolvePendingClose } from './close-confirm'

const ids = () => $chatBubbles.get().map(b => b.storedSessionId)

afterEach(() => {
  while ($pendingClose.get()) {
    resolvePendingClose($pendingClose.get()!.token, false)
  }

  $chatBubbles.set([])
  $activeStoredSessionId.set(null)
  ;($sessions as unknown as { set: (v: unknown[]) => void }).set([])
  $activeSessionKey.set('')
  busyKeys.clear()
  live.clear()
  vi.clearAllMocks()
})

describe('chat-bubbles store', () => {
  it('addBubble seeds the current session, appends the new one, and dedupes', () => {
    $activeStoredSessionId.set('a')

    addBubble('b')
    // The current session ('a') becomes its own bubble so the row shows both.
    expect(ids()).toEqual(['a', 'b'])

    addBubble('b') // already present
    expect(ids()).toEqual(['a', 'b'])

    addBubble('a') // the active session
    expect(ids()).toEqual(['a', 'b'])
  })

  it('switchToBubble promotes the target to active', () => {
    $activeStoredSessionId.set('a')
    addBubble('b')

    switchToBubble('b')
    expect($activeStoredSessionId.get()).toBe('b')
  })

  it('removeBubble is non-destructive and just drops the row entry', () => {
    $activeStoredSessionId.set('a')
    addBubble('b') // ['a','b'], active 'a'

    removeBubble('b')
    expect(ids()).toEqual(['a'])
    expect($activeStoredSessionId.get()).toBe('a') // untouched
  })

  it('removing the active bubble promotes a neighbor', () => {
    $activeStoredSessionId.set('a')
    addBubble('b') // ['a','b'], active 'a'

    removeBubble('a')
    expect(ids()).toEqual(['b'])
    expect($activeStoredSessionId.get()).toBe('b') // neighbor promoted
  })

  it('closing the last bubble opens a fresh chat', () => {
    $activeStoredSessionId.set('a')
    addBubble('b')
    removeBubble('a') // -> ['b'] active 'b'
    removeBubble('b') // empties

    expect(ids()).toEqual([])
    expect($activeStoredSessionId.get()).toBeNull()
  })

  // MJXHRM-390 — the mobile half of the close verb, and the half that did not
  // ask. A tile close has always run `requestCloseSessionTile`; the same session
  // behind a bubble was evicted mid-turn on a drag-up with no prompt and no undo
  // (there is no ⌘⇧T on a phone).
  describe('requestRemoveBubble (the drag-up close)', () => {
    it('closes a settled chat with no prompt', () => {
      $activeStoredSessionId.set('a')
      addBubble('b')
      live.set('b', 'rt-b')

      requestRemoveBubble('b')

      expect($pendingClose.get()).toBeNull()
      expect(ids()).toEqual(['a'])
    })

    it('asks before dropping a chat that is still working, and leaves it alone if declined', () => {
      $activeStoredSessionId.set('a')
      addBubble('b')
      live.set('b', 'rt-b')
      busyKeys.add('rt-b')

      requestRemoveBubble('b')

      expect($pendingClose.get()).toMatchObject({ id: 'b', kind: 'session' })
      expect(ids()).toEqual(['a', 'b'])
      expect(dropSessionState).not.toHaveBeenCalled()

      resolvePendingClose($pendingClose.get()!.token, false)
      expect(ids()).toEqual(['a', 'b'])

      requestRemoveBubble('b')
      resolvePendingClose($pendingClose.get()!.token, true)
      expect(ids()).toEqual(['a'])
      expect(dropSessionState).toHaveBeenCalledWith('rt-b')
    })

    // The DRAFT bubble names no session, so `bubbleRuntimeKey` returned null and
    // the gate had nothing to read — a first turn sent from a fresh chat was
    // closeable without a prompt purely because its id had not landed yet. The
    // draft TILE has resolved its placeholder slice since `tileRuntimeKey`.
    it('guards the draft bubble through the placeholder slice it owns', () => {
      $activeStoredSessionId.set('a')
      newChatBubble() // ['a', null], active = the draft
      $activeSessionKey.set('draft:1')
      busyKeys.add('draft:1')

      requestRemoveBubble(null)

      expect($pendingClose.get()).toMatchObject({ id: 'draft:1', kind: 'session' })
      expect(ids()).toEqual(['a', null])
    })

    // `isDraftKey`, not `isPlaceholderKey`: a `hydrating:` key belongs to a
    // STORED session with a bubble of its own, and claiming it for the draft
    // would hand the draft's close another chat's eviction.
    it('does not claim a hydrating session\u2019s slice for the draft', () => {
      $activeStoredSessionId.set('a')
      newChatBubble()
      $activeSessionKey.set('hydrating:a')
      busyKeys.add('hydrating:a')

      requestRemoveBubble(null)

      expect($pendingClose.get()).toBeNull()
      expect(ids()).toEqual(['a'])
    })

    it('ignores a bubble that is not in the row', () => {
      $activeStoredSessionId.set('a')

      requestRemoveBubble('gone')

      expect($pendingClose.get()).toBeNull()
    })
  })

  it('newChatBubble on an existing session spawns a draft and keeps the current one', () => {
    $activeStoredSessionId.set('a')

    newChatBubble()
    expect(ids()).toEqual(['a', null]) // current + draft
    expect($activeStoredSessionId.get()).toBeNull() // now on the draft
  })

  it('newChatBubble puts the draft on the side it was pulled open from', () => {
    $activeStoredSessionId.set('a')
    addBubble('b') // ['a','b']

    // Overdragging RIGHT opens the gap before the first bubble, and that is
    // where the ghost the user watched grow was drawn.
    newChatBubble('start')
    expect(ids()).toEqual([null, 'a', 'b'])
  })

  // There is only ever ONE draft bubble, so a side-bearing call cannot add a
  // second — it has to MOVE the one there is. It used to leave it in place and
  // call newSession() anyway, which switched you to a draft parked at the far
  // end: the row re-homed on it and every other chat stacked up on one side of
  // the chat you had just asked to appear on the other.
  it('newChatBubble moves an existing draft to the side it was pulled open from', () => {
    $activeStoredSessionId.set('a')
    addBubble('b') // ['a','b']
    newChatBubble('end') // ['a','b', null], active = the draft

    // Back to a real chat, then pull the OTHER end open.
    switchToBubble('a')
    newChatBubble('start')

    expect(ids()).toEqual([null, 'a', 'b'])
    expect($activeStoredSessionId.get()).toBeNull()
  })

  // The ⌘N keybind and the sidebar row are not looking at a particular gap, so
  // they must not reorder the row behind the user.
  it('newChatBubble with no side leaves an existing draft where it is', () => {
    $activeStoredSessionId.set('a')
    addBubble('b') // ['a','b']
    newChatBubble('start') // [null,'a','b']

    switchToBubble('b')
    newChatBubble()

    expect(ids()).toEqual([null, 'a', 'b'])
    expect($activeStoredSessionId.get()).toBeNull()
  })

  it('newChatBubble on a draft is a no-op', () => {
    $activeStoredSessionId.set(null) // already a draft

    // False is what the bubble row reads to stop offering the gesture at all,
    // instead of arming, buzzing and then doing nothing.
    expect(newChatBubble()).toBe(false)
    expect(ids()).toEqual([])
  })

  it('adopts a draft bubble id when a new chat is first saved', () => {
    $activeStoredSessionId.set('a')
    newChatBubble() // ['a', null], active null (draft)

    // First submit saves the draft: registerNewSession sets active null -> 'new'.
    $activeStoredSessionId.set('new')

    expect(ids()).toEqual(['a', 'new']) // the draft became a real bubble
  })

  it('does NOT adopt when switching from a draft to an existing bubble', () => {
    $activeStoredSessionId.set('a')
    addBubble('b') // ['a','b']
    newChatBubble() // ['a','b', null], active null (draft)

    // Switching to 'b' also moves active null -> 'b', but 'b' already has a
    // bubble, so the draft must NOT be folded into it.
    switchToBubble('b')

    expect(ids()).toEqual(['a', 'b', null])
    expect($activeStoredSessionId.get()).toBe('b')
  })
  // MJX-132. Switching used to demote the outgoing session into a slice and
  // DROP + re-resume the incoming one — two async steps that discarded live
  // state mid-switch, which is how a background turn's tokens reached the chat
  // on screen. A switch must now touch neither session's slice.
  it('switching preserves both sessions live slices', () => {
    $activeStoredSessionId.set('a')
    addBubble('b')
    expect(live.get('b')).toBe('rt-b') // the background bubble was made live

    switchToBubble('b')

    expect($activeStoredSessionId.get()).toBe('b')
    expect(dropSessionState).not.toHaveBeenCalled()
    expect(live.get('b')).toBe('rt-b') // never discarded and re-resumed
  })

  // Re-resuming a session that already has a slice would rebind its transport
  // on the gateway and, mid-turn, tear its stream away from us.
  it('does not re-resume a session that is already live', () => {
    const resumeTile = vi.spyOn(sessionTileDelegate()!, 'resumeTile')
    live.set('b', 'rt-b')

    $activeStoredSessionId.set('a')
    addBubble('b')

    expect(resumeTile).not.toHaveBeenCalled()
  })

  /**
   * MJXHRM-423 — the mobile half of `openSessionTile`'s one-tile-per-conversation
   * rule. A bubble keeps the id its chat was opened with; the sidebar row of that
   * same chat names its live tip after a compaction. Compared as strings, "Open
   * in bubble" from that row added a SECOND bubble onto one live slice.
   */
  it('does not add a second bubble for a session already in the row under another id', () => {
    ;($sessions as unknown as { set: (v: unknown[]) => void }).set([{ _lineage_root_id: 'root', id: 'tip' }])
    $activeStoredSessionId.set('a')
    addBubble('root')
    expect(ids()).toEqual(['a', 'root'])

    addBubble('tip')

    expect(ids()).toEqual(['a', 'root'])
  })

  it('does not bubble the conversation already in the active chat under another id', () => {
    ;($sessions as unknown as { set: (v: unknown[]) => void }).set([{ _lineage_root_id: 'root', id: 'tip' }])
    $activeStoredSessionId.set('tip')

    addBubble('root')

    expect(ids()).toEqual([])
  })

  it('still bubbles a genuinely different session', () => {
    ;($sessions as unknown as { set: (v: unknown[]) => void }).set([{ _lineage_root_id: 'root', id: 'tip' }])
    $activeStoredSessionId.set('a')
    addBubble('root')

    addBubble('unrelated')

    expect(ids()).toEqual(['a', 'root', 'unrelated'])
  })

  // MJX-133: a background auto-compaction rotates the stored id, and the bubble
  // still names the pre-rotation one. The reverse index aliases it, so the
  // bubble keeps resolving to the live slice instead of going stale.
  it('follows a session whose stored id rotated under compaction', () => {
    $activeStoredSessionId.set('a')
    addBubble('b')

    // The slice rotated: 'b' is now an alias for the same live session.
    live.set('b', 'rt-b-compacted')

    removeBubble('b')

    expect(dropSessionState).toHaveBeenCalledWith('rt-b-compacted')
  })

  // The boot case. Bubbles hydrate from persisted ids while the active chat is a
  // draft, so the row could not find the active session and `bubble-row`'s
  // cold-load fallback centred bubble[0] — a real, unrelated chat presenting
  // itself as "New session". The draft needs a bubble of its own to stop it
  // borrowing a neighbour's.
  it('gives an active draft its own bubble when the row already has some', () => {
    $chatBubbles.set([{ storedSessionId: 'a' }, { storedSessionId: 'b' }])

    $activeStoredSessionId.set('a')
    $activeStoredSessionId.set(null)

    expect(ids()).toEqual([null, 'a', 'b'])
  })

  it('does not stack up draft bubbles', () => {
    $chatBubbles.set([{ storedSessionId: 'a' }])

    $activeStoredSessionId.set('a')
    $activeStoredSessionId.set(null)
    $activeStoredSessionId.set('a')
    $activeStoredSessionId.set(null)

    expect(ids().filter(id => id === null)).toHaveLength(1)
  })

  // Off mobile the row is empty by design, and a lone draft bubble has nothing
  // to sit beside — there is no neighbour for it to have been squatting on.
  it('seeds nothing into an empty row', () => {
    $activeStoredSessionId.set('a')
    $chatBubbles.set([])

    $activeStoredSessionId.set(null)

    expect(ids()).toEqual([])
  })
})
