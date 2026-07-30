import { $sessionId } from '@/store/chat'
import { requestGateway } from '@/store/gateway'

// Lean composer completions (Gc7). Slash (`/…`) and @-mention (`@…`) drawers
// backed by the gateway RPCs. This drops the desktop assistant-ui trigger-adapter
// chip machinery in favour of plain token insertion.
// FIXME(MJX-106): slash.exec for exec-type commands + arg-completion edge cases;
// grouped section headers; skins/session completions. Desktop drives slash.exec
// from `store/goals.ts` through `app/session/hooks/use-prompt-actions`.

export interface CompletionEntry {
  text: string
  display?: unknown
  group?: string
}

export type CompletionKind = 'path' | 'slash'

export interface TriggerQuery {
  kind: CompletionKind
  token: string
  /** cursor index (end of the token). */
  cursor: number
}

export interface CompletionResult {
  items: CompletionEntry[]
  /** 0-based index in the text where the picked entry's text replaces from. */
  replaceFrom: number
}

/** Detect a slash/@ trigger at the cursor, or null. */
export function detectTrigger(text: string, cursor: number): TriggerQuery | null {
  const before = text.slice(0, cursor)

  // Slash: the whole input starts with '/', single line up to the cursor.
  if (/^\/[^\n]*$/.test(before)) {
    return { kind: 'slash', token: before, cursor }
  }

  // @-mention: the last '@…' run touching the cursor.
  const at = before.match(/@[\w:./-]*$/)

  if (at) {
    return { kind: 'path', token: at[0], cursor }
  }

  return null
}

export function displayText(entry: CompletionEntry): string {
  return typeof entry.display === 'string' && entry.display ? entry.display : entry.text
}

export async function fetchCompletions(query: TriggerQuery): Promise<CompletionResult> {
  try {
    if (query.kind === 'slash') {
      const res = await requestGateway<{ items?: CompletionEntry[]; replace_from?: number }>('complete.slash', {
        text: query.token
      })

      // replace_from is 1-based; >1 means arg completion (splice from that arg).
      const replaceFrom = typeof res.replace_from === 'number' && res.replace_from > 1 ? res.replace_from - 1 : 0

      return { items: res.items ?? [], replaceFrom }
    }

    const params: Record<string, unknown> = { word: query.token }
    const sid = $sessionId.get()

    if (sid) {
      params.session_id = sid
    }

    const res = await requestGateway<{ items?: CompletionEntry[] }>('complete.path', params)
    // Replace from the '@' that starts the token.
    const replaceFrom = query.cursor - query.token.length

    return { items: res.items ?? [], replaceFrom }
  } catch {
    return { items: [], replaceFrom: query.cursor }
  }
}

/** Splice an entry's text into `text`, replacing [replaceFrom, cursor). */
export function applyCompletion(
  text: string,
  cursor: number,
  replaceFrom: number,
  entry: CompletionEntry
): { text: string; cursor: number } {
  const next = text.slice(0, replaceFrom) + entry.text + text.slice(cursor)

  return { text: next, cursor: replaceFrom + entry.text.length }
}
