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
import { type ChatMessage, nextId } from '@/store/chat'
import { requestGateway } from '@/store/gateway'
import { withSessionNotFoundResume } from '@/store/session-recovery'
import {
  $sessions,
  archiveSessionLocal,
  branchStoredSession,
  deleteSessionLocal,
  knownSessionProfile,
  resolveSessionProfile,
  sessionProfileIsAmbiguous
} from '@/store/session'
import { $sessionStates, emptySessionState, runtimeKeyForStoredSession } from '@/store/session-state-types'
import {
  closeSessionTile,
  openSessionTile,
  publishSessionState,
  setSessionTileDelegate,
  updateSession
} from '@/store/session-states'
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

  if (warm && $sessionStates.get()[warm]) {
    return warm
  }

  return hydrateSessionToState(storedId)
}

async function hydrateSessionToState(storedId: string): Promise<string> {
  // A tile can open a session from ANY profile, not just the live one. Resuming
  // (or reading the transcript) without one lets the gateway fall back to the
  // launch-profile database and fork the conversation into the wrong profile —
  // so resolve the owner first. Synchronous for a loaded row and for a
  // single-profile install; a by-id probe only when the answer can actually
  // differ (see resolveSessionProfile).
  const profile =
    knownSessionProfile(storedId) ?? (sessionProfileIsAmbiguous() ? await resolveSessionProfile(storedId) : undefined)

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
  const stored = $sessions.get().find(session => session.id === storedId)

  publishSessionState(runtimeId, {
    ...emptySessionState(storedId),
    // Without this the slice has no wire-facing id, so `prompt.submit` /
    // `session.interrupt` for this tile would go out with `undefined`.
    runtimeSessionId: runtimeId,
    messages,
    busy: stillRunning,
    cwd: resumed.info?.cwd ?? stored?.cwd ?? '',
    model: stored?.model ?? '',
    turnStartedAt: stillRunning ? Date.now() : null
  })

  return runtimeId
}

setSessionTileDelegate({
  resumeTile: storedId => resumeSessionToState(storedId),

  async submitToSession(runtimeId, text) {
    // Optimistic: append the user turn + go busy, then let routeTileEvent stream
    // the reply into this session's slice.
    updateSession(runtimeId, state => ({
      ...state,
      busy: true,
      turnStartedAt: Date.now(),
      interrupted: false,
      messages: [...state.messages, userMessage(text)]
    }))

    // A backgrounded tile is exactly the session most likely to have had its
    // runtime dropped from under it — nothing has been sent through it for a
    // while. Rebind on a stale id rather than surfacing "session not found" on
    // the first message back.
    await withSessionNotFoundResume(runtimeId, storedIdOfSession(runtimeId), live =>
      requestGateway('prompt.submit', { session_id: live, text })
    )
  },

  async interruptSession(runtimeId) {
    await requestGateway('session.interrupt', { session_id: runtimeId }).catch(() => {})
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
