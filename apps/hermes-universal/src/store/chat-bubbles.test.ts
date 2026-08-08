import { afterEach, describe, expect, it, vi } from 'vitest'

// Isolate the bubble list logic from the runtime: a controllable active-id atom
// stands in for the real session store, and the tile delegate / slice eviction
// are inert spies. This keeps the store platform-agnostic and directly testable.
vi.mock('@/store/session', async () => {
  const { atom } = await import('nanostores')
  const $activeStoredSessionId = atom<null | string>(null)

  return {
    $activeStoredSessionId,
    $sessions: atom([]),
    $unreadFinishedSessionIds: atom<string[]>([]),
    $workingSessionIds: atom(new Set<string>()),
    newSession: () => $activeStoredSessionId.set(null),
    openSession: (id: string) => {
      $activeStoredSessionId.set(id)

      return Promise.resolve()
    }
  }
})

// The reverse index stands in for the real session map: `live` holds the stored
// ids that currently have a slice, so the store's "is this session already
// live?" questions are answerable without booting the whole session graph.
const live = new Map<string, string>()

vi.mock('@/store/session-states', () => ({
  dropSessionState: vi.fn(),
  runtimeKeyForStoredSession: (id: null | string) => (id ? (live.get(id) ?? null) : null),
  sessionTileDelegate: () => ({
    resumeTile: (id: string) => {
      live.set(id, `rt-${id}`)

      return Promise.resolve(`rt-${id}`)
    }
  })
}))

import { $activeStoredSessionId } from '@/store/session'
import { dropSessionState, sessionTileDelegate } from '@/store/session-states'

import { $chatBubbles, addBubble, newChatBubble, removeBubble, switchToBubble } from './chat-bubbles'

const ids = () => $chatBubbles.get().map(b => b.storedSessionId)

afterEach(() => {
  $chatBubbles.set([])
  $activeStoredSessionId.set(null)
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

  it('newChatBubble on a draft is a no-op', () => {
    $activeStoredSessionId.set(null) // already a draft

    newChatBubble()
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
