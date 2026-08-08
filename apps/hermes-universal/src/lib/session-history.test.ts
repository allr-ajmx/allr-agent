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

  it('projects an accepted queued prompt after the running turn', () => {
    const out = appendLiveSessionProjection([], {
      inflight: { streaming: true, user: 'first' },
      queued: { user: 'second' },
      session_id: 's1'
    })

    expect(out.map(m => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(out[2]).toMatchObject({ parts: [{ type: 'text', text: 'second' }] })
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
