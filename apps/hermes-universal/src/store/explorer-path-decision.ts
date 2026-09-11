/**
 * "The user picked a folder in the explorer" — the DECISION half, with no
 * webview, no socket and no atoms (rule 35).
 *
 * The explorer and the agent's working directory used to be two sources of
 * truth that disagreed: `$fileTreeRootOverride` re-rooted the VIEW and won
 * outright over `$effectiveCwd`, so pressing Home moved the tree while the
 * session kept working somewhere else — and, worse, a real cwd change arriving
 * afterwards could not show through the still-active override. The binding was
 * one-way by construction.
 *
 * The fix is that there is only ONE thing to change: the session's cwd. The
 * tree already follows it (`$focusedCwd` → `$effectiveCwd`), so the explorer
 * never sets a root of its own. Everything below is about deciding WHOSE cwd a
 * click means and whether it is safe to move it right now.
 *
 * Kept separate from `store/explorer-path` so this — the part with all the
 * branches — is testable as a plain function.
 */

import { gatewayRpcErrorCode } from '@/gateway/rpc-error'

/** What the caller must know about the focused session to decide. A subset of
 *  `ClientSessionState`, so a test can build one by hand. */
export interface FocusedSessionFacts {
  /** A blocking prompt (clarify/approval) is parked in the backend's `_block`.
   *  The agent thread is still `running` there, so the RPC would refuse. */
  needsInput: boolean
  /** The gateway's LIVE session id — the only value `session.cwd.set` accepts
   *  (rule 17). Null for a draft that has never been created. */
  runtimeSessionId: null | string
  awaitingResponse: boolean
  busy: boolean
}

export type ExplorerPathPlan =
  /** Nothing to do — a blank path. Never root the tree at `''`. */
  | { kind: 'ignore' }
  /** The focused session is mid-turn. Both `session.cwd.set` and
   *  `session.workspace.move` refuse by design (`4009 session busy`), so say so
   *  and change NOTHING — a view that moved while the cwd did not is precisely
   *  the desync this whole change exists to close. */
  | { kind: 'blocked' }
  /** A live, idle session is focused: ask whether to move it or only to change
   *  where new chats start. */
  | { kind: 'prompt'; path: string; runtimeSessionId: string }
  /** No live session to move (the Home bucket, a detached chat, an unsent
   *  draft). Nothing to ask about: set the workspace root and the default
   *  project dir directly. */
  | { kind: 'detached'; path: string }

/**
 * Decide what a folder pick means, given who is focused.
 *
 * Order matters. The blank check comes first because an empty path is not a
 * request at all (the Home button reads an ADDITIVE `home` field that an older
 * gateway omits). The busy check comes second — before the "is there a runtime
 * id?" test — because a session mid-turn must not move the view either, and a
 * session that is busy while still on a placeholder key is exactly the window
 * where a `detached` answer would silently re-root the tree under a running
 * agent.
 */
export function planExplorerPath(rawPath: string, session: FocusedSessionFacts): ExplorerPathPlan {
  const path = rawPath.trim()

  if (!path) {
    return { kind: 'ignore' }
  }

  if (isSessionMidTurn(session)) {
    return { kind: 'blocked' }
  }

  const runtimeSessionId = session.runtimeSessionId?.trim()

  if (!runtimeSessionId) {
    return { kind: 'detached', path }
  }

  return { kind: 'prompt', path, runtimeSessionId }
}

/**
 * "The backend would refuse to re-anchor this session right now."
 *
 * The same three flags `sessionKeyNeedsCloseConfirm` reads, and for the same
 * reason: the gateway's own gate is `session["running"]`, which stays true
 * while a blocking prompt is parked, so `needsInput` belongs here next to the
 * two turn flags rather than being treated as idle.
 */
export function isSessionMidTurn(session: FocusedSessionFacts): boolean {
  return session.busy || session.awaitingResponse || session.needsInput
}

/**
 * Why a `session.cwd.set` was refused, as something a message can be chosen
 * from — never the raw wire string.
 *
 * `4009` is the gateway's "session busy" (`tui_gateway/methods_session.py`).
 * The client checks for it before calling, so seeing it here means the turn
 * started between the check and the call — a race, not a bug, and the honest
 * thing to say is the same sentence the pre-check says.
 */
export function explorerPathFailure(error: unknown): 'busy' | 'generic' {
  return gatewayRpcErrorCode(error) === 4009 ? 'busy' : 'generic'
}
