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

vi.mock('@/store/session-states', () => ({
  dropSessionState: vi.fn(),
  sessionTileDelegate: () => ({ resumeTile: (id: string) => Promise.resolve(`rt-${id}`) })
}))

import { $activeStoredSessionId } from '@/store/session'

import { $chatBubbles, addBubble, newChatBubble, removeBubble, switchToBubble } from './chat-bubbles'

const ids = () => $chatBubbles.get().map(b => b.storedSessionId)

afterEach(() => {
  $chatBubbles.set([])
  $activeStoredSessionId.set(null)
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
})
