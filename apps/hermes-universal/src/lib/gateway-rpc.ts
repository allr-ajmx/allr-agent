/**
 * Typed clients for the gateway RPC methods that arrived with the 2026-08-09
 * backend sync (MJXHRM-230).
 *
 * Written once, here, instead of inside each feature that wants one. The
 * gateway hand-parses `params` — there is no schema on the wire — so a method
 * called with `sessionId` where it wanted `session_id` does not fail loudly,
 * it comes back as a bare `4001 session not found`. Every helper below spells
 * its handler's parameter names exactly and returns that handler's literal
 * result shape, so a caller never has to read the Python to call it.
 *
 * Transport only: no atoms, no UI, no optimistic painting. The feature tickets
 * build the surfaces on top of these.
 */

import { requestGateway } from '@/store/gateway'
import type { MessageReaction } from '@/types/hermes'

/** True when a JSON-RPC call failed because the backend predates the method.
 *  Ported from apps/desktop/src/lib/gateway-rpc.ts. Every method in this file
 *  is newer than some gateway a user may still be pointed at, so a caller that
 *  degrades gracefully tests the rejection with this rather than the message. */
export function isMissingRpcMethod(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)

  return /method not found|-32601|unknown method|no such method/i.test(message)
}

// --- message.react ---------------------------------------------------------

/** Which persisted row to react to. A message that has round-tripped through a
 *  resume carries the durable `messages.id`; a LIVE one has no row id yet, so
 *  it names the role whose newest row it means — which is the message the user
 *  just reacted to. The backend requires exactly one of the two. */
export type MessageReactTarget = { newest_role: 'assistant' | 'user' } | { row_id: number }

export interface MessageReactResult {
  /** The row the backend resolved — learn it so later toggles address it directly. */
  row_id: number
  reactions: MessageReaction[]
}

/**
 * Set or clear one author's emoji reaction on a persisted message.
 *
 * iOS Tapback semantics, enforced in the DB layer: one reaction per author per
 * message, re-sending the same emoji retracts it, `emoji: null` clears
 * unconditionally. The returned list is authoritative — an optimistic caller
 * should let it win rather than merging.
 */
export function reactToMessage(params: {
  /** Defaults to `'user'`; the agent reacts with `'agent'` through its own tool. */
  author?: MessageReaction['author']
  emoji: null | string
  sessionId: string
  target: MessageReactTarget
}): Promise<MessageReactResult> {
  return requestGateway<MessageReactResult>('message.react', {
    session_id: params.sessionId,
    ...params.target,
    emoji: params.emoji,
    author: params.author ?? 'user'
  })
}

// --- preview.read.respond / window.read.respond ----------------------------

/** `expired` means the tool's bounded wait already timed out — the answer was
 *  accepted and discarded, which is not an error (the gateway passes
 *  `allow_expired=True` precisely so a slow renderer doesn't get a 4009). */
export interface AgentReadRespondResult {
  status: 'expired' | 'ok'
}

/** Answer a `preview.read.request` (the agent's read_preview tool). `text` is a
 *  JSON string of the active preview tab's contents; empty means nothing open. */
export function respondPreviewRead(requestId: string, text: string): Promise<AgentReadRespondResult> {
  return requestGateway<AgentReadRespondResult>('preview.read.respond', { request_id: requestId, text })
}

/** Answer a `window.read.request` (the agent's read_window_below tool). `text`
 *  is a JSON string describing the OS window under the app; empty means
 *  unavailable. See store/agent-read-requests.ts, which owns the frame half. */
export function respondWindowRead(requestId: string, text: string): Promise<AgentReadRespondResult> {
  return requestGateway<AgentReadRespondResult>('window.read.respond', { request_id: requestId, text })
}

// --- session.workspace.move ------------------------------------------------

export interface SessionWorkspaceMoveResult {
  branch?: null | string
  /** The path the backend actually resolved (`~` expanded, absolute). */
  cwd?: string
  git_repo_root?: null | string
}

/**
 * Re-home a STORED session's workspace into another folder — the fix for a chat
 * created in the wrong directory, without recreating it.
 *
 * The git branch/root columns are REPLACED rather than enriched: the point of
 * the move is to change which project claims the session, and a stale
 * `git_repo_root` would keep it grouped under the project it left. A live agent
 * bound to the row follows, so its tools re-anchor immediately — but a session
 * mid-turn refuses with `session busy` rather than yanking the workspace out
 * from under a running tool.
 */
export function moveSessionWorkspace(params: {
  cwd: string
  profile?: null | string
  /** The STORED session key, not a live runtime session id. */
  sessionKey: string
}): Promise<SessionWorkspaceMoveResult> {
  return requestGateway<SessionWorkspaceMoveResult>('session.workspace.move', {
    cwd: params.cwd,
    session_key: params.sessionKey,
    ...(params.profile ? { profile: params.profile } : {})
  })
}

// --- subagent.steer --------------------------------------------------------

export interface SubagentSteerResult {
  /** `rejected` = the child could not be resolved, is not ours, or is already
   *  gone. NOT an RPC error — the backend answers 200 either way, so a caller
   *  that only catches rejections silently drops the steer. */
  status: 'queued' | 'rejected'
  subagent_id: string
  text: string
}

/**
 * Queue steering text into a live delegated child without stopping it — the
 * redirection-side mirror of `subagent.interrupt`. The text is appended to the
 * child's last tool result at its next iteration boundary, so the in-flight
 * tool call is never cut.
 *
 * "queued" is not "delivered": a child already past its final tool batch has no
 * boundary left to drain into. That race is NOT pushed as an event — it lands
 * as `missed_steer` on the parent's delegate tool result, and reaches the
 * client only inside the `subagent.complete` summary text.
 */
export function steerSubagent(params: {
  sessionId: string
  subagentId: string
  text: string
}): Promise<SubagentSteerResult> {
  return requestGateway<SubagentSteerResult>('subagent.steer', {
    session_id: params.sessionId,
    subagent_id: params.subagentId,
    text: params.text
  })
}

// --- wake.feed -------------------------------------------------------------

/** The only rate the detector accepts. `wake.start` echoes it back. */
export const WAKE_FEED_SAMPLE_RATE = 16_000
/** Backend's hard cap on one frame: 2s of 16 kHz int16 mono. */
export const WAKE_FEED_MAX_BYTES = 64_000
// One feed is ~80ms of audio pushed several times a second. The client's
// default 120s timeout would let a stalled socket pile up a minute of frames
// behind a call that is already worthless, so fail these fast instead.
const WAKE_FEED_TIMEOUT_MS = 10_000

export interface WakeFeedResult {
  fed: boolean
  /** `null` when fed; otherwise `'not_owner'` (another transport holds the
   *  armed detector) or `'empty'`. */
  reason: null | string
}

/**
 * Push client-captured PCM into the armed wake detector.
 *
 * Used when `wake.start` answered `capture: "client"` — a headless backend has
 * no microphone, so openWakeWord still runs server-side but the audio comes
 * from here. `pcmBase64` must be base64 of int16 mono LITTLE-ENDIAN samples at
 * 16 kHz, at most WAKE_FEED_MAX_BYTES decoded.
 */
export function feedWakeAudio(pcmBase64: string, sampleRate = WAKE_FEED_SAMPLE_RATE): Promise<WakeFeedResult> {
  return requestGateway<WakeFeedResult>('wake.feed', { pcm: pcmBase64, sample_rate: sampleRate }, WAKE_FEED_TIMEOUT_MS)
}
