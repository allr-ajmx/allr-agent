import { describe, expect, it } from 'vitest'

import type { ChatMessage } from '@/lib/chat-messages'
import {
  comparableText,
  hasStructuralParts,
  isLiveTailRow,
  isStrictAnswerTextExtension,
  preserveEmbeddedImages,
  preserveLocalPendingTurnMessages,
  preserveStructuralParts,
  reconcileLiveTail,
  reconcileResumeMessages,
  shouldProjectInflightDump,
  textWithoutReferenceLines,
  userMessagesMatch,
  userTurnAlreadyPersisted
} from '@/lib/live-tail'

const user = (id: string, text: string): ChatMessage => ({ id, role: 'user', parts: [{ type: 'text', text }] })

const reply = (id: string, text: string, patch: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  role: 'assistant',
  parts: [{ type: 'text', text }],
  ...patch
})

const structured = (id: string, text: string, patch: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  role: 'assistant',
  parts: [
    { type: 'reasoning', text: 'thinking' },
    { type: 'tool-call', toolCallId: 't1', toolName: 'terminal', args: {} },
    { type: 'text', text }
  ],
  ...patch
})

describe('the vocabulary', () => {
  it('calls a row structural only for reasoning or tool parts', () => {
    expect(hasStructuralParts(structured('a', 'x'))).toBe(true)
    expect(hasStructuralParts(reply('a', 'x'))).toBe(false)
  })

  it('recognizes a live-tail row by the pending flag or a projected id', () => {
    expect(isLiveTailRow(reply('a', 'x', { pending: true }))).toBe(true)
    expect(isLiveTailRow(reply('assistant-stream-s1', 'x'))).toBe(true)
    expect(isLiveTailRow(reply('inflight-assistant-s1', 'x'))).toBe(true)
    expect(isLiveTailRow(reply('h3-assistant', 'x'))).toBe(false)
  })

  // The gateway rewrites references on the way through, so the round-tripped
  // copy of a message would otherwise look like a different message.
  it('strips whole reference lines but keeps an inline one', () => {
    expect(textWithoutReferenceLines('@file:/abs/path.ts\nfix this')).toBe('fix this')
    expect(textWithoutReferenceLines('@session:work/s1\n@url:https://x\nhi')).toBe('hi')
    expect(textWithoutReferenceLines('look at @file:x.ts please')).toBe('look at @file:x.ts please')
  })

  it('matches user turns across a reference rewrite', () => {
    expect(userMessagesMatch(user('u1', '@image:/tmp/a.png\nwhat is this'), user('h1', 'what  is this'))).toBe(true)
    expect(userMessagesMatch(user('u1', 'one thing'), user('h1', 'another thing'))).toBe(false)
  })

  // Without this, an empty answer accepts any flat dump as its continuation —
  // which is exactly how the dump ends up sandwiched between structured rows.
  it('refuses an extension over an empty previous answer', () => {
    expect(isStrictAnswerTextExtension('hello there', 'hello')).toBe(true)
    expect(isStrictAnswerTextExtension('hello there', '')).toBe(false)
    expect(isStrictAnswerTextExtension('unrelated', 'hello')).toBe(false)
  })
})

describe('shouldProjectInflightDump', () => {
  it('skips the flat dump when the live turn is already structured', () => {
    expect(shouldProjectInflightDump([user('u1', 'go'), structured('assistant-stream-s1', 'partial')], false)).toBe(
      false
    )
  })

  it('projects it when the live row is text-only, or when there is none', () => {
    expect(shouldProjectInflightDump([user('u1', 'go'), reply('assistant-stream-s1', 'partial')], false)).toBe(true)
    expect(shouldProjectInflightDump([user('u1', 'go')], false)).toBe(true)
  })

  // A retained failed turn is the only record of that failure the client gets.
  it('always projects an error, even behind a structured row', () => {
    expect(shouldProjectInflightDump([user('u1', 'go'), structured('assistant-stream-s1', 'partial')], true)).toBe(true)
  })

  // After a compression an unrelated settled row can carry tool calls. Treating
  // it as "the current turn" would graft its work onto a turn it had no part in.
  it('does not mistake a settled structured row for the current turn', () => {
    const messages = [structured('h1', 'old answer'), user('u2', 'new prompt')]

    expect(shouldProjectInflightDump(messages, false)).toBe(true)
  })
})

describe('userTurnAlreadyPersisted', () => {
  it('matches the latest user run through a reference rewrite', () => {
    const messages = [user('h1', 'do a thing'), reply('assistant-stream-s1', '', { pending: true })]

    expect(userTurnAlreadyPersisted(messages, '@file:/x.ts\ndo   a thing')).toBe(true)
  })

  // The same words legitimately recur in a long conversation; matching an older
  // one would suppress a real repeat.
  it('does not match an older turn behind a settled reply', () => {
    const messages = [user('h1', 'do a thing'), reply('h2', 'done'), user('h3', 'something else')]

    expect(userTurnAlreadyPersisted(messages, 'do a thing')).toBe(false)
  })

  it('is false for empty text', () => {
    expect(userTurnAlreadyPersisted([user('h1', 'x')], '   ')).toBe(false)
  })
})

describe('preserveStructuralParts', () => {
  // The backend snapshot is a flat pair of strings; the local slice is the only
  // place the turn's reasoning and tool calls exist.
  it('carries structure onto a text-only authoritative row', () => {
    const out = preserveStructuralParts(reply('h2', 'thinking partial'), structured('assistant-stream-s1', 'partial'))

    expect(out.parts.map(p => p.type)).toEqual(['reasoning', 'tool-call', 'text'])
  })

  // A settled historical row can share a role ordinal with an unrelated new
  // turn after a compression, and must not lend it its tool calls.
  it('refuses to carry from a row that is no longer the live tail', () => {
    const settledLocal = structured('h1', 'old answer')

    expect(preserveStructuralParts(reply('h2', 'new'), settledLocal)).toMatchObject({ id: 'h2' })
    expect(preserveStructuralParts(reply('h2', 'new'), settledLocal).parts.map(p => p.type)).toEqual(['text'])
  })

  it('keeps the local answer when the incoming text does not extend it', () => {
    const local = structured('assistant-stream-s1', 'the real answer')
    const out = preserveStructuralParts(reply('h2', 'a lossy restatement'), local)
    const text = out.parts.filter(p => p.type === 'text').map(p => ('text' in p ? p.text : ''))

    expect(text).toEqual(['the real answer'])
  })

  it('takes the incoming text when it strictly extends what we rendered', () => {
    const local = structured('assistant-stream-s1', 'the real')
    const out = preserveStructuralParts(reply('h2', 'the real answer'), local)
    const text = out.parts.filter(p => p.type === 'text').map(p => ('text' in p ? p.text : ''))

    expect(text).toEqual(['the real answer'])
  })

  it('leaves an already-structured authoritative row alone', () => {
    const authoritative = structured('h2', 'x')

    expect(preserveStructuralParts(authoritative, structured('assistant-stream-s1', 'y'))).toBe(authoritative)
  })
})

describe('preserveEmbeddedImages', () => {
  // Long enough to clear the extractor's minimum payload length.
  const dataUrl = `data:image/png;base64,${'A'.repeat(80)}`

  it('re-attaches a payload the round trip stripped', () => {
    const out = preserveEmbeddedImages(user('h1', 'what is this'), user('u1', `what is this\n${dataUrl}`))

    expect(comparableText(out)).toBe('what is this')
    expect(out.parts).toHaveLength(2)
  })

  it('leaves a different message alone', () => {
    const authoritative = user('h1', 'something else')

    expect(preserveEmbeddedImages(authoritative, user('u1', `what is this\n${dataUrl}`))).toBe(authoritative)
  })

  it('does not double up when the payload survived', () => {
    const authoritative = user('h1', `what is this\n${dataUrl}`)

    expect(preserveEmbeddedImages(authoritative, user('u1', `what is this\n${dataUrl}`))).toBe(authoritative)
  })
})

describe('reconcileResumeMessages', () => {
  it('pairs by role ordinal, since committed ids never match optimistic ones', () => {
    const authoritative = [user('h1', 'go'), reply('h2', 'partial')]
    const previous = [user('u1', 'go'), structured('assistant-stream-s1', 'partial')]
    const out = reconcileResumeMessages(authoritative, previous)

    expect(out[1].parts.map(p => p.type)).toEqual(['reasoning', 'tool-call', 'text'])
  })

  it('is identity when there is nothing local to carry', () => {
    const authoritative = [user('h1', 'go'), reply('h2', 'done')]

    expect(reconcileResumeMessages(authoritative, [])).toBe(authoritative)
    expect(reconcileResumeMessages(authoritative, [user('u1', 'go'), reply('a1', 'done')])).toBe(authoritative)
  })
})

describe('preserveLocalPendingTurnMessages', () => {
  // While the turn was finishing, the commit shifted the reply one ordinal
  // earlier; re-appending the optimistic twin renders the same answer twice.
  it('drops a settled local row the authoritative set already holds', () => {
    const authoritative = [user('h1', 'go'), reply('h2', 'the answer')]
    const previous = [user('u1', 'go'), reply('assistant-stream-s1', 'the answer')]

    expect(preserveLocalPendingTurnMessages(authoritative, previous)).toBe(authoritative)
  })

  it('keeps a local row nothing else holds — it is the only copy', () => {
    const authoritative = [user('h1', 'go')]
    const previous = [user('u1', 'go'), reply('assistant-stream-s1', 'never committed', { pending: true })]
    const out = preserveLocalPendingTurnMessages(authoritative, previous)

    expect(out.map(m => m.id)).toEqual(['h1', 'assistant-stream-s1'])
  })

  // MJXHRM-358. The authoritative row for a STILL-RUNNING turn is a snapshot
  // taken later than ours, so it reads as the same answer plus more of it — and
  // `reconcileResumeMessages` has by then already carried our structure onto it.
  // Appending the prefix we rendered would print the answer twice, once
  // truncated: the exact sandwich this module exists to prevent.
  it('drops a local row the authoritative one continues', () => {
    const authoritative = [user('h1', 'go'), reply('assistant-stream-s1', 'the answer, continued', { pending: true })]
    const previous = [user('u1', 'go'), reply('local-a1', 'the answer', { pending: true })]

    expect(preserveLocalPendingTurnMessages(authoritative, previous)).toBe(authoritative)
  })

  // The continuation rule is assistant-only: one user message being a prefix of
  // another is a coincidence, not the same message written twice.
  it('does not treat a user row as continued by a longer one', () => {
    const authoritative = [user('h1', 'do the thing and then some')]
    const previous = [user('user-inflight-s1', 'do the thing')]
    const out = preserveLocalPendingTurnMessages(authoritative, previous)

    expect(out.map(m => m.id)).toEqual(['h1', 'user-inflight-s1'])
  })

  it('ignores settled local history — only the live tail is carried', () => {
    const authoritative = [user('h1', 'go')]

    expect(preserveLocalPendingTurnMessages(authoritative, [reply('h9', 'an old answer')])).toBe(authoritative)
  })

  it('never re-adds a row already present by id', () => {
    const row = reply('assistant-stream-s1', 'x', { pending: true })

    expect(preserveLocalPendingTurnMessages([row], [row])).toEqual([row])
  })
})

describe('reconcileLiveTail', () => {
  // The whole point: history catches up mid-turn, and the finished reply
  // renders exactly once with its structure intact.
  it('carries structure and does not duplicate the finished reply', () => {
    const authoritative = [user('h1', 'go'), reply('h2', 'the answer')]
    const previous = [user('u1', 'go'), structured('assistant-stream-s1', 'the answer', { pending: true })]
    const out = reconcileLiveTail(authoritative, previous)

    expect(out).toHaveLength(2)
    expect(out[1].id).toBe('h2')
    expect(out[1].parts.map(p => p.type)).toEqual(['reasoning', 'tool-call', 'text'])
  })
})
