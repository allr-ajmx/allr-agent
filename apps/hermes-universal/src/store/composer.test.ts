/**
 * A composer draft has to follow its session when the session's KEY moves.
 *
 * Session keys move twice in normal use: `session.create` promotes a `draft:N`
 * to a real runtime id the first time a chat needs a backend, and a resume after
 * sleep/wake mints a fresh runtime id for a conversation that already had one.
 * Both go through `rekeySession`, and both used to strand the draft — text,
 * attachments, the localStorage mirror and the tab's title — under a key nothing
 * would read again.
 *
 * The gesture that made it visible is dropping a file on an unsent chat
 * (MJXHRM-A1). Staging an attachment calls `ensureSession()`, so the rekey lands
 * mid-drop, and the composer's per-thread swap effect — which cannot tell "my own
 * session just got its real id" from "the user switched chats" — reloaded from
 * the new key, found nothing, and blanked both the typed message and every chip
 * the user had already staged.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import {
  type ComposerAttachment,
  draftTitleFor,
  isSessionDraftRekey,
  renameSessionDraft,
  SESSION_DRAFTS_STORAGE_KEY,
  stashSessionDraft,
  takeSessionDraft
} from './composer'
import { $activeSessionKey, rekeySession } from './session-state-types'

const attachment = (id: string): ComposerAttachment => ({ id, kind: 'image', label: `${id}.png` })

const persisted = (): Record<string, string> => {
  const raw = window.localStorage.getItem(SESSION_DRAFTS_STORAGE_KEY)

  return raw ? (JSON.parse(raw) as Record<string, string>) : {}
}

beforeEach(() => {
  // Every key these cases touch, cleared through the real API so the in-memory
  // map and its mirror agree before each run.
  for (const key of ['draft:1', 'draft:2', 'sess-live', 'sess-old', 'sess-new', '__new__']) {
    stashSessionDraft(key, '', [])
  }

  window.localStorage.clear()
})

describe('a draft follows its session across a rekey', () => {
  it('moves text and attachments onto the new key', () => {
    stashSessionDraft('draft:1', 'half a sentence', [attachment('shot')])

    rekeySession('draft:1', 'sess-live', { runtimeSessionId: 'sess-live' })

    const moved = takeSessionDraft('sess-live')

    expect(moved.text).toBe('half a sentence')
    expect(moved.attachments.map(a => a.id)).toEqual(['shot'])
  })

  it('leaves nothing behind under the old key', () => {
    stashSessionDraft('draft:1', 'half a sentence', [attachment('shot')])

    rekeySession('draft:1', 'sess-live', { runtimeSessionId: 'sess-live' })

    expect(takeSessionDraft('draft:1')).toEqual({ attachments: [], text: '' })
  })

  it('moves the localStorage mirror too', () => {
    // The mirror is what a reload — and every other window — reads. A move that
    // only touched the in-memory map would look fixed until the app restarted.
    stashSessionDraft('draft:1', 'half a sentence', [])

    rekeySession('draft:1', 'sess-live', { runtimeSessionId: 'sess-live' })

    expect(persisted()).toEqual({ 'sess-live': 'half a sentence' })
  })

  it('moves the published draft title', () => {
    // What the tab shows while a chat has no name of its own.
    stashSessionDraft('draft:1', 'half a sentence', [])

    rekeySession('draft:1', 'sess-live', { runtimeSessionId: 'sess-live' })

    expect(draftTitleFor('sess-live')).toBe('half a sentence')
    expect(draftTitleFor('draft:1')).toBe('')
  })

  it('follows a SECOND rekey, the sleep/wake one', () => {
    // `withSessionNotFoundResume` rekeys an already-live session onto a fresh
    // runtime id. Same move, same loss — the draft-chat case is not special.
    stashSessionDraft('sess-old', 'typed before the laptop slept', [attachment('shot')])

    rekeySession('sess-old', 'sess-new', { runtimeSessionId: 'sess-new' })

    expect(takeSessionDraft('sess-new').text).toBe('typed before the laptop slept')
    expect(takeSessionDraft('sess-new').attachments.map(a => a.id)).toEqual(['shot'])
  })

  it('leaves an unrelated draft alone', () => {
    stashSessionDraft('draft:1', 'moving', [])
    stashSessionDraft('draft:2', 'staying', [])

    rekeySession('draft:1', 'sess-live', { runtimeSessionId: 'sess-live' })

    expect(takeSessionDraft('draft:2').text).toBe('staying')
  })
})

describe('isSessionDraftRekey', () => {
  it('reports a rekey the composer can act on', () => {
    // The half a MOUNTED composer needs: its text is in the contenteditable DOM,
    // not in the stash, so moving the stash cannot save it — only knowing not to
    // repaint can.
    renameSessionDraft('draft:1', 'sess-live')

    expect(isSessionDraftRekey('draft:1', 'sess-live')).toBe(true)
  })

  it('reports a rekey even when there was no draft to move', () => {
    // THE case this exists for. Text typed inside the 400ms persist debounce has
    // never reached the stash, and an attachment staged by the very drop that
    // triggered the rekey lives in the scope's `$attachments`, not here. The map
    // is empty at rename time in exactly the situation that matters.
    expect(takeSessionDraft('draft:2').text).toBe('')

    renameSessionDraft('draft:2', 'sess-live')

    expect(isSessionDraftRekey('draft:2', 'sess-live')).toBe(true)
  })

  it('does not report a genuine chat switch', () => {
    // The whole point of the discrimination: switching chats MUST still stash
    // and repaint, or the composer would carry one conversation's text into
    // another. `switch-a` was never rekeyed onto `switch-b`; the user simply
    // clicked a different row.
    renameSessionDraft('switch-a', 'switch-a-live')

    expect(isSessionDraftRekey('switch-a-live', 'switch-b')).toBe(false)
    expect(isSessionDraftRekey('switch-a', 'switch-b')).toBe(false)
  })

  it('does not report the reverse of a rekey', () => {
    // Direction matters: arriving BACK at a key that was once rekeyed away is a
    // switch, not a continuation.
    renameSessionDraft('reverse-from', 'reverse-to')

    expect(isSessionDraftRekey('reverse-to', 'reverse-from')).toBe(false)
  })

  it('answers about the PAIR, not about either key on its own', () => {
    // The record is a directed edge. Two chats that were each rekeyed do not
    // become continuations of each other.
    renameSessionDraft('pair-a', 'pair-a-live')
    renameSessionDraft('pair-b', 'pair-b-live')

    expect(isSessionDraftRekey('pair-a', 'pair-b-live')).toBe(false)
    expect(isSessionDraftRekey('pair-a', 'pair-a-live')).toBe(true)
  })

  it('is false when the key did not change', () => {
    expect(isSessionDraftRekey('draft:1', 'draft:1')).toBe(false)
    expect(isSessionDraftRekey(null, null)).toBe(false)
  })

  it('forgets old rekeys rather than growing without bound', () => {
    // Only ever consulted on the one React flush that follows the rename, so the
    // history is deliberately short. A leak here would be a leak per new chat.
    renameSessionDraft('draft:1', 'sess-live')

    for (let i = 0; i < 12; i += 1) {
      renameSessionDraft(`filler-from-${i}`, `filler-to-${i}`)
    }

    expect(isSessionDraftRekey('draft:1', 'sess-live')).toBe(false)
    expect(isSessionDraftRekey('filler-from-11', 'filler-to-11')).toBe(true)
  })
})

describe('rekeySession keeps the active key in step', () => {
  it('points the active key at the new id', () => {
    // Not this module's behaviour, but the reason the composer sees the change at
    // all — the composer's session scope IS this atom.
    $activeSessionKey.set('draft:1')
    stashSessionDraft('draft:1', 'typed', [])

    rekeySession('draft:1', 'sess-live', { runtimeSessionId: 'sess-live' })

    expect($activeSessionKey.get()).toBe('sess-live')
    expect(isSessionDraftRekey('draft:1', 'sess-live')).toBe(true)
  })
})
