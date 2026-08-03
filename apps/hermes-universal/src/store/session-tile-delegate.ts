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
import { $sessions, archiveSessionLocal, deleteSessionLocal } from '@/store/session'
import { emptySessionState } from '@/store/session-state-types'
import { closeSessionTile, publishSessionState, setSessionTileDelegate, updateSession } from '@/store/session-states'
import type { SessionResumeResponse } from '@/types/hermes'

function userMessage(text: string): ChatMessage {
  return { id: nextId(), role: 'user', parts: [{ type: 'text', text }] }
}

/** Resume a stored session into `$sessionStates[runtimeId]` WITHOUT touching the
 *  primary chat globals — the tile analog of `store/session.ts#openSession`. */
async function resumeSessionToState(storedId: string): Promise<string> {
  const transcript = await Promise.resolve()
    .then(() => getSessionMessages(storedId))
    .catch(() => null)

  const resumed = await requestGateway<SessionResumeResponse>('session.resume', {
    session_id: storedId,
    cols: 96
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

    await requestGateway('prompt.submit', { session_id: runtimeId, text })
  },

  async interruptSession(runtimeId) {
    await requestGateway('session.interrupt', { session_id: runtimeId }).catch(() => {})
  },

  updateSession,

  // App-level slash on a tile's session — submit it as text; the backend
  // interprets branch/handoff/etc. (desktop routes these to the main surface).
  async executeSlash(rawCommand, sessionId) {
    await requestGateway('prompt.submit', { session_id: sessionId, text: rawCommand })
  },

  async archiveSession(storedId) {
    closeSessionTile(storedId)
    await archiveSessionLocal(storedId)
  },

  // Branch-from-session is a best-effort /branch slash for now.
  async branchSession(storedId) {
    await requestGateway('prompt.submit', { session_id: storedId, text: '/branch' }).catch(() => {})
  },

  async deleteSession(storedId) {
    closeSessionTile(storedId)
    await deleteSessionLocal(storedId)
  }
})
