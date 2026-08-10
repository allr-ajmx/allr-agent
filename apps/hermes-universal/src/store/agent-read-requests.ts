/**
 * The agent's read-back requests — `preview.read.request` and
 * `window.read.request`.
 *
 * This is the one event family where the gateway is BLOCKED on the client:
 * `_block()` parks the tool for 45s (read_preview) / 30s (read_window_below)
 * and only wakes on a matching `*.read.respond`. Ignoring the frame therefore
 * doesn't merely lose a feature, it stalls the agent for the whole timeout —
 * so this module ALWAYS answers, with an empty string when nothing can, which
 * both tools read as "nothing on screen".
 *
 * Universal has neither a browser preview (store/preview.ts is files-only) nor
 * native window enumeration, so both readers are unregistered today and every
 * request gets that empty answer. Registering one is the whole seam: the
 * feature that gains the capability calls `registerPreviewReader` /
 * `registerWindowBelowReader` and nothing here changes.
 *
 * Self-registers on the gateway stream rather than riding the event router:
 * these frames are about the APP, not about one conversation, and the router
 * fails closed on a session it doesn't know (store/event-router.ts).
 */

import type { GatewayEvent } from '@/gateway'
import { type AgentReadRespondResult, respondPreviewRead, respondWindowRead } from '@/lib/gateway-rpc'
import { addGatewayEventListener } from '@/store/gateway'

/** Windowing the read_preview tool asks for. Both are optional — the tool omits
 *  them entirely when it wants the whole page. */
export interface PreviewReadOptions {
  count?: number
  start?: number
}

/** Returns whatever the preview surface knows; it is JSON-stringified onto the
 *  wire, and `null` means "nothing open". */
export type PreviewReader = (options: PreviewReadOptions) => Promise<unknown> | unknown

/** Returns a description of the OS window under the app, or `null` when the
 *  platform can't enumerate windows. */
export type WindowBelowReader = () => Promise<unknown> | unknown

let previewReader: null | PreviewReader = null
let windowBelowReader: null | WindowBelowReader = null

/** Register THE preview reader; returns an idempotent unregister. */
export function registerPreviewReader(reader: PreviewReader): () => void {
  previewReader = reader

  return () => {
    if (previewReader === reader) {
      previewReader = null
    }
  }
}

/** Register THE window-below reader; returns an idempotent unregister. */
export function registerWindowBelowReader(reader: WindowBelowReader): () => void {
  windowBelowReader = reader

  return () => {
    if (windowBelowReader === reader) {
      windowBelowReader = null
    }
  }
}

// Requests still worth answering. An `*.read.expire` frame drops its id so a
// reader that resolves after the tool already gave up doesn't send a pointless
// respond. Bounded by the number of in-flight reads — one per live tool call.
const pending = new Set<string>()

const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

async function answer(
  requestId: string,
  read: () => Promise<unknown> | unknown,
  respond: (requestId: string, text: string) => Promise<AgentReadRespondResult>
): Promise<void> {
  pending.add(requestId)

  let text = ''

  try {
    const result = await read()

    text = result == null ? '' : JSON.stringify(result)
  } catch {
    // A reader that throws (a surface still booting, enumeration unsupported on
    // this compositor) answers empty rather than leaving the tool to time out.
  }

  // False when the request expired while the reader was running.
  if (!pending.delete(requestId)) {
    return
  }

  try {
    await respond(requestId, text)
  } catch {
    // The socket went away; the tool's own timeout is the backstop.
  }
}

function routeAgentReadRequest(event: GatewayEvent): void {
  const payload = (event.payload ?? {}) as Record<string, unknown>
  const requestId = typeof payload.request_id === 'string' ? payload.request_id : ''

  switch (event.type) {
    case 'preview.read.request': {
      if (!requestId) {
        return
      }

      const reader = previewReader
      const options: PreviewReadOptions = { count: num(payload.count), start: num(payload.start) }

      void answer(requestId, () => reader?.(options) ?? null, respondPreviewRead)

      break
    }

    case 'window.read.request': {
      if (!requestId) {
        return
      }

      const reader = windowBelowReader

      void answer(requestId, () => reader?.() ?? null, respondWindowRead)

      break
    }

    case 'preview.read.expire':

    case 'window.read.expire':
      pending.delete(requestId)

      break

    default:
      break
  }
}

addGatewayEventListener(routeAgentReadRequest)

/** Test seam — drops registered readers and any in-flight request. */
export function __resetAgentReadRequests(): void {
  previewReader = null
  windowBelowReader = null
  pending.clear()
}
