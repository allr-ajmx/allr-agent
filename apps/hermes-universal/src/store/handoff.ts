import type { HandoffFailResponse, HandoffRequestResponse, HandoffStateResponse } from '@/app/types'
import { translateNow } from '@/i18n'
import { normalize } from '@/lib/text'
import { $sessionId, appendSystemMessage } from '@/store/chat'
import { requestGateway } from '@/store/gateway'
import { notify } from '@/store/notifications'

export interface HandoffResult {
  ok: boolean
  error?: string
}

/** How long to watch for a terminal state before giving up on the transfer. */
const HANDOFF_DEADLINE_MS = 60_000
const HANDOFF_POLL_MS = 800

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** Strip the Electron IPC wrapper desktop errors carry, then the `Error:` prefix. */
function inlineErrorMessage(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : fallback

  return (raw.match(/Error invoking remote method '[^']+': Error: (.+)$/)?.[1] ?? raw).replace(/^Error:\s*/, '').trim()
}

/**
 * Queue a handoff of this session to a messaging platform and watch it to a
 * terminal state. We only write the request through the gateway; the separate
 * `hermes gateway` process performs the actual transfer, so we poll
 * `handoff.state` (mirror of the CLI's block-poll) for the result. Ported from
 * desktop's `handoffSession` (use-prompt-actions/index.ts).
 */
export async function handoffSession(
  platform: string,
  options?: { onProgress?: (state: string) => void; sessionId?: string }
): Promise<HandoffResult> {
  const sid = options?.sessionId || $sessionId.get()

  if (!sid) {
    return { error: translateNow('desktop.sessionUnavailable'), ok: false }
  }

  const target = normalize(platform)

  if (!target) {
    return { error: translateNow('desktop.handoff.failed', ''), ok: false }
  }

  try {
    options?.onProgress?.('pending')
    await requestGateway<HandoffRequestResponse>('handoff.request', {
      platform: target,
      session_id: sid
    })
  } catch (err) {
    return { error: inlineErrorMessage(err, translateNow('desktop.handoff.failed', target)), ok: false }
  }

  const markCompleted = (): HandoffResult => {
    appendSystemMessage(translateNow('desktop.handoff.systemNote', target))
    notify({ kind: 'success', message: translateNow('desktop.handoff.success', target) })

    return { ok: true }
  }

  const deadline = Date.now() + HANDOFF_DEADLINE_MS
  let lastState = 'pending'

  while (Date.now() < deadline) {
    await delay(HANDOFF_POLL_MS)

    let record: HandoffStateResponse

    try {
      record = await requestGateway<HandoffStateResponse>('handoff.state', { session_id: sid })
    } catch {
      continue
    }

    const state = record.state || 'pending'

    if (state !== lastState) {
      options?.onProgress?.(state)
      lastState = state
    }

    if (state === 'completed') {
      return markCompleted()
    }

    if (state === 'failed') {
      return { error: record.error || translateNow('desktop.handoff.failed', target), ok: false }
    }
  }

  // Timed out watching. Tell the gateway to fail the record — unless it just
  // completed in the gap, in which case honour that instead.
  const cleanup = await requestGateway<HandoffFailResponse>('handoff.fail', {
    error: translateNow('desktop.handoff.timedOut'),
    session_id: sid
  }).catch(() => null)

  if (cleanup?.state === 'completed') {
    return markCompleted()
  }

  return { error: translateNow('desktop.handoff.timedOut'), ok: false }
}
