/**
 * The SessionTileDelegate implementation — the wiring layer that owns the
 * gateway + per-session cache, so tile UI stays dependency-light. Self-registers
 * at import (call site: app/contrib/controller.tsx). Universal has no desktop
 * `use-session-tile-delegate` hook / `use-prompt-actions` engine, so this is an
 * adapter over universal's primitives (`requestGateway`, the REST transcript,
 * `$sessionStates`).
 *
 * FIXME(MJX-50/tile-rewind): edit/reload/restore-in-tile (the full rewind
 * adapter) is Phase 7 — this covers resume / submit / steer / interrupt / the
 * session verbs. Primary chat keeps its own path.
 */

import { getSessionMessages } from '@/hermes'
import { appendLiveSessionProjection, toChatMessages } from '@/lib/session-history'
import { type ChatMessage, interruptSession, nextId } from '@/store/chat'
import { requestGateway } from '@/store/gateway'
import { notifyError } from '@/store/notifications'
import {
  $sessions,
  archiveSessionLocal,
  branchStoredSession,
  deleteSessionLocal,
  knownSessionProfile,
  resolveSessionProfile,
  sessionProfileIsAmbiguous
} from '@/store/session'
import { withSessionNotFoundResume } from '@/store/session-recovery'
import {
  $sessionStates,
  dropSessionState,
  ensureSessionSlice,
  hydratingKey,
  isPlaceholderKey,
  rekeySession,
  runtimeKeyForStoredSession
} from '@/store/session-state-types'
import { closeSessionTile, openSessionTile, setSessionTileDelegate, updateSession } from '@/store/session-states'
import {
  applyTurnReconciliation,
  beginTurn,
  getInflightTurn,
  planTurnReconciliation,
  remoteTurnSnapshot,
  settleTurn
} from '@/store/turn-lifecycle'
import type { SessionResumeResponse } from '@/types/hermes'

/** The DURABLE id behind a tile's live runtime id — what a stale-runtime resume
 *  has to name. The slice carries it; without one there is nothing to recover to
 *  and the caller's error stands. */
function storedIdOfSession(runtimeId: string): null | string {
  return $sessionStates.get()[runtimeId]?.storedSessionId ?? null
}

function userMessage(text: string): ChatMessage {
  return { id: nextId(), role: 'user', parts: [{ type: 'text', text }] }
}

/**
 * Bind a stored session to a tile.
 *
 * A session that already has a live slice is adopted as-is — no `session.resume`
 * and no transcript re-fetch. That matters twice over: re-resuming would rebind
 * the session's transport on the gateway and, mid-turn, tear its own stream
 * away (MJX-199); and ⌘T parks the session that was just in the main pane, which
 * is by definition warm.
 *
 * The tile analog of `store/session.ts#openSession`, which short-circuits the
 * same way for the same reasons.
 */
async function resumeSessionToState(storedId: string): Promise<string> {
  const warm = runtimeKeyForStoredSession(storedId)

  // A placeholder key is a hydrate still in flight (this one, or the main pane's
  // — both reserve `hydrating:<storedId>`). It is not an id a tile can be bound
  // to, because the rekey that follows would strand it.
  if (warm && !isPlaceholderKey(warm) && $sessionStates.get()[warm]) {
    return warm
  }

  return hydrateSessionToState(storedId)
}

/**
 * Hydrate a tile's session under the placeholder key and REKEY it onto the
 * runtime id the resume hands back.
 *
 * This used to `publishSessionState(runtimeId, …)` directly, which looks
 * equivalent and is not: the `hydrating: → runtime` rekey is the seam
 * `store/turn-hydration.ts` hangs live-tail reconciliation and crash-journal
 * recovery off (MJXHRM-356). Publishing straight onto the runtime id skipped
 * both, so tiles kept WRITING crash-journal entries that nothing would ever
 * replay, and a session opened in a tile could not recover a turn the app died
 * mid-way through. It is also the same key the main pane uses, so a session
 * opened in both places now converges on one slice instead of two.
 */
async function hydrateSessionToState(storedId: string): Promise<string> {
  // A tile can open a session from ANY profile, not just the live one. Resuming
  // (or reading the transcript) without one lets the gateway fall back to the
  // launch-profile database and fork the conversation into the wrong profile —
  // so resolve the owner first. Synchronous for a loaded row and for a
  // single-profile install; a by-id probe only when the answer can actually
  // differ (see resolveSessionProfile).
  const profile =
    knownSessionProfile(storedId) ?? (sessionProfileIsAmbiguous() ? await resolveSessionProfile(storedId) : undefined)

  const stored = $sessions.get().find(session => session.id === storedId)
  const key = hydratingKey(storedId)

  ensureSessionSlice(key, {
    storedSessionId: storedId,
    busy: true,
    cwd: stored?.cwd ?? '',
    model: stored?.model ?? ''
  })

  try {
    const transcript = await Promise.resolve()
      .then(() => getSessionMessages(storedId, profile))
      .catch(() => null)

    const resumed = await requestGateway<SessionResumeResponse>('session.resume', {
      session_id: storedId,
      cols: 96,
      ...(profile ? { profile } : {})
    })

    const restMessages = transcript?.messages?.length ? toChatMessages(transcript.messages) : null
    const messages = appendLiveSessionProjection(restMessages ?? toChatMessages(resumed.messages ?? []), resumed)
    const runtimeId = resumed.session_id ?? storedId
    const stillRunning = Boolean(resumed.inflight?.streaming ?? resumed.running)

    rekeySession(key, runtimeId, {
      // Without this the slice has no wire-facing id, so `prompt.submit` /
      // `session.interrupt` for this tile would go out with `undefined`.
      runtimeSessionId: runtimeId,
      storedSessionId: storedId,
      messages,
      busy: stillRunning,
      cwd: resumed.info?.cwd ?? stored?.cwd ?? '',
      model: stored?.model ?? '',
      turnStartedAt: stillRunning ? Date.now() : null
    })

    // A session resumed MID-TURN is running a turn this process never opened.
    // Adopting it is what puts the tile into `$inflightTurns`, and therefore into
    // the set `reconcileInflightTurns` walks on every WS re-open — without it a
    // tile's live turn was invisible to reconnect reconciliation.
    applyTurnReconciliation(runtimeId, planTurnReconciliation(getInflightTurn(runtimeId), remoteTurnSnapshot(resumed)))

    return runtimeId
  } catch (err) {
    // Nothing bound. Leave no orphan placeholder behind: it holds the stored-id
    // index entry, which would make the next `resumeTile` short-circuit onto a
    // slice with no runtime id at all.
    dropSessionState(key)

    throw err
  }
}

setSessionTileDelegate({
  resumeTile: storedId => resumeSessionToState(storedId),

  async submitToSession(runtimeId, text) {
    // Optimistic: append the user turn + go busy, then let routeTileEvent stream
    // the reply into this session's slice.
    updateSession(runtimeId, state => ({
      ...state,
      busy: true,
      statusLine: '',
      turnStartedAt: Date.now(),
      interrupted: false,
      messages: [...state.messages, userMessage(text)]
    }))

    // Open the in-flight turn BEFORE the submit leaves, exactly as `sendPrompt`
    // does: the window between the submit going out and the gateway's
    // `message.start` is the one a reconnect lands in, and a turn with no record
    // there is a turn nothing can reconcile or recover (MJXHRM-356).
    beginTurn(runtimeId, { prompt: text })

    // A draft rekeys to its runtime id, so the slice moves; anything else keeps
    // the key it started with.
    let submitKey = runtimeId

    try {
      // A backgrounded tile is exactly the session most likely to have had its
      // runtime dropped from under it — nothing has been sent through it for a
      // while. Rebind on a stale id rather than surfacing "session not found" on
      // the first message back.
      //
      // `onRecovered` REKEYS rather than taking the default so this closure's own
      // `submitKey` follows too — the rollback below has to address the session
      // the prompt actually went to.
      await withSessionNotFoundResume(
        runtimeId,
        storedIdOfSession(runtimeId),
        live => requestGateway('prompt.submit', { session_id: live, text }),
        {
          onRecovered: live => {
            rekeySession(submitKey, live, { runtimeSessionId: live })
            submitKey = live
          }
        }
      )
    } catch (err) {
      // The submit never landed. Settling the turn and clearing busy is what
      // stops the tile spinning forever — the failure shape MJXHRM-308 named as
      // the worst one, because nothing surfaces and nothing retries.
      settleTurn(submitKey, 'error')
      updateSession(submitKey, state => ({
        ...state,
        busy: false,
        turnStartedAt: null,
        statusLine: err instanceof Error ? err.message : String(err)
      }))
      notifyError(err, 'Message failed to send')
    }
  },

  async interruptSession(runtimeId) {
    await interruptSession(runtimeId)
  },

  updateSession,

  // App-level slash on a tile's session — submit it as text; the backend
  // interprets branch/handoff/etc. (desktop routes these to the main surface).
  async executeSlash(rawCommand, sessionId) {
    await withSessionNotFoundResume(sessionId, storedIdOfSession(sessionId), live =>
      requestGateway('prompt.submit', { session_id: live, text: rawCommand })
    )
  },

  async archiveSession(storedId) {
    closeSessionTile(storedId)
    await archiveSessionLocal(storedId)
  },

  /**
   * Branch a session from its TAB — read its stored transcript, fork it on the
   * parent's owning profile, and open the result in a new tab.
   *
   * This used to submit a literal `/branch` prompt to the target session, which
   * asked the AGENT to branch mid-conversation rather than forking the
   * transcript: it needed a live runtime, it appended a turn to the session you
   * were branching FROM, and it silently did nothing on a session that wasn't
   * running. The fork is a client-side copy plus `session.create`, so it works on
   * any listed session, running or not.
   */
  async branchSession(storedId) {
    const branched = await branchStoredSession(storedId)

    if (branched) {
      // Its own tab, stacked beside the parent — the parent stays exactly where
      // it was, which is the point of branching from its tab rather than from
      // inside it.
      openSessionTile(branched, 'center')
    }
  },

  async deleteSession(storedId) {
    closeSessionTile(storedId)
    await deleteSessionLocal(storedId)
  }
})
