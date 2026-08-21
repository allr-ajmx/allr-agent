/**
 * THE in-flight turn model — "is a turn live on this session, and does it
 * survive a reconnect?".
 *
 * `store/event-router.ts` folds events into transcripts; `store/session-reducer`
 * knows a session is `busy`. Neither answers the questions four separate
 * features need: what did we submit, was it acknowledged, has the gateway seen
 * it, is it compacting, and — after the socket drops mid-turn — is the turn we
 * think is live the same turn the gateway is still running?
 *
 * Desktop answers those across `use-message-stream/`, `use-prompt-actions/` and
 * `lib/inflight-turn-journal.ts` (~9,600 lines with no 1:1 target here). This
 * module is the universal-shaped equivalent: one record per session key, folded
 * by the same event stream the transcript reducer sees, plus a PURE
 * reconciliation planner that decides what to do when the gateway's answer and
 * ours disagree.
 *
 * Two deliberate shapes:
 *
 *  1. The decisions are pure functions (`applyTurnEvent`, `planTurnReconciliation`)
 *     with the atom writes layered on top. Reconnect behaviour is the part that
 *     is impossible to exercise by hand, so it has to be the part that is
 *     trivial to unit-test.
 *  2. Consumers attach through `observeTurnLifecycle` rather than being imported
 *     here. Compaction (store/compaction.ts), the crash journal
 *     (lib/inflight-turn-journal.ts) and steering all need the same
 *     transitions, and none of them may become a static dependency of the
 *     gateway hot path.
 */

import { atom } from 'nanostores'

import type { GatewayEvent } from '@/gateway'
import type { ChatMessage } from '@/lib/chat-messages'
import { isLiveTailRow, reconcileLiveTail } from '@/lib/live-tail'
import { appendLiveSessionProjection } from '@/lib/session-history'
import { applyResumedClarify } from '@/store/clarify'
import { $gatewayState, requestGateway } from '@/store/gateway'
import {
  $sessionStates,
  addSessionKeyHooks,
  isPlaceholderKey,
  rekeySession,
  updateSession
} from '@/store/session-state-types'
import type { SessionResumeResponse } from '@/types/hermes'

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

/**
 * Where a turn is in its life.
 *
 * `submitted` is the window between the client sending `prompt.submit` and the
 * gateway's `message.start` — the one phase desktop's `busy` boolean cannot
 * express, and the one a reconnect lands in most often (the submit went out,
 * the acknowledgement did not come back).
 */
export type TurnPhase = 'awaiting-input' | 'settled' | 'streaming' | 'submitted'

/** Who started the turn we are tracking. */
export type TurnOrigin = 'auto-continue' | 'local' | 'remote'

export interface InflightTurn {
  /** Client-minted, stable across a session rekey — the identity a journal
   *  entry and a reconciliation plan agree on. */
  turnId: string
  phase: TurnPhase
  origin: TurnOrigin
  /** The text that started the turn. Empty for a turn we adopted from the
   *  gateway without an inflight snapshot. */
  prompt: string
  /** Mid-turn corrections, in order, NEVER written over `prompt` — the backend
   *  keeps both (`_record_inflight_correction`) precisely so a resuming client
   *  can rebuild every user bubble the turn produced. */
  corrections: string[]
  startedAt: number
  /** Last time any frame for this turn arrived. Drives staleness. */
  lastEventAt: number
  /** `message.start` seen: the gateway owns the turn now. */
  acknowledged: boolean
  /** Any assistant/reasoning/tool output seen — a turn that produced nothing is
   *  safe to discard on reconnect; one that produced output is not. */
  producedOutput: boolean
  /** The turn is compacting its context (store/compaction.ts drives this). */
  compacting: boolean
  /** How many auto-continues led here. 0 for a user-initiated turn; the backend
   *  breaker counts the same way (`turn_marker.py`). */
  attempts: number
}

/** A turn that has gone quiet for this long with no acknowledgement is not
 *  coming back — the same 15-minute window the backend uses to decide an
 *  interrupted turn is still worth auto-continuing (`_auto_continue_config`). */
export const STALE_TURN_MS = 15 * 60_000

let turnCounter = 0

const newTurnId = (): string => `turn-${Date.now().toString(36)}-${(++turnCounter).toString(36)}`

/** Session key → its live turn. A session with no entry has no turn in flight. */
export const $inflightTurns = atom<Record<string, InflightTurn>>({})

// NO reactive projection of this atom is exported, and that is deliberate
// (MJXHRM-358). `$activeInflightTurn` and a memoized `sessionInflightTurn(key)`
// lived here through three audits with zero subscribers, because nothing renders
// a turn RECORD: every surface renders the slice's `busy` / `awaitingResponse` /
// `needsInput`, and `applyReconciledBusy` is what keeps those honest after a
// reconnect. Two sources of truth for "is this chat working" is the bug that
// layer exists to prevent, so the record stays an imperative read.
/** Non-reactive read, for the imperative submit/steer/reconcile paths. */
export const getInflightTurn = (key: string): InflightTurn | null => $inflightTurns.get()[key] ?? null

/** Is a turn live on this session? A settled record is not live. */
export const isTurnLive = (key: string): boolean => {
  const turn = getInflightTurn(key)

  return Boolean(turn && turn.phase !== 'settled')
}

// ---------------------------------------------------------------------------
// The extension point
// ---------------------------------------------------------------------------

/** What just happened to a turn. Named for the CAUSE, not the phase, so an
 *  observer can distinguish "the turn ended" from "the turn errored". */
export type TurnTransition =
  | 'acknowledged'
  | 'begin'
  | 'compaction-end'
  | 'compaction-start'
  | 'corrected'
  | 'error'
  | 'output'
  | 'reconciled'
  | 'settle'

export interface TurnLifecycleEvent {
  key: string
  transition: TurnTransition
  turn: InflightTurn | null
  previous: InflightTurn | null
}

const observers = new Set<(event: TurnLifecycleEvent) => void>()

/**
 * Subscribe to turn transitions. Returns a disposer.
 *
 * This is how MJXHRM-78/79/80/51 attach without any of them importing each
 * other: an observer throwing is isolated, because a broken journal write must
 * not take the transcript down with it.
 */
export function observeTurnLifecycle(observer: (event: TurnLifecycleEvent) => void): () => void {
  observers.add(observer)

  return () => {
    observers.delete(observer)
  }
}

function emit(event: TurnLifecycleEvent): void {
  for (const observer of observers) {
    try {
      observer(event)
    } catch {
      /* an observer must never break the turn it is watching */
    }
  }
}

function write(key: string, next: InflightTurn | null, transition: TurnTransition): InflightTurn | null {
  const turns = $inflightTurns.get()
  const previous = turns[key] ?? null

  if (previous === next) {
    return next
  }

  if (next === null) {
    if (key in turns) {
      const { [key]: _dropped, ...rest } = turns
      $inflightTurns.set(rest)
    }
  } else {
    $inflightTurns.set({ ...turns, [key]: next })
  }

  emit({ key, previous, transition, turn: next })

  return next
}

// ---------------------------------------------------------------------------
// The pure fold
// ---------------------------------------------------------------------------

/**
 * Events that mean the gateway produced something for this turn.
 *
 * The whole `moa.*` family counts, not just `moa.reference`. A MoA fan-out
 * emits nothing BUT `moa.progress` until every advisor has returned, against a
 * `moa_reference` timeout that defaults to 900s — so with only `moa.reference`
 * here, a turn that has been visibly reporting progress for a quarter of an
 * hour still read as "produced nothing", and `lastEventAt` never advanced past
 * `message.start` for the whole fan-out. `store/compaction.ts` already treats
 * the family as proof the turn is producing again; these two folds are driven
 * by the same router call and must not disagree about it.
 */
const OUTPUT_EVENT_TYPES = new Set([
  'message.delta',
  'message.interim',
  'moa.aggregating',
  'moa.phase',
  'moa.progress',
  'moa.reference',
  'reasoning.available',
  'reasoning.batch',
  'reasoning.delta',
  'thinking.delta',
  'tool.complete',
  'tool.generating',
  'tool.progress',
  'tool.start'
])

/** Events that park the turn on the user. */
const BLOCKING_EVENT_TYPES = new Set(['approval.request', 'clarify.request', 'secret.request', 'sudo.request'])

/** Events that resolve a block (the agent is running again). */
const UNBLOCKING_EVENT_TYPES = new Set(['message.delta', 'reasoning.delta', 'thinking.delta', 'tool.start'])

/**
 * How often a stream of otherwise-identical events is allowed to republish the
 * record just to advance `lastEventAt`.
 *
 * Every token is an OUTPUT event, and a fresh object per token would republish
 * `$inflightTurns` at delta rate — the exact re-render storm `lib/stream-batch`
 * exists to prevent. `lastEventAt` only feeds a minutes-long staleness window,
 * so a one-second resolution costs nothing.
 */
const TURN_HEARTBEAT_MS = 1_000

const heartbeatDue = (turn: InflightTurn, now: number): boolean => now - turn.lastEventAt >= TURN_HEARTBEAT_MS

/**
 * Fold ONE gateway event into ONE session's turn record. Pure.
 *
 * `null` in means "no turn tracked"; `null` out means "drop the record". A
 * `message.start` with no local record ADOPTS the turn — the gateway can start
 * a turn we never submitted (auto-continue after a crash, another surface
 * driving the same session, a queued prompt draining).
 */
export function applyTurnEvent(turn: InflightTurn | null, event: GatewayEvent, now = Date.now()): InflightTurn | null {
  const type = event.type

  if (type === 'message.start') {
    if (!turn || turn.phase === 'settled') {
      return {
        turnId: newTurnId(),
        phase: 'streaming',
        origin: 'remote',
        prompt: '',
        corrections: [],
        startedAt: now,
        lastEventAt: now,
        acknowledged: true,
        producedOutput: false,
        compacting: false,
        attempts: 0
      }
    }

    return { ...turn, phase: 'streaming', acknowledged: true, lastEventAt: now }
  }

  if (!turn || turn.phase === 'settled') {
    return turn
  }

  if (type === 'message.complete') {
    return { ...turn, phase: 'settled', compacting: false, lastEventAt: now }
  }

  if (type === 'error') {
    return { ...turn, phase: 'settled', compacting: false, lastEventAt: now }
  }

  if (BLOCKING_EVENT_TYPES.has(type)) {
    return { ...turn, phase: 'awaiting-input', lastEventAt: now }
  }

  if (OUTPUT_EVENT_TYPES.has(type)) {
    // A delta arriving while parked means the block resolved without us seeing
    // the response go out (another surface answered it, or the tool timed out).
    const phase = turn.phase === 'awaiting-input' && !UNBLOCKING_EVENT_TYPES.has(type) ? turn.phase : 'streaming'

    if (phase === turn.phase && turn.producedOutput && !heartbeatDue(turn, now)) {
      return turn
    }

    return { ...turn, phase, producedOutput: true, lastEventAt: now }
  }

  if (type === 'status.update') {
    return heartbeatDue(turn, now) ? { ...turn, lastEventAt: now } : turn
  }

  return turn
}

// ---------------------------------------------------------------------------
// The imperative API (what submit / steer / the router call)
// ---------------------------------------------------------------------------

/** Open a turn locally, at `prompt.submit` time — before the gateway has
 *  acknowledged anything. Replaces any settled record on the same session. */
export function beginTurn(
  key: string,
  options: { attempts?: number; origin?: TurnOrigin; prompt: string } = { prompt: '' }
): InflightTurn {
  const now = Date.now()

  const turn: InflightTurn = {
    turnId: newTurnId(),
    phase: 'submitted',
    origin: options.origin ?? 'local',
    prompt: options.prompt,
    corrections: [],
    startedAt: now,
    lastEventAt: now,
    acknowledged: false,
    producedOutput: false,
    compacting: false,
    attempts: options.attempts ?? 0
  }

  write(key, turn, 'begin')

  return turn
}

/** Record a correction the gateway ACCEPTED (`session.redirect` /
 *  `session.steer` returned redirected/queued). Appended, never written over
 *  the prompt — same rule the backend follows. */
export function recordTurnCorrection(key: string, text: string): void {
  const turn = getInflightTurn(key)
  const correction = text.trim()

  if (!turn || turn.phase === 'settled' || !correction) {
    return
  }

  write(key, { ...turn, corrections: [...turn.corrections, correction], lastEventAt: Date.now() }, 'corrected')
}

/** Flag/unflag context compaction on the live turn. Called by
 *  store/compaction.ts, which owns the user-facing state. */
export function setTurnCompacting(key: string, compacting: boolean): void {
  const turn = getInflightTurn(key)

  if (!turn || turn.compacting === compacting) {
    return
  }

  write(key, { ...turn, compacting, lastEventAt: Date.now() }, compacting ? 'compaction-start' : 'compaction-end')
}

/** Settle a turn without a gateway frame — a local submit that never left, or
 *  reconciliation deciding the turn is gone. */
export function settleTurn(key: string, reason: 'error' | 'settle' = 'settle'): void {
  const turn = getInflightTurn(key)

  if (!turn || turn.phase === 'settled') {
    return
  }

  write(key, { ...turn, phase: 'settled', compacting: false, lastEventAt: Date.now() }, reason)
}

/** Forget a session's turn entirely (slice eviction, chat reset). */
export function dropTurn(key: string): void {
  if (getInflightTurn(key)) {
    write(key, null, 'settle')
  }
}

/** Carry a turn across a session rekey (draft → runtime id, or a resume that
 *  minted a fresh runtime id for the same conversation). */
export function rekeyTurn(fromKey: string, toKey: string): void {
  if (fromKey === toKey) {
    return
  }

  const turn = getInflightTurn(fromKey)

  if (!turn) {
    return
  }

  const { [fromKey]: _moved, ...rest } = $inflightTurns.get()
  $inflightTurns.set({ ...rest, [toKey]: turn })
  emit({ key: toKey, previous: null, transition: 'reconciled', turn })
}

/**
 * THE router seam. `store/event-router.ts` calls this for every event it has
 * already attributed to a session, before folding the transcript — so an
 * observer reading `$inflightTurns` inside a transcript subscriber sees the
 * turn state that matches the frame it is reacting to.
 */
export function routeTurnEvent(key: string, event: GatewayEvent): void {
  const previous = getInflightTurn(key)
  const next = applyTurnEvent(previous, event)

  if (next === previous) {
    return
  }

  const transition: TurnTransition =
    event.type === 'message.start'
      ? 'acknowledged'
      : event.type === 'error'
        ? 'error'
        : event.type === 'message.complete'
          ? 'settle'
          : 'output'

  write(key, next, transition)
}

// The turn follows its slice: a draft rekeys onto its runtime id mid-submit, and
// a cold resume mints a fresh runtime id for the same conversation. A record
// stranded under the old key is a turn nothing can ever settle.
addSessionKeyHooks({
  drop: dropTurn,
  rekey: rekeyTurn
})

/** Wipe every turn — profile switch, gateway teardown. */
export function clearAllTurns(): void {
  if (Object.keys($inflightTurns.get()).length > 0) {
    $inflightTurns.set({})
  }
}

// ---------------------------------------------------------------------------
// Reconnect / cold-start reconciliation
// ---------------------------------------------------------------------------

/** The gateway's own answer about a session's turn, distilled from
 *  `session.resume`. Everything here is optional: an older gateway omits the
 *  inflight snapshot entirely. */
export interface RemoteTurnSnapshot {
  running: boolean
  streaming: boolean
  /** The prompt that started the turn still running there. */
  user: string
  /** Corrections the gateway accepted for that turn. */
  corrections: string[]
  /** A retained failed turn (`_fail_inflight_turn`) — the terminal frame was
   *  lost, and this is the only record the client will ever get. */
  error: string
  /** The gateway scheduled a continuation for a crash-interrupted turn. The
   *  client must NOT resubmit: the turn is already running there. */
  autoContinue: null | { attempt: number; interruptedAt: number }
}

/** Read the fields we care about out of a raw `session.resume` response. */
export function remoteTurnSnapshot(resumed: SessionResumeResponse): RemoteTurnSnapshot {
  const inflight = resumed.inflight ?? null
  const auto = resumed.auto_continue

  const corrections = (inflight?.corrections ?? [])
    .filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
    .map(c => c.trim())

  return {
    running: Boolean(resumed.running ?? inflight?.streaming),
    streaming: Boolean(inflight?.streaming),
    user: (inflight?.user ?? '').trim(),
    corrections,
    error: (inflight?.error ?? '').trim(),
    autoContinue: auto
      ? { attempt: Number(auto.attempt ?? 1) || 1, interruptedAt: Number(auto.interrupted_at ?? 0) || 0 }
      : null
  }
}

/** What reconciliation decided to do about one session's turn. */
export type TurnReconciliation =
  /** Both sides agree a turn is live: keep ours, folding in anything the
   *  gateway knows that we do not (corrections accepted while we were offline). */
  | { action: 'keep'; corrections: string[] }
  /** The gateway is running a turn we have no record of — adopt it. */
  | { action: 'adopt'; origin: TurnOrigin; prompt: string; attempts: number }
  /** We think a turn is live; the gateway does not. The terminal frame was lost
   *  in the disconnect window — settle locally rather than spin forever. */
  | { action: 'settle'; reason: 'remote-idle' | 'stale' }
  /** The gateway retained a FAILED turn whose error frame we never saw. */
  | { action: 'fail'; error: string }
  /** Nothing live anywhere. */
  | { action: 'noop' }

/**
 * Decide what to do about one session's turn, given what we believe and what
 * the gateway just told us. Pure — this is the whole reconnect contract.
 *
 * The cases that matter, in the order they are checked:
 *
 *  - A retained error wins over everything: it is the only copy of a failure
 *    whose terminal frame died with the socket.
 *  - An `auto_continue` descriptor means the GATEWAY already scheduled the
 *    re-run. Adopting it (rather than keeping our record, and certainly rather
 *    than resubmitting) is the double-resume guard: two resumes in a row each
 *    return the descriptor for the SAME scheduled continuation, and adopting is
 *    idempotent because the adopted turn carries the attempt number.
 *  - A local turn that never got acknowledged and has gone quiet past
 *    `STALE_TURN_MS` is stale regardless of what the gateway says about
 *    running — a wedged submit, not a live turn.
 */
export function planTurnReconciliation(
  local: InflightTurn | null,
  remote: RemoteTurnSnapshot,
  now = Date.now()
): TurnReconciliation {
  const live = local && local.phase !== 'settled' ? local : null

  if (remote.error) {
    return { action: 'fail', error: remote.error }
  }

  if (remote.autoContinue) {
    // The continuation is running (or about to) on the gateway. Adopt it under
    // the interrupted prompt so the transcript and the journal agree on what is
    // being re-run.
    return {
      action: 'adopt',
      origin: 'auto-continue',
      prompt: live?.prompt ?? remote.user,
      attempts: remote.autoContinue.attempt
    }
  }

  if (live && !live.acknowledged && now - live.lastEventAt > STALE_TURN_MS) {
    return { action: 'settle', reason: 'stale' }
  }

  if (remote.running || remote.streaming) {
    if (live) {
      // Only corrections the gateway has and we do not. A reconnect that
      // returns the same list twice must not double the local record.
      const missing = remote.corrections.filter(correction => !live.corrections.includes(correction))

      return { action: 'keep', corrections: missing }
    }

    return { action: 'adopt', origin: 'remote', prompt: remote.user, attempts: 0 }
  }

  return live ? { action: 'settle', reason: 'remote-idle' } : { action: 'noop' }
}

/** Apply a plan to the store. Returns the plan, so callers can react to it. */
export function applyTurnReconciliation(key: string, plan: TurnReconciliation): TurnReconciliation {
  const now = Date.now()
  const local = getInflightTurn(key)

  switch (plan.action) {
    case 'keep':
      if (local && plan.corrections.length > 0) {
        write(
          key,
          { ...local, corrections: [...local.corrections, ...plan.corrections], lastEventAt: now },
          'reconciled'
        )
      }

      break
    case 'adopt': {
      // Idempotent on a repeated resume: an already-live turn of the same origin
      // and attempt count is the SAME turn, not a second one.
      if (local && local.phase !== 'settled' && local.origin === plan.origin && local.attempts === plan.attempts) {
        break
      }

      write(
        key,
        {
          turnId: newTurnId(),
          phase: 'submitted',
          origin: plan.origin,
          prompt: plan.prompt,
          corrections: local?.corrections ?? [],
          startedAt: now,
          lastEventAt: now,
          acknowledged: false,
          producedOutput: false,
          compacting: false,
          attempts: plan.attempts
        },
        'reconciled'
      )

      break
    }

    case 'fail':
      settleTurn(key, 'error')

      break

    case 'settle':
      settleTurn(key)

      break

    case 'noop':
      break
  }

  return plan
}

/**
 * Does a `session.resume` payload describe a turn that is still going?
 *
 * `inflight.streaming` is the direct answer, but it is not the only one: a
 * gateway that just scheduled a crash continuation reports the session as idle
 * until its (deferred, up-to-120s) agent build finishes and the kickoff thread
 * flips `running`. The turn is nonetheless already owned over there, so a client
 * that trusts `running` alone paints an idle chat, seals whatever it recovered
 * as a finished reply, and is surprised by `message.start` a minute later.
 */
export const resumedTurnIsLive = (resumed: SessionResumeResponse): boolean =>
  Boolean(resumed.inflight?.streaming ?? resumed.running) || Boolean(resumed.auto_continue)

/**
 * Adopt whatever turn the gateway says is running on a session we just opened.
 *
 * Call AFTER the `hydrating: → runtime id` rekey: the record has to land under
 * the key the router will address, and `rekeyTurn` (which runs during the
 * rekey) would otherwise move nothing over one written early.
 *
 * A cold open starts with no local record, so the plan here is only ever
 * `adopt`, `fail` or `noop` — but making it at all is what puts the session into
 * `$inflightTurns`, and therefore into the set `reconcileInflightTurns` walks on
 * every WS re-open. Without it a session resumed mid-turn is invisible to
 * reconnect reconciliation for the rest of its life, which is the whole point of
 * the layer.
 *
 * A turn parked on a blocking prompt is adopted here too, and it is the ONLY
 * place it can be: `clarify.request` was emitted once, long before this client
 * opened the session, and a parked turn is in no transcript. Every cold-open
 * path (the main pane, a tile, a satellite window) reaches the gateway through
 * this function, so hanging the replay here is what stops the fourth one being
 * written without it (MJXHRM-362).
 */
export function adoptResumedTurn(key: string, resumed: SessionResumeResponse): TurnReconciliation {
  applyResumedClarify(key, resumed)

  return applyTurnReconciliation(key, planTurnReconciliation(getInflightTurn(key), remoteTurnSnapshot(resumed)))
}

// ---------------------------------------------------------------------------
// The reconnect driver
// ---------------------------------------------------------------------------

/** Sessions currently being reconciled — the double-resume guard at the RPC
 *  level (two `open` transitions in quick succession must issue ONE resume per
 *  session, not two). */
const reconciling = new Set<string>()

const sameMessages = (left: ChatMessage[], right: ChatMessage[]): boolean =>
  left.length === right.length && left.every((message, index) => message === right[index])

/**
 * Fold the gateway's inflight snapshot into the session's LIVE tail.
 *
 * THIS is the path `lib/live-tail.ts` was written for and never had (MJXHRM-358).
 * Its only other caller is the cold-open rekey in `store/turn-hydration.ts`,
 * where by construction nothing has streamed yet — the slice was created for the
 * open — so the reconciliation there is inert. A reconnect is the opposite case:
 * the slice holds a turn's reasoning and tool rows that only exist locally, and
 * the gateway is holding the authoritative record of everything that turn said
 * while the socket was down.
 *
 * `omit_messages` is kept: a resume STILL returns `inflight` and `queued` with it
 * (`_live_session_payload`), and those are the only fields that describe the
 * running turn. Re-fetching the committed transcript would buy nothing — the turn
 * is not committed until it ends — and would repaint the whole thread.
 *
 * The fold is computed INSIDE the updater, against the slice as it is at write
 * time. The resume is a slow await and the router keeps streaming deltas into the
 * slice while it is in the air, so a merge built from the pre-await copy would
 * silently drop every token that arrived during the round trip.
 */
function reconcileSessionTail(key: string, resumed: SessionResumeResponse): void {
  updateSession(key, state => {
    // The committed prefix, with the live tail removed: the projection decides
    // for itself what the running turn looks like, and feeding it our own tail
    // would make it suppress the very rows it is there to supply.
    const committed = state.messages.filter(message => !isLiveTailRow(message))
    const authoritative = appendLiveSessionProjection(committed, resumed)

    // The gateway had nothing to add — no inflight, no queue, no retained error.
    if (authoritative === committed) {
      return state
    }

    const messages = reconcileLiveTail(authoritative, state.messages)

    return sameMessages(messages, state.messages) ? state : { ...state, messages }
  })
}

/**
 * Carry the plan into the SLICE the user is looking at.
 *
 * `applyTurnReconciliation` writes the turn RECORD and nothing else, which is
 * correct for the cold-open caller (`adoptResumedTurn`) — the rekey beside it
 * already published `busy` from the resume payload. On a reconnect there is no
 * such write, and nothing else reliably supplies one: `invalidateRuntimeBindings`
 * clears every slice's `busy` on the same `open` edge, and the only thing that
 * puts it back is `session.active_list`, which an older gateway does not serve
 * and which trails a poll behind. So a reconciled turn could be live in
 * `$inflightTurns` while its tile rendered an idle composer with no stop button,
 * or — the worse direction — settled in the record while the tile span forever
 * on a spinner nothing would ever clear.
 *
 * Only the fields the turn owns are touched. `needsInput` is a blocking prompt's
 * to clear, and `messages` belong to `reconcileSessionTail`.
 */
function applyReconciledBusy(key: string, plan: TurnReconciliation): void {
  if (plan.action === 'noop') {
    return
  }

  const live = plan.action === 'keep' || plan.action === 'adopt'

  updateSession(key, state => {
    if (state.busy === live) {
      return state
    }

    return live
      ? { ...state, busy: true, turnStartedAt: state.turnStartedAt ?? Date.now() }
      : { ...state, busy: false, awaitingResponse: false, streamId: null, turnStartedAt: null }
  })
}

/**
 * Ask the gateway what it thinks of one session's turn, and reconcile.
 *
 * `omit_messages` because this is a turn-state question, not a transcript one —
 * the transcript already lives in the slice, and re-fetching it here would race
 * whatever the router is streaming into it. The inflight SNAPSHOT still comes
 * back, and `reconcileSessionTail` folds it into that slice.
 */
export async function reconcileSessionTurn(key: string): Promise<TurnReconciliation | null> {
  const state = $sessionStates.get()[key]
  const storedId = state?.storedSessionId ?? state?.runtimeSessionId

  if (!storedId || reconciling.has(key)) {
    return null
  }

  reconciling.add(key)

  try {
    // Scope the resume to the session's OWNING profile, as every other resume
    // does — without it a multi-profile gateway looks the id up in its launch
    // profile's state.db. `store/session` imports this module, hence lazy; and
    // an enrichment that cannot be resolved must not abort the reconciliation,
    // so a failure falls back to "let the gateway decide" as before.
    const profile = await import('@/store/session')
      .then(m =>
        m.knownSessionProfile(storedId) ?? (m.sessionProfileIsAmbiguous() ? m.resolveSessionProfile(storedId) : undefined)
      )
      .catch(() => undefined)

    const resumed = await requestGateway<SessionResumeResponse>('session.resume', {
      session_id: storedId,
      omit_messages: true,
      source: 'universal',
      ...(profile ? { profile } : {})
    })

    // A gateway that RESTARTED (a supervised local backend, a redeployed remote)
    // mints a fresh runtime id for this conversation, and this resume is what
    // claimed it. The router addresses slices by the id the gateway stamps on
    // each frame, so a slice left under the dead id receives nothing — the
    // probe would re-arm a turn (auto-continue included) whose entire stream we
    // then drop on the floor. A WARM reconnect re-claims the SAME live record
    // (`_claim_or_reuse_live`), so this is a no-op there.
    const runtimeId = (resumed.session_id ?? '').trim()
    const live = runtimeId && runtimeId !== key && !isPlaceholderKey(key) ? runtimeId : key

    if (live !== key) {
      // Moves the slice, its stored-id aliases and — through `rekeyTurn` — the
      // in-flight record, so the plan below is applied to the surviving key.
      rekeySession(key, live, { runtimeSessionId: live })
    }

    const plan = applyTurnReconciliation(
      live,
      planTurnReconciliation(getInflightTurn(live), remoteTurnSnapshot(resumed))
    )

    applyReconciledBusy(live, plan)

    // After the plan, not before: settling a turn the gateway has forgotten must
    // not then re-project that turn's tail back onto the transcript.
    if (plan.action !== 'settle') {
      reconcileSessionTail(live, resumed)
    }

    // After the tail, so the row lands on the reconciled tail rather than one
    // `reconcileSessionTail` is about to rebuild. Unconditional: a prompt still
    // in the gateway's `_pending` means the agent IS parked, whatever the plan
    // concluded about the turn — and the replay is an upsert, so a card that
    // survived the disconnect stays one card.
    applyResumedClarify(live, resumed)

    return plan
  } catch {
    // A failed probe is not evidence the turn died — leave the record alone and
    // let the next reconnect (or a terminal frame) settle it.
    return null
  } finally {
    reconciling.delete(key)
  }
}

/** Reconcile every session that believes it has a turn in flight. */
export async function reconcileInflightTurns(): Promise<void> {
  const keys = Object.entries($inflightTurns.get())
    .filter(([, turn]) => turn.phase !== 'settled')
    .map(([key]) => key)

  await Promise.all(keys.map(key => reconcileSessionTurn(key)))
}

let reconcilerStarted = false

/**
 * Wire reconciliation to the socket.
 *
 * Only a RE-open reconciles: the first `open` of a process is a cold start,
 * where nothing has been submitted yet and `store/session.ts`'s own resume is
 * the authority. Every open after a drop is a window we might have missed a
 * terminal frame in.
 */
export function startTurnReconciler(): () => void {
  if (reconcilerStarted) {
    return () => {}
  }

  reconcilerStarted = true
  let sawDrop = false

  const unsubscribe = $gatewayState.subscribe(state => {
    if (state === 'closed' || state === 'error') {
      sawDrop = true

      return
    }

    if (state === 'open' && sawDrop) {
      sawDrop = false
      void reconcileInflightTurns()
    }
  })

  return () => {
    unsubscribe()
    reconcilerStarted = false
  }
}
