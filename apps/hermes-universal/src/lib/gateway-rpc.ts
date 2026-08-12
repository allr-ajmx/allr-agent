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

import { gatewayRpcErrorCode, JSON_RPC_METHOD_NOT_FOUND } from '@/gateway/rpc-error'
import { requestGateway } from '@/store/gateway'
import type { MessageReaction } from '@/types/hermes'

/**
 * True when a JSON-RPC call failed because the backend predates the method.
 *
 * Every method in this file is newer than some gateway a user may still be
 * pointed at, so a caller that degrades gracefully tests the rejection with
 * this rather than reading the message itself.
 *
 * The gateway answers an unimplemented method with the JSON-RPC code -32601
 * (`tui_gateway/server.py handle_request()`), and the transport now keeps that
 * code (gateway/rpc-error.ts). When it is present it is the ANSWER, in both
 * directions: a -32601 whose message we would not have recognised still counts,
 * and a handler that genuinely failed does not stop counting merely because its
 * message quotes a nested -32601 from something it called (an MCP server behind
 * a tool does exactly that) — which used to latch a surface into "this backend
 * is old" permanently.
 *
 * The prose match stays as the fallback for rejections that never came off the
 * wire as a JSON-RPC frame: a locally constructed Error, a rejection re-thrown
 * by a wrapper, a gateway whose error frame carries no `code`, and desktop's
 * copy of this helper, which still only has the message to go on.
 */
export function isMissingRpcMethod(error: unknown): boolean {
  const code = gatewayRpcErrorCode(error)

  if (code !== null) {
    return code === JSON_RPC_METHOD_NOT_FOUND
  }

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

/**
 * Why a steer was refused. Present ONLY on `rejected`, and they do not mean the
 * same thing to a user: `not_accepting` is a race they lost by a hair,
 * `unknown_subagent` means the work is already over, `not_owner` /
 * `no_session_authority` mean this window addressed the wrong session and the
 * steer would never work no matter how fast they were.
 *
 * `steer_failed` (the child's own `steer()` refused or raised) and
 * `empty_text`/`no_agent` are backstops the UI folds into the generic refusal.
 * Source: `tools/delegate_tool.py` `steer_subagent_reason` + the
 * `subagent.steer` handler in `tui_gateway/methods_session.py`.
 */
export type SubagentSteerReason =
  | 'empty_text'
  | 'no_agent'
  | 'no_session_authority'
  | 'not_accepting'
  | 'not_owner'
  | 'steer_failed'
  | 'unknown_subagent'
  | (string & {})

export interface SubagentSteerResult {
  /** Set only when `status` is `rejected`. Older gateways omit it entirely, so
   *  a caller must still have a generic refusal message. */
  reason?: SubagentSteerReason
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
 * boundary left to drain into. That race now rides on the `subagent.complete`
 * event as `missed_steer` (store/subagents.ts folds it onto the row). It used
 * to reach no client at all — the miss was appended to the delegate tool result
 * the parent MODEL reads, while the event carried the pre-note summary.
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

// --- wake.start / wake.stop / wake.status / wake.pause / wake.resume -------

/**
 * WHERE the microphone lives, as decided by the backend, not by us.
 *
 * `"local"` — the gateway host opened its own PortAudio device and this client
 * does nothing further; detection just arrives as a `wake.detected` event.
 * `"client"` — the host has no usable input (a headless box, a container), so
 * openWakeWord still runs there but the audio has to come from here, one
 * `wake.feed` call at a time. Reading this field is not optional: streaming
 * frames at a `"local"` detector is wasted bandwidth, and NOT streaming at a
 * `"client"` one is a detector that will never fire.
 */
export type WakeCapture = 'client' | 'local'

/** The surface identity we claim; the backend scopes mic ownership by it. */
const WAKE_SURFACE = 'gui'

export interface WakeStartResult {
  started: boolean
  /** `unavailable` | `disabled` | `disabled_for_surface` | `owned`, else absent. */
  reason?: null | string
  hint?: null | string
  phrase?: string
  provider?: string
  owner_surface?: null | string
  enabled_persisted?: boolean
  capture?: WakeCapture
  sample_rate?: number
  /** Detector frame size in samples (1280 = 80 ms at 16 kHz). */
  frame_length?: number
}

export interface WakeStatusResult {
  listening: boolean
  owned_by_caller: boolean
  owner_surface?: null | string
  phrase?: string
  provider?: string
  available: boolean
  hint?: null | string
  enabled: boolean
  audio_silent?: boolean
  capture?: WakeCapture
  local_input_available?: boolean
  sample_rate?: number
  frame_length?: number
}

export interface WakeStopResult {
  stopped: boolean
  reason?: null | string
  disabled_persisted?: boolean
}

export interface WakePauseResult {
  paused: boolean
  reason?: null | string
}

export interface WakeResumeResult {
  resumed: boolean
  reason?: null | string
}

/** First use lazily installs the onnxruntime detection engine, which is a big
 *  download — nowhere near the client's default timeout. */
const WAKE_START_TIMEOUT_MS = 180_000

/**
 * Arm the wake detector for this client.
 *
 * `persist: true` is the deliberate-click path and writes `wake_word.enabled` to
 * the config — upstream's "the toggle IS the config". A passive re-arm (app
 * start, after a voice conversation) must NOT persist, or a mic could become
 * permanently enabled without anyone asking for it.
 */
export function startWakeWord(options: { persist?: boolean } = {}): Promise<WakeStartResult> {
  return requestGateway<WakeStartResult>(
    'wake.start',
    {
      surface: WAKE_SURFACE,
      // We can supply a microphone, so a backend with none should say so rather
      // than refuse; it answers `capture: "client"` and we stream.
      client_capture: true,
      ...(options.persist ? { persist: true } : {})
    },
    WAKE_START_TIMEOUT_MS
  )
}

/** Disarm. `persist: true` (the toggle) also writes `wake_word.enabled: false`. */
export function stopWakeWord(options: { persist?: boolean } = {}): Promise<WakeStopResult> {
  return requestGateway<WakeStopResult>('wake.stop', options.persist ? { persist: true } : {})
}

export function wakeWordStatus(): Promise<WakeStatusResult> {
  return requestGateway<WakeStatusResult>('wake.status', { surface: WAKE_SURFACE, client_capture: true })
}

/** Release the mic for a voice conversation, without touching the config. */
export function pauseWakeWord(): Promise<WakePauseResult> {
  return requestGateway<WakePauseResult>('wake.pause', {})
}

export function resumeWakeWord(): Promise<WakeResumeResult> {
  return requestGateway<WakeResumeResult>('wake.resume', {})
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
