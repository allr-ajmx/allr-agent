import { describe, expect, it } from 'vitest'

import type { ChatPart, ToolCallPart } from '@/store/chat'
import type { SessionMessage } from '@/types/hermes'

import { appendLiveSessionProjection, toChatMessages } from './session-history'

const msg = (m: Partial<SessionMessage>): SessionMessage => m as SessionMessage
const tools = (parts: ChatPart[]): ToolCallPart[] => parts.filter((p): p is ToolCallPart => p.type === 'tool-call')

const texts = (parts: ChatPart[]): string[] =>
  parts.filter((p): p is Extract<ChatPart, { type: 'text' }> => p.type === 'text').map(p => p.text)

describe('toChatMessages', () => {
  it('converts plain user/assistant text', () => {
    const out = toChatMessages([msg({ role: 'user', content: 'hi' }), msg({ role: 'assistant', content: 'hello' })])
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ role: 'user', parts: [{ type: 'text', text: 'hi' }] })
    expect(out[1]).toMatchObject({ role: 'assistant', parts: [{ type: 'text', text: 'hello' }] })
  })

  it('adds a reasoning part before assistant text', () => {
    const out = toChatMessages([msg({ role: 'assistant', content: 'answer', reasoning: 'because' })])
    expect(out[0].parts.map(p => p.type)).toEqual(['reasoning', 'text'])
    expect(out[0].parts[0]).toMatchObject({ type: 'reasoning', text: 'because' })
  })

  it('attaches a tool result to the tool-call by tool_call_id', () => {
    const out = toChatMessages([
      msg({
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 't1', function: { name: 'grep', arguments: { q: 'x' } } }]
      }),
      msg({ role: 'tool', tool_call_id: 't1', content: '42 matches' })
    ])

    const tool = tools(out.flatMap(m => m.parts))[0]
    expect(tool).toMatchObject({ toolName: 'grep', result: '42 matches' })
    expect(tool.args).toEqual({ q: 'x' })
  })

  it('matches a tool result by name when no id is present', () => {
    const out = toChatMessages([
      msg({ role: 'assistant', content: '', tool_calls: [{ function: { name: 'ls' } }] }),
      msg({ role: 'tool', tool_name: 'ls', content: 'a b c' })
    ])

    expect(tools(out.flatMap(m => m.parts))[0]).toMatchObject({ toolName: 'ls', result: 'a b c' })
  })

  it('groups a tool-only assistant onto the surrounding text turn', () => {
    const out = toChatMessages([
      msg({ role: 'assistant', content: 'let me check' }),
      msg({ role: 'assistant', content: '', tool_calls: [{ id: 't1', function: { name: 'grep' } }] }),
      msg({ role: 'tool', tool_call_id: 't1', content: 'ok' }),
      msg({ role: 'assistant', content: 'done' })
    ])

    const assistants = out.filter(m => m.role === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(tools(assistants[0].parts)).toHaveLength(1)
    expect(texts(assistants[0].parts)).toEqual(['let me check', 'done'])
  })

  it('dedupes duplicate tool-call ids', () => {
    const out = toChatMessages([
      msg({
        role: 'assistant',
        content: 'x',
        tool_calls: [
          { id: 'dup', function: { name: 'a' } },
          { id: 'dup', function: { name: 'b' } }
        ]
      })
    ])

    const ids = tools(out.flatMap(m => m.parts)).map(t => t.toolCallId)
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
  })
})

// Scaffolding the model was fed, persisted as role:'user' and TAGGED by the
// gateway so a surface renders the event rather than the text. Universal
// rendered all three as the user's own words — and, because it counts the user
// rows it renders to build `truncate_before_user_ordinal`, every rewind after
// one of them cut at the wrong turn.
describe('display-only timeline rows', () => {
  it('renders the crash-recovery note as an event, not the user speaking', () => {
    const out = toChatMessages([
      msg({ role: 'user', content: 'first prompt' }),
      msg({
        role: 'user',
        content: '[System note: Your previous turn was interrupted mid-run — …]\n\nfirst prompt',
        display_kind: 'auto_continue'
      }),
      msg({ role: 'assistant', content: 'done' })
    ])

    expect(out.map(m => m.role)).toEqual(['user', 'system', 'assistant'])
    expect(texts(out[1].parts)).toEqual(['resumed interrupted turn'])
    // The ordinal space the gateway rewinds by counts one user turn here, and
    // so does the transcript now.
    expect(out.filter(m => m.role === 'user')).toHaveLength(1)
  })

  it('names a model switch and a delegation batch', () => {
    const out = toChatMessages([
      msg({ role: 'user', content: '[System: model changed to x]', display_kind: 'model_switch' }),
      msg({
        role: 'user',
        content: 'background work finished',
        display_kind: 'async_delegation_complete',
        display_metadata: { task_count: 3 }
      }),
      msg({
        role: 'user',
        content: 'background work finished',
        display_kind: 'async_delegation_complete'
      })
    ])

    expect(out.map(m => m.role)).toEqual(['system', 'system', 'system'])
    expect(out.flatMap(m => texts(m.parts))).toEqual([
      'model changed',
      '3 background agents finished',
      'background agent work finished'
    ])
  })

  // The gateway counts these in the ordinal space, so universal must keep
  // rendering them as user turns or the two disagree again in the other
  // direction.
  it('leaves a skill invocation as the user turn it is', () => {
    const out = toChatMessages([msg({ role: 'user', content: '/review', display_kind: 'skill_invocation' })])

    expect(out.map(m => m.role)).toEqual(['user'])
    expect(texts(out[0].parts)).toEqual(['/review'])
  })

  it('keeps a timeline event from swallowing the tool calls around it', () => {
    const out = toChatMessages([
      msg({ role: 'assistant', content: '', tool_calls: [{ id: 't1', function: { name: 'grep', arguments: {} } }] }),
      msg({ role: 'tool', tool_call_id: 't1', content: 'ok' }),
      msg({ role: 'user', content: '[System: model changed]', display_kind: 'model_switch' }),
      msg({ role: 'assistant', content: 'after' })
    ])

    expect(out.map(m => m.role)).toEqual(['assistant', 'system', 'assistant'])
    expect(tools(out[0].parts)).toHaveLength(1)
    // The later reply must not inherit the earlier turn's tool row.
    expect(tools(out[2].parts)).toHaveLength(0)
  })
})

describe('appendLiveSessionProjection', () => {
  it('is a no-op when nothing is in flight', () => {
    const stored = toChatMessages([msg({ role: 'user', content: 'hi' })])

    expect(appendLiveSessionProjection(stored, { session_id: 's1' })).toBe(stored)
  })

  // The committed transcript ends before the running turn, so a mid-turn resume
  // needs the pending assistant back — otherwise the turn's remaining tool
  // events open a fresh bubble that never settles.
  it('projects the running turn with a pending assistant', () => {
    const out = appendLiveSessionProjection(toChatMessages([msg({ role: 'user', content: 'older' })]), {
      inflight: { assistant: 'working on it', streaming: true, user: 'do the thing' },
      session_id: 's1'
    })

    expect(out.slice(-2)).toMatchObject([
      { role: 'user', parts: [{ type: 'text', text: 'do the thing' }] },
      { role: 'assistant', pending: true, parts: [{ type: 'text', text: 'working on it' }] }
    ])
  })

  // A correction accepted mid-turn lives on the snapshot ALONGSIDE the prompt
  // that started the turn, never over it. Dropping it here repainted the thread
  // on reconnect with the user's correction missing — "my message vanished".
  it('rebuilds mid-turn corrections between the prompt and the reply', () => {
    const out = appendLiveSessionProjection([], {
      inflight: { corrections: ['actually do this', '  '], streaming: true, user: 'do the thing' },
      session_id: 's1'
    })

    expect(out.map(m => m.role)).toEqual(['user', 'user', 'assistant'])
    expect(out[0]).toMatchObject({ parts: [{ type: 'text', text: 'do the thing' }] })
    expect(out[1]).toMatchObject({ parts: [{ type: 'text', text: 'actually do this' }] })
  })

  // A correction can be the ONLY thing the snapshot carries (the prompt itself
  // already committed to history before the turn was redirected).
  it('projects a correction even with nothing else in flight', () => {
    const out = appendLiveSessionProjection([], {
      inflight: { corrections: ['actually do this'] },
      session_id: 's1'
    })

    expect(out.map(m => m.role)).toEqual(['user', 'assistant'])
  })

  // MJXHRM-358: the projection now also runs on RECONNECT, against a slice that
  // already holds the corrections the user typed in this process. Re-appending
  // them would render every correction again on each drop / re-open.
  it('does not re-project a correction the transcript already shows', () => {
    const messages = [
      { id: 'u1', role: 'user' as const, parts: [{ type: 'text' as const, text: 'do the thing' }] },
      { id: 'u2', role: 'user' as const, parts: [{ type: 'text' as const, text: 'actually do this' }] }
    ]

    const out = appendLiveSessionProjection(messages, {
      inflight: { corrections: ['actually do this'], streaming: true, user: 'do the thing' },
      session_id: 's1'
    })

    expect(out.filter(m => m.role === 'user')).toHaveLength(2)
  })

  it('projects an accepted queued prompt after the running turn', () => {
    const out = appendLiveSessionProjection([], {
      inflight: { streaming: true, user: 'first' },
      queued: { user: 'second' },
      session_id: 's1'
    })

    expect(out.map(m => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(out[2]).toMatchObject({ parts: [{ type: 'text', text: 'second' }] })
  })

  // MJXHRM-358. `_fail_inflight_turn` retains a failed turn precisely because
  // its terminal `error` frame can die with the socket, so on a reconnect this
  // snapshot is the ONLY copy of that failure the client gets. The row it forces
  // into existence carried no error at all, so the turn came back looking like a
  // healthy (truncated) reply with the spinner cleared.
  it('carries a retained failure onto the projected row', () => {
    const out = appendLiveSessionProjection([], {
      inflight: {
        assistant: 'I started to',
        error: 'provider connection reset',
        streaming: false,
        user: 'do the thing'
      },
      session_id: 's1'
    })

    expect(out.map(m => m.role)).toEqual(['user', 'assistant'])
    expect(out[1]).toMatchObject({ error: 'provider connection reset', pending: false })
  })

  // The partial text is optional — a turn can fail before it says anything, and
  // the failure still has to reach the transcript.
  it('projects a failure with no partial text at all', () => {
    const out = appendLiveSessionProjection([], {
      inflight: { assistant: '', error: 'context length exceeded', streaming: false, user: '' },
      session_id: 's1'
    })

    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ role: 'assistant', error: 'context length exceeded' })
  })
})

describe('restoring a multi-step turn', () => {
  // Each model step is stored as its own assistant row (reasoning + tool_calls)
  // followed by its tool results; they hydrate into ONE bubble whose parts keep
  // the original thinking → tool → thinking → tool chronology.
  it('keeps every thinking and tool block in order', () => {
    const out = toChatMessages([
      msg({ role: 'user', content: 'do it' }),
      msg({
        role: 'assistant',
        content: '',
        reasoning: 'think 1',
        tool_calls: [{ id: 'a', function: { name: 'terminal' } }]
      }),
      msg({ role: 'tool', tool_call_id: 'a', tool_name: 'terminal', content: 'ok' }),
      msg({
        role: 'assistant',
        content: '',
        reasoning: 'think 2',
        tool_calls: [{ id: 'b', function: { name: 'execute_code' } }]
      }),
      msg({ role: 'tool', tool_call_id: 'b', tool_name: 'execute_code', content: 'Traceback' }),
      msg({ role: 'assistant', content: 'Done.', reasoning: 'think 3' })
    ])

    const assistant = out.filter(m => m.role === 'assistant')
    expect(assistant).toHaveLength(1)
    expect(assistant[0].parts.map(p => (p.type === 'tool-call' ? `tool:${p.toolName}` : `${p.type}`))).toEqual([
      'reasoning',
      'tool:terminal',
      'reasoning',
      'tool:execute_code',
      'reasoning',
      'text'
    ])
  })
})

// The gateway's `session.resume` payload is display-REDUCED
// (`_history_to_messages`): assistant rows that only made tool calls are gone,
// and every tool result is flattened to {role, name, context} with no id. It is
// only the fallback now (openSession hydrates from REST), but it must still not
// collapse repeated calls to the same tool into one row.
describe('reduced (session.resume) transcripts', () => {
  it('keeps one row per call when the tool rows carry no ids', () => {
    const out = toChatMessages([
      msg({ role: 'user', content: 'do it' }),
      msg({ role: 'tool', name: 'terminal', context: 'ls -la' }),
      msg({ role: 'tool', name: 'execute_code', context: 'python x.py' }),
      msg({ role: 'tool', name: 'terminal', context: 'git status' }),
      msg({ role: 'tool', name: 'terminal', context: 'git diff' }),
      msg({ role: 'assistant', content: 'Done.', reasoning: 'wrapping up' })
    ])

    const toolParts = tools(out.flatMap(m => m.parts))
    expect(toolParts.map(t => t.toolName)).toEqual(['terminal', 'execute_code', 'terminal', 'terminal'])
    expect(new Set(toolParts.map(t => t.toolCallId)).size).toBe(4)
  })

  it('does not let a later result rewrite a settled row from an earlier turn', () => {
    const out = toChatMessages([
      msg({ role: 'user', content: 'first' }),
      msg({ role: 'tool', name: 'terminal', context: 'ls' }),
      msg({ role: 'assistant', content: 'first answer' }),
      msg({ role: 'user', content: 'second' }),
      msg({ role: 'tool', name: 'terminal', context: 'pwd' }),
      msg({ role: 'assistant', content: 'second answer' })
    ])

    const toolParts = tools(out.flatMap(m => m.parts))
    expect(toolParts).toHaveLength(2)
    expect(toolParts.map(t => t.args?.context)).toEqual(['ls', 'pwd'])
  })
})

describe('attached context', () => {
  const withContext = (prose: string, attached: string) =>
    texts(toChatMessages([msg({ role: 'user', content: `${prose}\n--- Attached Context ---\n${attached}` })])[0].parts)

  it('hides the attached block itself — the injected file contents never reach the bubble', () => {
    const [text] = withContext('look at this', '📄 @file:src/app.ts (120 tokens)\n\nexport const secret = 1')

    expect(text).not.toContain('export const secret')
    expect(text).not.toContain('120 tokens')
    expect(text).toContain('look at this')
  })

  it('hoists a ref the prose no longer carries so it still chips', () => {
    expect(withContext('look at this', '📄 @file:src/app.ts (120 tokens)')).toEqual([
      '@file:src/app.ts\n\nlook at this'
    ])
  })

  it('does not re-list a ref the prose already contains', () => {
    expect(withContext('check @file:src/app.ts please', '📄 @file:src/app.ts (120 tokens)')).toEqual([
      'check @file:src/app.ts please'
    ])
  })

  it('dedupes a ref attached more than once', () => {
    expect(withContext('go', '@file:a.ts\n@file:a.ts\n@url:https://x.dev')).toEqual([
      '@file:a.ts\n@url:https://x.dev\n\ngo'
    ])
  })

  it('keeps the refs when the prose is empty', () => {
    expect(withContext('', '@file:a.ts')).toEqual(['@file:a.ts'])
  })

  it('strips a trailing context-warnings block', () => {
    const out = toChatMessages([msg({ role: 'user', content: 'hi\n--- Context Warnings ---\ntoo big' })])

    expect(texts(out[0].parts)).toEqual(['hi'])
  })
})

describe('durable identity and reactions', () => {
  const heart = { at: 1, author: 'user' as const, emoji: '❤️' }

  it('carries the durable row id onto the hydrated message', () => {
    const out = toChatMessages([msg({ role: 'user', content: 'hi', row_id: 41 })])

    expect(out[0].rowId).toBe(41)
  })

  // Reactions ride the shared per-message JSON column rather than a side table,
  // so they survive the row rewrites that rewind and compaction perform.
  it('hydrates reactions out of display_metadata', () => {
    const out = toChatMessages([
      msg({ role: 'user', content: 'hi', row_id: 41, display_metadata: { reactions: [heart] } })
    ])

    expect(out[0].reactions).toEqual([heart])
  })

  it('ignores malformed reaction entries rather than rendering junk', () => {
    const out = toChatMessages([
      msg({
        role: 'user',
        content: 'hi',
        display_metadata: { reactions: [heart, { emoji: 5 }, null, { author: 'bot', emoji: '🤖' }] }
      })
    ])

    expect(out[0].reactions).toEqual([heart])
  })

  it('leaves both absent when the row carries neither', () => {
    const out = toChatMessages([msg({ role: 'user', content: 'hi' })])

    expect(out[0].rowId).toBeUndefined()
    expect(out[0].reactions).toBeUndefined()
  })

  // Several stored rows fold into one assistant bubble. The bubble's durable
  // identity has to be the FIRST row's — that is the row a reaction on it was
  // written against — or a tapback would address the wrong message.
  it('keeps the first row id when later rows fold into the same bubble', () => {
    const out = toChatMessages([
      msg({ role: 'assistant', content: 'working', row_id: 10, tool_calls: [{ function: { name: 'read_file' } }] }),
      msg({ role: 'assistant', content: 'done', row_id: 11 })
    ])

    expect(out).toHaveLength(1)
    expect(out[0].rowId).toBe(10)
  })
})
