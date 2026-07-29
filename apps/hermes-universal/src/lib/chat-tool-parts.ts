import type { ChatPart, ToolCallPart } from '@/lib/chat-messages'
import { normalize } from '@/lib/text'
import { parseTodos } from '@/lib/todos'

// The live tool-call reducer, ported from apps/desktop/src/lib/chat-messages.ts
// (toolId … upsertToolPart). Universal previously carried a lean matcher that
// keyed on "same tool name and no result yet", which collapsed parallel
// same-name calls into one row, never adopted the real `tool_id`, and dropped
// every payload field the tool renderer actually reads.
//
// What the gateway sends (tui_gateway/server.py `_on_tool_start` /
// `_on_tool_complete`) is the reason this is more than an id lookup:
//   tool.start      {tool_id, name, context, args_text?}   — NO args
//   tool.complete   {tool_id, name, args, result, duration_s?, summary?,
//                    todos?, inline_diff?}                 — NO is_error
//   tool.generating {name}                                 — NO id
// so a row is routinely created by an id-less event and only later meets its
// stable id, and the human-readable argument arrives as `context`, not `args`.

export interface GatewayToolPayload {
  args?: unknown
  arguments?: unknown
  context?: string
  duration_s?: number
  error?: string | boolean
  id?: string
  inline_diff?: string
  input?: unknown
  message?: string
  name?: string
  preview?: string
  result?: unknown
  summary?: string
  todos?: unknown
  tool_call_id?: string
  tool_id?: string
}

function recordFromUnknown(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

export function toolIdFromPayload(payload: GatewayToolPayload | undefined): string {
  return payload?.tool_id || payload?.tool_call_id || payload?.id || ''
}

let liveToolCounter = 0

function nextLiveToolId(name: string): string {
  liveToolCounter += 1

  return `live-tool:${name}:${liveToolCounter}`
}

function firstStringField(record: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = record[key]

    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }

  return ''
}

function collectToolMatchValues(query: string, context: string, preview: string): string[] {
  return [...new Set([query, context, preview].map(value => normalize(value)).filter(Boolean))]
}

function toolPayloadMatchValues(payload: GatewayToolPayload | undefined): string[] {
  const payloadArgs = liveToolArgs(payload)
  const query = firstStringField(payloadArgs, ['search_term', 'query'])
  const context = typeof payload?.context === 'string' ? payload.context.trim() : ''
  const preview = typeof payload?.preview === 'string' ? payload.preview.trim() : ''

  return collectToolMatchValues(query, context, preview)
}

function toolPartMatchValues(part: ChatPart | undefined): string[] {
  if (part?.type !== 'tool-call' || !part.args || typeof part.args !== 'object') {
    return []
  }

  const args = part.args as Record<string, unknown>
  const query = firstStringField(args, ['search_term', 'query'])
  const context = typeof args.context === 'string' ? args.context.trim() : ''
  const preview = typeof args.preview === 'string' ? args.preview.trim() : ''

  return collectToolMatchValues(query, context, preview)
}

function hasToolMatchOverlap(left: string[], right: string[]): boolean {
  if (!left.length || !right.length) {
    return false
  }

  const rightSet = new Set(right)

  return left.some(value => rightSet.has(value))
}

function findToolPartIndex(
  parts: ChatPart[],
  name: string,
  stableId: string,
  payload: GatewayToolPayload | undefined,
  phase: 'complete' | 'running'
): number {
  const matchValues = toolPayloadMatchValues(payload)
  const overlaps = (index: number) => hasToolMatchOverlap(matchValues, toolPartMatchValues(parts[index]))

  if (stableId) {
    const stableIndex = parts.findIndex(part => part.type === 'tool-call' && part.toolCallId === stableId)

    if (stableIndex >= 0) {
      return stableIndex
    }

    // Some live streams start without an id, then complete with one. Fall
    // through to pending same-name/context matching so the completion updates
    // the synthetic live row instead of appending a duplicate completed row.
    if (phase === 'running' && !matchValues.length) {
      return -1
    }
  }

  const pendingIndices = parts
    .map((part, index) => ({ index, part }))
    .filter(({ part }) => part.type === 'tool-call' && part.toolName === name && part.result === undefined)
    .map(({ index }) => index)

  if (pendingIndices.length === 0) {
    return -1
  }

  if (matchValues.length) {
    const contextualIndex = pendingIndices.find(overlaps)

    if (contextualIndex !== undefined) {
      return contextualIndex
    }
  }

  if (pendingIndices.length === 1) {
    const [singlePendingIndex] = pendingIndices

    if (phase === 'running' && matchValues.length && !overlaps(singlePendingIndex)) {
      return stableId ? singlePendingIndex : -1
    }

    return singlePendingIndex
  }

  // Completion events without stable IDs frequently arrive after multiple
  // same-name starts (parallel tool calls). Resolve them oldest-first so we
  // don't collapse an entire burst into a single row.
  if (phase === 'complete') {
    return pendingIndices[0]
  }

  if (stableId) {
    return pendingIndices[0]
  }

  // For progress/running events with no stable id, update the most-recent
  // pending same-name tool instead of creating a phantom extra row.
  return pendingIndices.at(-1) ?? -1
}

function parseMaybeJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }

  if (typeof value !== 'string' || !value.trim()) {
    return {}
  }

  try {
    const parsed = JSON.parse(value) as unknown

    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function firstNonEmptyObject(...values: unknown[]): Record<string, unknown> {
  for (const value of values) {
    const parsed = parseMaybeJsonObject(value)

    if (Object.keys(parsed).length > 0) {
      return parsed
    }
  }

  return {}
}

function liveToolArgs(payload: GatewayToolPayload | undefined): Record<string, unknown> {
  const direct = firstNonEmptyObject(payload?.args, payload?.arguments)
  const input = firstNonEmptyObject(payload?.input)
  const fn = recordFromUnknown(input.function)

  const nested = firstNonEmptyObject(
    input.args,
    input.arguments,
    input.parameters,
    input.input,
    fn?.arguments,
    fn?.args,
    fn?.parameters
  )

  return {
    ...input,
    ...nested,
    ...direct
  }
}

// Carry todo state across sparse progress payloads: if this todo event lacks
// a `todos` field, fall back to whatever we previously stored on the part.
function carryTodos(payload: GatewayToolPayload | undefined, ...prev: unknown[]): { todos: unknown } | undefined {
  if (payload && Object.hasOwn(payload, 'todos')) {
    const next = parseTodos(payload.todos)

    return next === null ? undefined : { todos: next }
  }

  if (payload?.name !== 'todo') {
    return undefined
  }

  for (const p of prev) {
    const carried = parseTodos(recordFromUnknown(p)?.todos)

    if (carried !== null) {
      return { todos: carried }
    }
  }

  return undefined
}

function toolArgs(payload: GatewayToolPayload | undefined, prevArgs?: unknown): Record<string, unknown> {
  const prev = parseMaybeJsonObject(prevArgs)
  const eventArgs = liveToolArgs(payload)

  return {
    ...prev,
    ...eventArgs,
    ...(payload?.context ? { context: payload.context } : {}),
    ...(payload?.preview ? { preview: payload.preview } : {}),
    ...carryTodos(payload, prevArgs)
  }
}

// Always an OBJECT, never undefined: `result === undefined` is what marks a row
// as still running, so a completion that carries no result (sub-agent mirrors,
// silent tools) must still settle the row.
function toolResult(
  payload: GatewayToolPayload | undefined,
  prevResult?: unknown,
  prevArgs?: unknown
): Record<string, unknown> {
  const parsedResult = parseMaybeJsonObject(payload?.result)

  // Divergence from desktop, deliberately: `parseMaybeJsonObject` flattens a
  // NON-JSON string result to `{}`, which would throw away the whole output of
  // every tool that answers in plain text. Keep it under `output` — a
  // WRAPPER_KEY that lib/tool-result-summary unwraps and that the terminal /
  // execute_code detail path reads directly.
  const plainText =
    typeof payload?.result === 'string' && payload.result.trim() && !Object.keys(parsedResult).length
      ? { output: payload.result }
      : {}

  return {
    ...parsedResult,
    ...plainText,
    ...(payload?.inline_diff ? { inline_diff: payload.inline_diff } : {}),
    ...(payload?.summary ? { summary: payload.summary } : {}),
    ...(payload?.message ? { message: payload.message } : {}),
    ...(payload?.preview ? { preview: payload.preview } : {}),
    ...(payload?.duration_s !== undefined ? { duration_s: payload.duration_s } : {}),
    ...carryTodos(payload, prevResult, prevArgs),
    ...(payload?.error ? { error: payload.error } : {})
  }
}

export function upsertToolPart(
  parts: ChatPart[],
  payload: GatewayToolPayload | undefined,
  phase: 'complete' | 'running'
): ChatPart[] {
  const stableId = toolIdFromPayload(payload)
  const name = payload?.name || 'tool'
  const next = [...parts]

  const index = findToolPartIndex(next, name, stableId, payload, phase)

  const prev = index >= 0 ? (next[index] as ToolCallPart) : null
  const prevArgs = prev?.args
  const prevResult = prev?.result
  const args = toolArgs(payload, prevArgs)

  // Adopt the real tool_id the first time an event carries one — otherwise a row
  // opened by an id-less `tool.generating` keeps a synthetic id forever and every
  // later id-bearing event misses it.
  const id = stableId || prev?.toolCallId || nextLiveToolId(name)

  const base: ToolCallPart = {
    args,
    toolCallId: id,
    // Keep the name the start supplied when a completion omits it — the live
    // gateway always sends one, but other emitters (and replays) don't, and
    // relabelling a settled row "tool" is worse than reusing what we know.
    toolName: payload?.name || prev?.toolName || name,
    type: 'tool-call',
    ...(phase === 'complete' && { isError: Boolean(payload?.error), result: toolResult(payload, prevResult, prevArgs) })
  }

  if (index === -1) {
    return [...next, base]
  }

  next[index] = { ...(next[index] as ToolCallPart), ...base }

  return next
}
