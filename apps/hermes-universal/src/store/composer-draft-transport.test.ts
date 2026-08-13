/**
 * How a draft crosses a window boundary (MJXHRM-424).
 *
 * `composer-handoff.test.ts` covers the MERGE — what happens to this window's map
 * once another window's text arrives. This file covers the part before that: how
 * the news gets here at all.
 *
 * It matters because the transport that shipped could not be checked. A
 * `storage` listener under Tauri either works or silently does nothing depending
 * on the WebView implementation, and either way the code path looks identical
 * from the outside. So every case here asserts something OBSERVABLE on the bus:
 * what was emitted, what was ignored, and — for the one direction that can lose
 * text — whether anybody actually answered.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const bus = vi.hoisted(() => {
  const listeners = new Map<string, Set<(payload: unknown) => void>>()

  return {
    /** Stand in for another window putting something on the bus. */
    deliver(event: string, payload: unknown) {
      for (const handler of listeners.get(event) ?? []) {
        handler(payload)
      }
    },
    emit: vi.fn(async (_event: string, _payload: unknown) => undefined),
    /** How many handlers are armed for `event` right now. */
    listenerCount: (event: string) => listeners.get(event)?.size ?? 0,
    listen: vi.fn(async (event: string, handler: (received: { payload: unknown }) => void) => {
      const wrapped = (payload: unknown) => handler({ payload })
      const forEvent = listeners.get(event) ?? new Set()

      forEvent.add(wrapped)
      listeners.set(event, forEvent)

      return () => forEvent.delete(wrapped)
    }),
    reset() {
      listeners.clear()
      bus.emit.mockClear()
      bus.listen.mockClear()
    }
  }
})

vi.mock('@tauri-apps/api/event', () => ({ emit: bus.emit, listen: bus.listen }))

// The bus only exists under a real runtime, and this whole file is about what
// happens there — off Tauri every broadcast in it is a deliberate no-op.
vi.mock('@/lib/platform', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  IS_TAURI: true
}))

/** Which window the one running the test IS. Settable: a flush is ADDRESSED, so
 *  answering one meant for somebody else is the failure.
 *
 *  Two fields because a window kind needs both to be named: a detached tile
 *  window is `surface: null` exactly like the main window, and the HUD is
 *  `tile: null` exactly like it too. */
const here = vi.hoisted(() => ({ surface: null as null | string, tile: null as null | string }))

vi.mock('@/store/windows', () => ({
  addressesThisWindow: (address: { surface: null | string; tile: null | string }) =>
    address.surface === here.surface && address.tile === here.tile
}))

const { onComposerDraftSyncRequest } = await import('@/lib/composer-draft-bus')

const {
  reloadPersistedDrafts,
  requestPeerComposerFlush,
  SESSION_DRAFTS_STORAGE_KEY,
  stashSessionDraft,
  takeSessionDraft
} = await import('./composer')

const STASH_EVENT = 'composer-draft://changed'
const FLUSH_EVENT = 'composer-draft://flush'
const FLUSHED_EVENT = 'composer-draft://flushed'

/** The two windows that get asked to flush today: the HUD on its dismissal, and
 *  a detached tile's host on its reattach (MJXHRM-398). */
const HUD = { surface: 'hud', tile: null }
const TILE = { surface: null, tile: 'session-tile:abc' }

/** What this window put on the bus for `event`, oldest first. */
function emitted(event: string): Record<string, unknown>[] {
  return bus.emit.mock.calls.filter(([name]) => name === event).map(([, payload]) => payload as Record<string, unknown>)
}

/** The nonce of the flush request this window most recently sent. */
function lastFlushNonce(): string {
  const requests = emitted(FLUSH_EVENT)

  return requests[requests.length - 1]?.nonce as string
}

beforeEach(() => {
  window.localStorage.clear()

  for (const scope of ['a', 'b']) {
    stashSessionDraft(scope, '', [])
  }

  window.localStorage.clear()
  // Storage is empty again, so the dedupe baseline has to be too — otherwise the
  // first stash of a case compares equal to the previous case's and says nothing.
  reloadPersistedDrafts()
  here.surface = null
  here.tile = null
  bus.emit.mockClear()
})

describe('announcing a draft this window wrote', () => {
  it('tells the other windows, stamped with who said it', () => {
    stashSessionDraft('a', 'typed here', [])

    const said = emitted(STASH_EVENT)

    expect(said).toHaveLength(1)
    // The stamp is what lets a receiver drop its own echo; `emit` is global and
    // delivers to the sender too.
    expect(typeof said[0].origin).toBe('string')
    expect(said[0].origin).toBeTruthy()
  })

  it('carries no draft in the payload', () => {
    stashSessionDraft('a', 'typed here', [])

    // The text is already on disk. A copy on the wire could only disagree with
    // it, and would be the version a peer painted.
    expect(Object.keys(emitted(STASH_EVENT)[0])).toEqual(['origin'])
  })

  it('says nothing when the stash did not actually change', () => {
    stashSessionDraft('a', 'typed here', [])
    stashSessionDraft('a', 'typed here', [])

    // This is the loop-breaker: a peer that reloads paints its composer, and
    // painting schedules that composer's own debounced re-stash of the text it
    // was just handed. Announcing that would bounce the event back forever.
    expect(emitted(STASH_EVENT)).toHaveLength(1)
  })

  it('says something again once the text really moves on', () => {
    stashSessionDraft('a', 'typed here', [])
    stashSessionDraft('a', 'typed here too', [])

    expect(emitted(STASH_EVENT)).toHaveLength(2)
  })

  it('announces a draft being cleared', () => {
    stashSessionDraft('a', 'typed here', [])
    bus.emit.mockClear()

    stashSessionDraft('a', '', [])

    // A send in one window has to empty the box in the other.
    expect(emitted(STASH_EVENT)).toHaveLength(1)
    expect(window.localStorage.getItem(SESSION_DRAFTS_STORAGE_KEY)).toBeNull()
  })

  it('writes what a peer wrote even when this window wrote the same text before', () => {
    stashSessionDraft('a', 'mine', [])

    // The peer takes over the file.
    window.localStorage.setItem(SESSION_DRAFTS_STORAGE_KEY, JSON.stringify({ a: 'theirs' }))
    reloadPersistedDrafts()

    // Now this window ends up back on its own earlier text. Deduping against a
    // baseline that is no longer what is on disk would skip this write, leaving
    // storage saying "theirs" while the composer shows "mine".
    stashSessionDraft('a', 'mine', [])

    expect(window.localStorage.getItem(SESSION_DRAFTS_STORAGE_KEY)).toBe(JSON.stringify({ a: 'mine' }))
  })
})

describe('hearing a draft another window wrote', () => {
  it('picks the text up and asks a mounted composer to repaint', () => {
    const heard = vi.fn()
    const off = onComposerDraftSyncRequest(heard)

    window.localStorage.setItem(SESSION_DRAFTS_STORAGE_KEY, JSON.stringify({ b: 'from over there' }))
    bus.deliver(STASH_EVENT, { origin: 'another-webview' })

    expect(takeSessionDraft('b').text).toBe('from over there')
    expect(heard).toHaveBeenCalledWith('reload')

    off()
  })

  it('ignores its own echo', () => {
    const ourOrigin = emitted(STASH_EVENT)[0]?.origin ?? stashOrigin()
    const heard = vi.fn()
    const off = onComposerDraftSyncRequest(heard)

    window.localStorage.setItem(SESSION_DRAFTS_STORAGE_KEY, JSON.stringify({ b: 'ours' }))
    bus.deliver(STASH_EVENT, { origin: ourOrigin })

    // Acting on it would re-read the stash this window just wrote and repaint
    // the editor the user is typing in.
    expect(heard).not.toHaveBeenCalled()

    off()
  })

  it('does not re-announce what it just heard', () => {
    window.localStorage.setItem(SESSION_DRAFTS_STORAGE_KEY, JSON.stringify({ b: 'from over there' }))
    bus.deliver(STASH_EVENT, { origin: 'another-webview' })

    expect(emitted(STASH_EVENT)).toHaveLength(0)
  })

  it('does not listen for `storage` under Tauri', () => {
    const heard = vi.fn()
    const off = onComposerDraftSyncRequest(heard)

    window.localStorage.setItem(SESSION_DRAFTS_STORAGE_KEY, JSON.stringify({ b: 'from over there' }))
    window.dispatchEvent(new StorageEvent('storage', { key: SESSION_DRAFTS_STORAGE_KEY }))

    // Two live transports would make the runtime check unfalsifiable — a working
    // handoff would say nothing about which one carried it.
    expect(heard).not.toHaveBeenCalled()

    off()
  })
})

/** This window's identity, read off anything it has already put on the bus. */
function stashOrigin(): unknown {
  stashSessionDraft('a', `origin probe ${Math.random()}`, [])

  return emitted(STASH_EVENT).at(-1)?.origin
}

describe('serving a flush another window asked for', () => {
  it('writes the editor down and says so, quoting the request', () => {
    const heard = vi.fn()
    const off = onComposerDraftSyncRequest(heard)

    bus.deliver(FLUSH_EVENT, { nonce: 'n-1', origin: 'another-webview', surface: null, tile: null })

    expect(heard).toHaveBeenCalledWith('flush')
    expect(emitted(FLUSHED_EVENT)).toHaveLength(1)
    // The nonce is what makes the answer belong to this question rather than to
    // whichever flush happened to be in flight.
    expect(emitted(FLUSHED_EVENT)[0].nonce).toBe('n-1')

    off()
  })

  it('flushes BEFORE answering', () => {
    const order: string[] = []
    const off = onComposerDraftSyncRequest(mode => order.push(`sync:${mode}`))

    bus.emit.mockImplementation(async (event: string) => {
      order.push(`emit:${event}`)
    })

    bus.deliver(FLUSH_EVENT, { nonce: 'n-1', origin: 'another-webview', surface: null, tile: null })

    // "Acknowledged" has to mean "the text is on disk". The asker is about to
    // destroy this window on the strength of it.
    expect(order).toEqual(['sync:flush', `emit:${FLUSHED_EVENT}`])

    off()
    bus.emit.mockImplementation(async () => undefined)
  })

  it('ignores a request addressed to another surface', () => {
    const heard = vi.fn()
    const off = onComposerDraftSyncRequest(heard)

    bus.deliver(FLUSH_EVENT, { nonce: 'n-1', origin: 'another-webview', surface: 'hud', tile: null })

    // This window is the ordinary one. Answering for the HUD would both lie and
    // put this window's copy of a shared conversation on top of the HUD's.
    expect(heard).not.toHaveBeenCalled()
    expect(emitted(FLUSHED_EVENT)).toHaveLength(0)

    off()
  })

  it('answers when it IS the surface addressed', () => {
    here.surface = 'hud'

    const heard = vi.fn()
    const off = onComposerDraftSyncRequest(heard)

    bus.deliver(FLUSH_EVENT, { nonce: 'n-1', origin: 'another-webview', surface: 'hud', tile: null })

    expect(heard).toHaveBeenCalledWith('flush')
    expect(emitted(FLUSHED_EVENT)).toHaveLength(1)

    off()
  })

  it('answers when it is the detached tile window addressed', () => {
    here.tile = 'session-tile:abc'

    const heard = vi.fn()
    const off = onComposerDraftSyncRequest(heard)

    bus.deliver(FLUSH_EVENT, { nonce: 'n-1', origin: 'the-main-window', ...TILE })

    // A tile window is not a satellite, so a surface alone could never have
    // reached it — which is why reattach used to have nothing to ask
    // (MJXHRM-398).
    expect(heard).toHaveBeenCalledWith('flush')
    expect(emitted(FLUSHED_EVENT)).toHaveLength(1)

    off()
  })

  it('does not answer for a DIFFERENT tile window', () => {
    here.tile = 'session-tile:zzz'

    const heard = vi.fn()
    const off = onComposerDraftSyncRequest(heard)

    bus.deliver(FLUSH_EVENT, { nonce: 'n-1', origin: 'the-main-window', ...TILE })

    // Several tiles can be detached at once, each in its own window, and they
    // are all `surface: null`. Answering for a sibling would put its copy of a
    // shared conversation on top of the one being reattached.
    expect(heard).not.toHaveBeenCalled()
    expect(emitted(FLUSHED_EVENT)).toHaveLength(0)

    off()
  })

  it('does not let the main window answer a tile window’s flush', () => {
    const heard = vi.fn()
    const off = onComposerDraftSyncRequest(heard)

    bus.deliver(FLUSH_EVENT, { nonce: 'n-1', origin: 'the-main-window', ...TILE })

    // `here` is the ordinary window — the one that ASKED. Serving its own
    // request would report success with the peer's text still unwritten.
    expect(heard).not.toHaveBeenCalled()
    expect(emitted(FLUSHED_EVENT)).toHaveLength(0)

    off()
  })
})

describe('asking another window to flush', () => {
  it('reports success only when that window answered', async () => {
    const pending = requestPeerComposerFlush(HUD, 200)

    // Let the listener registration round trip resolve before the peer answers.
    await Promise.resolve()
    await Promise.resolve()

    window.localStorage.setItem(SESSION_DRAFTS_STORAGE_KEY, JSON.stringify({ b: 'typed in the HUD' }))
    bus.deliver(FLUSHED_EVENT, { nonce: lastFlushNonce(), origin: 'the-hud' })

    expect(await pending).toBe(true)
    // The answer means the text is on disk, so it is taken now rather than left
    // to the CHANGED announcement to come round separately.
    expect(takeSessionDraft('b').text).toBe('typed in the HUD')
  })

  it('reports failure when nobody answered', async () => {
    // The difference this whole file exists for: emitting into a void and
    // returning cleanly is indistinguishable from a flush that worked.
    expect(await requestPeerComposerFlush(HUD, 10)).toBe(false)
  })

  it('does not count an answer to somebody else’s question', async () => {
    const pending = requestPeerComposerFlush(HUD, 20)

    await Promise.resolve()
    await Promise.resolve()

    bus.deliver(FLUSHED_EVENT, { nonce: 'a-different-request', origin: 'the-hud' })

    expect(await pending).toBe(false)
  })

  it('addresses the surface it was asked about', async () => {
    const pending = requestPeerComposerFlush(HUD, 10)

    await Promise.resolve()
    await Promise.resolve()

    expect(emitted(FLUSH_EVENT).at(-1)?.surface).toBe('hud')
    // Carried even when it is null: the address is compared field by field, so a
    // missing `tile` and an explicit `null` have to be the same question.
    expect(emitted(FLUSH_EVENT).at(-1)?.tile).toBeNull()

    await pending
  })

  it('addresses the tile it was asked about', async () => {
    const pending = requestPeerComposerFlush(TILE, 10)

    await Promise.resolve()
    await Promise.resolve()

    expect(emitted(FLUSH_EVENT).at(-1)?.tile).toBe('session-tile:abc')
    expect(emitted(FLUSH_EVENT).at(-1)?.surface).toBeNull()

    await pending
  })

  it('stops listening once it has an answer', async () => {
    const before = bus.listenerCount(FLUSHED_EVENT)

    const answered = requestPeerComposerFlush(HUD, 200)

    await Promise.resolve()
    await Promise.resolve()

    expect(bus.listenerCount(FLUSHED_EVENT)).toBe(before + 1)

    bus.deliver(FLUSHED_EVENT, { nonce: lastFlushNonce(), origin: 'the-hud' })
    await answered

    // Armed for one question and taken down with it. A listener left behind
    // stacks one per dismissal, for the life of the window.
    expect(bus.listenerCount(FLUSHED_EVENT)).toBe(before)
  })

  it('stops listening when nobody answers either', async () => {
    const before = bus.listenerCount(FLUSHED_EVENT)

    expect(await requestPeerComposerFlush(HUD, 10)).toBe(false)
    expect(bus.listenerCount(FLUSHED_EVENT)).toBe(before)
  })
})
