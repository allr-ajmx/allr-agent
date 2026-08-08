import { COMMAND_CENTER_ROUTE } from '@/app/routes'
import {
  deleteSession,
  getSessionMessages,
  listAllProfileSessions,
  renameSession,
  searchSessions,
  setSessionArchived
} from '@/hermes'
import { translateNow } from '@/i18n'
import { chatMessageText } from '@/lib/chat-messages'
import { Codecs, persistentAtom } from '@/lib/persisted'
import { appendLiveSessionProjection, toChatMessages } from '@/lib/session-history'
import { stableArray } from '@/lib/stable-array'
import { atom, computed } from '@/store/atom'
import { $busy, $clarify, $currentCwd, $messages, $sessionId, type ChatMessage, resetChat } from '@/store/chat'
import { resetUnscopedStreamPin } from '@/store/event-router'
import { requestGateway } from '@/store/gateway'
import { $pinnedSessionIds, pinSession, unpinSession } from '@/store/layout'
import { notify, notifyError } from '@/store/notifications'
import { flashPetActivity } from '@/store/pet'
// Import direction is `session.ts → profile.ts → profiles.ts`; never the reverse.
import { $profileScope, ALL_PROFILES } from '@/store/profile'
import {
  $activeSessionKey,
  $sessionStates,
  ensureSessionSlice,
  hydratingKey,
  rekeySession,
  runtimeKeyForStoredSession,
  updateSession
} from '@/store/session-state-types'
import { isSecondaryWindow, openAppRoute } from '@/store/windows'
import type { SessionCreateResponse, SessionInfo, SessionResumeResponse, SessionSearchResult } from '@/types/hermes'

// Session history + switching (Hc2). Lean adaptation of desktop store/session.ts —
// no windows/projects/pins/profiles/branch/cwd/model. Two ids: the STORED id
// (list rows, $activeStoredSessionId) vs the RUNTIME id ($sessionId in chat.ts,
// what prompt.submit targets), bound by session.resume.

const PAGE = 30

export const $sessions = atom<SessionInfo[]>([])
export const $sessionsLoading = atom(false)
export const $sessionsTotal = atom(0)
export const $sessionsLimit = atom(PAGE)
export const $activeStoredSessionId = atom<null | string>(null)
// Compat alias for ported desktop code (`@/store/session` → `$activeSessionId`).
// Universal's stored id IS the desktop "active session" id for a single-session app.
export const $activeSessionId = $activeStoredSessionId

// The last chat that was actually open, remembered across launches.
//
// A phone always cold-starts at "/" — there is no window to restore and no URL
// to come back to — so without this the app opened on an empty new session every
// time, and the chat you were in the middle of was three taps away in the
// sidebar. Written on every switch, read once at boot (see
// `use-restore-last-session`).
//
// A draft (null) is deliberately NOT recorded: an unsaved chat has nothing to
// restore, and letting it overwrite the value would mean opening a new session
// once wiped out the memory of the last real one. A secondary window never
// writes — it does not own the user's place in the app.
const LAST_SESSION_KEY = 'hermes.lastSessionId'

const $lastSessionId = persistentAtom<null | string>(LAST_SESSION_KEY, null, Codecs.nullableText)

if (!isSecondaryWindow()) {
  $activeStoredSessionId.subscribe(id => {
    if (id) {
      $lastSessionId.set(id)
    }
  })
}

/** The session to land on at boot, if any. */
export function lastOpenedSessionId(): null | string {
  return $lastSessionId.get()
}

export const $sessionSearch = atom<SessionSearchResult[]>([])
export const $searchLoading = atom(false)

// Stored ids that finished a turn in the BACKGROUND (a tile, not the focused
// session) — the sidebar's "finished while you were away" marker. Written by
// `store/session-states.ts#handleTransition`; a view clears its id when seen.
export const $unreadFinishedSessionIds = atom<string[]>([])

export function clearUnreadFinishedSession(storedSessionId: string): void {
  const cur = $unreadFinishedSessionIds.get()

  if (cur.includes(storedSessionId)) {
    $unreadFinishedSessionIds.set(cur.filter(id => id !== storedSessionId))
  }
}

// Opening a session clears its unread state — the user is now looking at it.
// Hung off the atom rather than the several `openSession`/`hydrateColdSession`
// call sites so it exactly mirrors the mark, which `session-states.ts#handleTransition`
// gates on this same atom: a turn that settles while its session ISN'T active
// becomes unread, and the moment it becomes active it stops being.
$activeStoredSessionId.listen(storedId => {
  if (storedId) {
    clearUnreadFinishedSession(storedId)
  }
})

/** Follow a compression-driven stored-id rotation for the LIVE primary runtime
 *  (auto-compression mints a new session id mid-turn). Guarded by provenance so
 *  a stale background rotation can't steal the foreground selection. Called by
 *  `session-states.ts#handleTransition`. */
export function setActiveSessionStoredIdRotation(rotation: {
  nextStoredSessionId: string
  previousStoredSessionId: string
  runtimeSessionId: string
}): void {
  if (rotation.runtimeSessionId !== $sessionId.get()) {
    return
  }

  if ($activeStoredSessionId.get() !== rotation.previousStoredSessionId) {
    return
  }

  $activeStoredSessionId.set(rotation.nextStoredSessionId)
}

// Sidebar row state — the UNION of the primary (single active chat) and every
// open TILE. "working" = a session streaming a turn; "needs input" = a session
// with a clarify prompt pending. The tile slices come from `$sessionStates`
// (tiles only); the primary comes from the global `$busy`/`$clarify`. Guarded
// with `stableArray` so the per-token republish of `$sessionStates` doesn't
// re-render the sidebar unless membership actually changed.
let workingArr: readonly string[] = []
let workingSet = new Set<string>()
export const $workingSessionIds = computed(
  [$busy, $activeStoredSessionId, $sessionStates],
  (busy, activeId, states) => {
    const next: string[] = []

    if (busy && activeId) {
      next.push(activeId)
    }

    for (const s of Object.values(states)) {
      if (s.busy && s.storedSessionId && !next.includes(s.storedSessionId)) {
        next.push(s.storedSessionId)
      }
    }

    const stable = stableArray(workingArr, next)

    if (stable !== workingArr) {
      workingArr = stable
      workingSet = new Set(stable)
    }

    return workingSet
  }
)

let attentionArr: readonly string[] = []
export const $attentionSessionIds = computed(
  [$clarify, $activeStoredSessionId, $sessionStates],
  (clarify, activeId, states) => {
    const next: string[] = []

    if (clarify && activeId) {
      next.push(activeId)
    }

    for (const s of Object.values(states)) {
      if (s.needsInput && s.storedSessionId && !next.includes(s.storedSessionId)) {
        next.push(s.storedSessionId)
      }
    }

    return (attentionArr = stableArray(attentionArr, next))
  }
)

/** Title of the currently-viewed chat (title → first-message preview → ''),
 *  parity with desktop's `sessionTitle`. Empty for a fresh/unsaved chat — the
 *  titlebar / mobile header show their brand fallback then. Drives the topbar. */
export const $activeSessionTitle = computed([$sessions, $activeStoredSessionId], (sessions, activeId) => {
  if (!activeId) {
    return ''
  }

  const session = sessions.find(s => s.id === activeId)

  return session ? session.title?.trim() || session.preview?.trim() || '' : ''
})

/** Functional setter for optimistic row edits (rename dialog etc.). */
export function setSessions(updater: (prev: SessionInfo[]) => SessionInfo[]): void {
  $sessions.set(updater($sessions.get()))
}

/** Durable pin key: the lineage-root id survives auto-compression's id rotation. */
export function sessionPinId(session: SessionInfo): string {
  return session._lineage_root_id ?? session.id
}

/** True when a stored/lineage id resolves to this session — it matches either
 *  the live id or the stable lineage root (see sessionPinId). Verbatim from
 *  desktop store/session.ts. */
export const sessionMatchesStoredId = (
  session: Pick<SessionInfo, '_lineage_root_id' | 'id'>,
  storedSessionId: string
): boolean => session.id === storedSessionId || session._lineage_root_id === storedSessionId

/** Pin/unpin the active session — the `session.togglePin` keybind action.
 *  Adapted from desktop `app/contrib/wiring.tsx`; pins are keyed by the durable
 *  lineage id so the pin survives auto-compression. */
export function toggleSelectedPin(): void {
  const sessionId = $activeStoredSessionId.get()

  if (!sessionId) {
    return
  }

  const session = $sessions.get().find(s => sessionMatchesStoredId(s, sessionId))
  const pinId = session ? sessionPinId(session) : sessionId

  if ($pinnedSessionIds.get().includes(pinId)) {
    unpinSession(pinId)
  } else {
    pinSession(pinId)
  }
}

// ── Messaging-platform sessions (Discord, Telegram, …) ──────────────────────
const MESSAGING_SOURCES = new Set([
  'api_server',
  'bluebubbles',
  'discord',
  'email',
  'homeassistant',
  'matrix',
  'mattermost',
  'qqbot',
  'signal',
  'slack',
  'sms',
  'telegram',
  'webhook',
  'weixin',
  'whatsapp',
  'yuanbao'
])

export function isMessagingSource(source: null | string): boolean {
  return !!source && MESSAGING_SOURCES.has(source.toLowerCase())
}

const MESSAGING_SOURCE_LABELS: Record<string, string> = {
  api_server: 'API',
  bluebubbles: 'iMessage',
  discord: 'Discord',
  email: 'Email',
  homeassistant: 'Home Assistant',
  matrix: 'Matrix',
  mattermost: 'Mattermost',
  qqbot: 'QQ',
  signal: 'Signal',
  slack: 'Slack',
  sms: 'SMS',
  telegram: 'Telegram',
  webhook: 'Webhook',
  weixin: 'WeChat',
  whatsapp: 'WhatsApp',
  yuanbao: 'Yuanbao'
}

export function messagingSourceLabel(source: string): string {
  return MESSAGING_SOURCE_LABELS[source.toLowerCase()] ?? source.charAt(0).toUpperCase() + source.slice(1)
}

export const $messagingSessions = atom<SessionInfo[]>([])

// Cross-platform messaging sessions, kept in their own slice so a busy platform
// doesn't crowd out the recents page (they're excluded from the recents fetch).
export async function refreshMessagingSessions(): Promise<void> {
  try {
    const res = await listAllProfileSessions(100, 1, 'exclude', 'recent', 'all', { excludeSources: ['cron'] })
    $messagingSessions.set((res.sessions ?? []).filter(session => isMessagingSource(session.source)))
  } catch {
    // Best-effort; keep the last known slice.
  }
}

// Recents come from the cross-profile aggregator in BOTH scope modes, mirroring
// desktop's `recentsProfile`: 'all' for the browse view, else the concrete profile
// key. Going through the aggregator (rather than listSessions, which is NOT
// profile-scoped) is what actually scopes the sidebar to the active profile, and
// it tags every row with its owning `profile` — which the lanes and ProfileTag
// need. `$sessionsLimit` stays global, so in browse mode a limit of N is split
// across profiles by recency; `resetSessionsPaging()` keeps a big browse-mode
// limit from leaking into a small single profile.
//
// This RELOADS the whole loaded window (offset 0, `$sessionsLimit` rows) rather
// than paging: it runs when the list may have changed underneath us, so every
// loaded row has to be re-read to stay correct. Paging deeper is
// `loadMoreSessions`, which appends a single offset-addressed page.
export async function refreshSessions(): Promise<void> {
  $sessionsLoading.set(true)

  const scope = $profileScope.get()

  try {
    const res = await listAllProfileSessions(
      $sessionsLimit.get(),
      1,
      'exclude',
      'recent',
      scope === ALL_PROFILES ? 'all' : scope
    )

    $sessions.set(res.sessions)
    $sessionsTotal.set(scope === ALL_PROFILES ? res.total : (res.profile_totals?.[scope] ?? res.total))
  } catch (err) {
    // A list-fetch failure is not any one chat's status: surface it as a
    // notification instead of pinning it to whichever session is on screen.
    notifyError(err, 'Failed to load sessions')
  } finally {
    $sessionsLoading.set(false)
  }
}

/** Drop back to the first page — called when the profile scope changes, and when a
 *  soft gateway switch starts the list over. */
export function resetSessionsPaging(): void {
  $sessionsLimit.set(PAGE)
}

/**
 * Append the NEXT page — one `offset`-addressed fetch of `PAGE` rows, not a
 * re-fetch of the whole window. `$sessionsLimit` tracks how many rows are
 * loaded so a later `refreshSessions()` restores the same depth.
 *
 * Rows are de-duplicated by id: the list is ordered by recency, so a session
 * that gets a message between the two fetches shifts toward the head and can
 * appear in both pages. Without the guard it would render twice and React would
 * warn on the duplicate key.
 */
export async function loadMoreSessions(): Promise<void> {
  const loaded = $sessions.get()
  const scope = $profileScope.get()

  $sessionsLoading.set(true)

  try {
    const res = await listAllProfileSessions(
      PAGE,
      1,
      'exclude',
      'recent',
      scope === ALL_PROFILES ? 'all' : scope,
      {},
      loaded.length
    )

    const seen = new Set(loaded.map(session => session.id))
    const fresh = (res.sessions ?? []).filter(session => !seen.has(session.id))

    if (fresh.length) {
      $sessions.set([...loaded, ...fresh])
    }

    $sessionsLimit.set(loaded.length + fresh.length)
    $sessionsTotal.set(scope === ALL_PROFILES ? res.total : (res.profile_totals?.[scope] ?? res.total))
  } catch (err) {
    notifyError(err, 'Failed to load sessions')
  } finally {
    $sessionsLoading.set(false)
  }
}

// Only the newest open may write chat state. Two async sources (the REST
// transcript + the resume RPC) mean a fast switch can land the SLOWER response
// of the chat you just left after the newer one already painted — desktop's
// `isCurrentResume` guard, in miniature.
let openGeneration = 0
const isCurrentOpen = (generation: number): boolean => generation === openGeneration

/**
 * Open a stored session.
 *
 * WARM sessions promote SYNCHRONOUSLY. A session that already has a slice — a
 * background bubble, an open tile, or one we simply haven't evicted — is made
 * active by moving the pointer, with no `session.resume`, no transcript clear,
 * and no await. That is what makes switching mid-turn lossless: the outgoing
 * session keeps its slice and keeps streaming into it, and the incoming one is
 * already whole.
 *
 * The old implementation cleared `$messages` and set `$busy` immediately but
 * bound the runtime id only AFTER awaiting REST + resume. In that window the
 * outgoing session's deltas still matched the active id, so they appended into
 * the transcript of the chat you had just switched to — and were then clobbered
 * by the resume payload, and lost from the session that produced them. That is
 * MJX-132.
 */
export function openSession(storedId: string): Promise<void> | void {
  const warm = runtimeKeyForStoredSession(storedId)

  if (warm && $sessionStates.get()[warm]) {
    openGeneration++ // cancel any hydrate still in flight
    resetUnscopedStreamPin()
    $activeStoredSessionId.set(storedId)
    $activeSessionKey.set(warm)

    return
  }

  return hydrateColdSession(storedId)
}

/**
 * Hydrate a session that has no live slice: transcript + runtime binding.
 *
 * AUTHORITY: the transcript comes from the REST endpoint
 * (`GET /api/sessions/{id}/messages` → `db.get_messages`), NOT from the resume
 * RPC. `session.resume` returns a display-REDUCED history
 * (`_history_to_messages` in tui_gateway/server.py): assistant rows that only
 * made tool calls are dropped outright — taking that step's reasoning with them
 * — and each tool result is flattened to `{role, name, context}` with no
 * `tool_call_id` and no output. Hydrating from it lost every intermediate
 * thinking block and collapsed repeated same-name tool calls into one row.
 * The resume payload is still what binds the runtime id, the cwd, and the
 * in-flight turn; its messages are only a fallback when REST is unavailable.
 */
async function hydrateColdSession(storedId: string): Promise<void> {
  const generation = ++openGeneration
  resetUnscopedStreamPin()

  // The session gets its slice up front, under a placeholder key, so the UI has
  // something of its own to render immediately instead of a blank chat that a
  // later response overwrites.
  //
  // Each stored session carries the project directory it runs in. Restore it
  // from the list row so the statusbar / file tree switch with the chat
  // immediately; the resume response's runtime info supersedes it below with the
  // authoritative value. (A cwd-less row settles to '' — a detached chat — which
  // is the correct final state, not a flicker; the files-tree white flash is
  // handled where it belongs, in use-project-tree.)
  let key = hydratingKey(storedId)

  ensureSessionSlice(key, {
    storedSessionId: storedId,
    busy: true,
    cwd: $sessions.get().find(session => session.id === storedId)?.cwd ?? ''
  })

  $activeStoredSessionId.set(storedId)
  $activeSessionKey.set(key)

  // A session resumed MID-TURN stays busy: the committed transcript ends before
  // the running turn, and `inflight` carries its tail. Settle to idle otherwise.
  let stillRunning = false

  // The REST transcript and the resume RPC are independent, so run them
  // concurrently (desktop does the same): wall time is max(), not sum, and the
  // transcript paints as soon as it lands instead of waiting on the agent build.
  // `.then(...)` rather than a bare call so a synchronous throw inside the REST
  // client can't take the resume down with it.
  const transcriptPromise = Promise.resolve()
    .then(() => getSessionMessages(storedId))
    .catch(() => null)

  const resumePromise = requestGateway<SessionResumeResponse>('session.resume', {
    session_id: storedId,
    cols: 96
  })

  // The rejection is consumed by the `await` below; this only keeps it from
  // surfacing as an unhandled rejection while the transcript fetch settles.
  resumePromise.catch(() => undefined)

  try {
    const transcript = await transcriptPromise
    const hydrated = transcript?.messages?.length ? toChatMessages(transcript.messages) : []
    // Only treat REST as the authority when it actually yielded a transcript —
    // an empty result falls through to the resume payload rather than painting
    // an empty chat.
    const restMessages = hydrated.length ? hydrated : null

    if (restMessages && isCurrentOpen(generation)) {
      updateSession(key, state => ({ ...state, messages: restMessages }))
    }

    const resumed = await resumePromise

    if (!isCurrentOpen(generation)) {
      // A newer open superseded this one. The slice is still this session's, so
      // leave it alone rather than dropping a resume the user may return to.
      return
    }

    const runtimeId = resumed.session_id ?? storedId

    // Project the still-running turn onto the committed transcript, so its
    // pending assistant exists for the live reducer to keep filling — otherwise
    // the turn's remaining tool events land in a fresh bubble that never settles.
    // The REST transcript is the authority when we have it (see AUTHORITY note).
    const messages = appendLiveSessionProjection(restMessages ?? toChatMessages(resumed.messages ?? []), resumed)

    stillRunning = Boolean(resumed.inflight?.streaming ?? resumed.running)

    // SYNCHRONOUS, before any further await: the router drops events for unknown
    // keys, so the slice has to exist under its real runtime id before the first
    // streamed event for it is processed. JS drains microtasks before the next
    // websocket message task, so this ordering holds.
    rekeySession(key, runtimeId, {
      runtimeSessionId: runtimeId,
      storedSessionId: storedId,
      messages,
      busy: stillRunning,
      ...(resumed.info?.cwd ? { cwd: resumed.info.cwd } : {})
    })

    key = runtimeId
  } catch (err) {
    if (!isCurrentOpen(generation)) {
      return
    }

    // The resume RPC failed. Fall back to the REST transcript alone (already
    // painted above when it resolved) so the chat at least shows its history,
    // with no live runtime binding.
    const transcript = await transcriptPromise

    if (transcript) {
      rekeySession(key, storedId, {
        runtimeSessionId: storedId,
        storedSessionId: storedId,
        messages: toChatMessages(transcript.messages ?? [])
      })
      key = storedId
    } else {
      // Not the session's own status: surface it as a notification rather than
      // wedging a load error into this chat's status line, where it would stick.
      notifyError(err, 'Failed to open session')
    }
  } finally {
    if (isCurrentOpen(generation)) {
      updateSession(key, state => ({ ...state, busy: stillRunning }))
    }
  }
}

export function newSession(cwd?: string): void {
  resetChat(cwd)
  $activeStoredSessionId.set(null)
  flashPetActivity({ greeting: true }) // pet: wave hello on a fresh chat
}

/**
 * Open a fresh chat anchored to a specific directory — desktop's
 * `startWorkspaceSession`, reduced to what universal needs. Used by the
 * composer's "start work" / branch-off hand-off, where a worktree was just
 * created and the next session must run inside it rather than in the configured
 * default project dir.
 *
 * The anchor is the new DRAFT'S OWN slice cwd, seeded as part of the reset
 * rather than written over it afterwards. Resetting first and correcting second
 * publishes the directory in between — the configured default, or '' when there
 * is none, which sends `$effectiveCwd` to the backend workspace root. The
 * composer hand-off hides that: it runs inside a `$startWorkSessionRequest`
 * listener, where nanostores coalesces nested writes. The SIDEBAR's "start work"
 * calls straight from a click handler (sidebar-content `newSessionInWorkspace`),
 * so there the intermediate reached every subscriber and the statusbar path and
 * file tree flipped to it until the first prompt re-notified them.
 *
 * `ensureSession` reads the anchor back on that first prompt. Per-session by
 * construction: a second draft — a mobile bubble, another tab — carries its own
 * directory and can't inherit this one.
 */
export function startSessionInWorkspace(path: string): void {
  newSession(path.trim() || undefined)
}

/**
 * Optimistically add a just-created session to the sidebar list + mark it active,
 * seeding the row's PREVIEW with the user's first message so `sessionTitle`
 * (title || preview || 'Untitled') shows it immediately — instead of the chat
 * being absent from the list and the header stuck on "New session". The backend's
 * async `session.title` event later patches `title` in place (see store/chat.ts),
 * superseding the first-message preview. Desktop parity (upsertOptimisticSession).
 */
export function registerNewSession(id: string, firstMessage: string): void {
  const now = Math.floor(Date.now() / 1000)

  const stub: SessionInfo = {
    // Seed the row's project directory (ensureSession just adopted the runtime's
    // resolved cwd) so re-opening this chat later restores the same directory,
    // and the sidebar can group it by workspace right away.
    cwd: $currentCwd.get().trim() || null,
    ended_at: null,
    id,
    input_tokens: 0,
    is_active: true,
    last_active: now,
    message_count: 1,
    model: null,
    output_tokens: 0,
    preview: firstMessage.trim().slice(0, 200) || null,
    source: null,
    started_at: now,
    title: null,
    tool_call_count: 0
  }

  $sessions.set([stub, ...$sessions.get().filter(s => s.id !== id)])
  $activeStoredSessionId.set(id)
}

/** The copyable spine of a branch: user/assistant turns that carry text.
 *  Ported from desktop's use-session-actions/utils.ts `toBranchMessages`. */
function toBranchMessages(
  messages: ChatMessage[]
): { content: string; role: ChatMessage['role']; source: ChatMessage }[] {
  return messages
    .map(message => ({ content: chatMessageText(message), role: message.role, source: message }))
    .filter(({ content, role }) => content.trim() && (role === 'assistant' || role === 'user'))
}

/**
 * Fork the open chat off its live transcript — `/branch` (aliases `/fork`) and
 * the assistant message's "branch in new chat". Ported from desktop's
 * `branchCurrentSession` + `forkBranch`: the copied turns are handed to
 * `session.create` (which auto-names the branch from its parent's lineage), so
 * the new chat opens pre-seeded instead of empty. Without `messageId` it forks
 * from the last user/assistant turn.
 */
export async function branchCurrentSession(messageId?: string): Promise<boolean> {
  if (!$sessionId.get()) {
    notify({
      kind: 'warning',
      title: translateNow('desktop.nothingToBranch'),
      message: translateNow('desktop.branchNeedsChat')
    })

    return false
  }

  if ($busy.get()) {
    notify({
      kind: 'warning',
      title: translateNow('desktop.sessionBusy'),
      message: translateNow('desktop.branchStopCurrent')
    })

    return false
  }

  const messages = $messages.get()

  // findLastIndex is ES2023; this project's lib target predates it, so scan back.
  const lastTurnIndex = (): number => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const role = messages[index].role

      if (role === 'assistant' || role === 'user') {
        return index
      }
    }

    return -1
  }

  const at = messageId ? messages.findIndex(message => message.id === messageId) : lastTurnIndex()

  // An explicit target that can't be resolved must NOT silently degrade into
  // "branch the last turn" — that forks the wrong conversation. (This is what
  // the missing id passthrough in app/chat/runtime.tsx used to cause.)
  if (messageId && at < 0) {
    notify({
      kind: 'warning',
      title: translateNow('desktop.nothingToBranch'),
      message: translateNow('desktop.branchNoText')
    })

    return false
  }

  const start = at >= 0 ? at : Math.max(messages.length - 1, 0)
  const end = at >= 0 ? at + 1 : messages.length
  const branchMessages = toBranchMessages(messages.slice(start, end))

  if (!branchMessages.length) {
    notify({
      kind: 'warning',
      title: translateNow('desktop.nothingToBranch'),
      message: translateNow('desktop.branchNoText')
    })

    return false
  }

  const parentStoredId = $activeStoredSessionId.get()
  const cwd = $currentCwd.get().trim()

  try {
    // No title: the backend auto-names the branch from its parent's lineage.
    const branched = await requestGateway<SessionCreateResponse>('session.create', {
      cols: 96,
      ...(cwd && { cwd }),
      messages: branchMessages.map(({ content, role }) => ({ content, role })),
      ...(parentStoredId && { parent_session_id: parentStoredId })
    })

    const storedId = branched.stored_session_id ?? branched.session_id
    const rows = $sessions.get()

    const siblings = parentStoredId
      ? rows.filter(session => session.parent_session_id?.trim() === parentStoredId).length
      : 0

    // The branch is a NEW session, so it gets its own slice keyed by its runtime
    // id — it does not overwrite the parent's, which stays open behind it.
    // Paint the copied turns locally rather than re-fetching: the branch has no
    // committed transcript until its first real message lands.
    ensureSessionSlice(branched.session_id, {
      runtimeSessionId: branched.session_id,
      storedSessionId: storedId,
      messages: branchMessages.map(({ source }) => source),
      busy: false,
      cwd: (branched.info?.cwd ?? cwd ?? '').trim(),
      sessionStartedAt: Date.now()
    })
    $activeSessionKey.set(branched.session_id)
    registerNewSession(storedId, branchMessages.map(({ content }) => content).find(Boolean) ?? '')
    setSessions(prev =>
      prev.map(session =>
        session.id === storedId
          ? {
              ...session,
              parent_session_id: parentStoredId ?? null,
              title: translateNow('desktop.branchTitle', siblings + 1).toLowerCase()
            }
          : session
      )
    )

    return true
  } catch (err) {
    notifyError(err, translateNow('desktop.branchFailed'))

    return false
  }
}

/**
 * `/resume` (and the composer completion's "Browse all…" row) opens desktop's
 * dedicated session-picker overlay. Universal's equivalent surface is the
 * Command Center's `sessions` section, so route there instead of shipping a
 * second picker. Closing is the overlay's own job (Esc / backdrop), so `false`
 * is a no-op here.
 */
export function setSessionPickerOpen(open: boolean): void {
  if (open) {
    openAppRoute(`${COMMAND_CENTER_ROUTE}?section=sessions`)
  }
}

/**
 * Per-session YOLO (approval bypass) state, mirrored from the `config.set`
 * round-trip in lib/yolo-session.ts so the `/yolo` handler can toggle it.
 */
export const $yoloActive = atom(false)

export const setYoloActive = (active: boolean): void => $yoloActive.set(active)

export async function renameSessionLocal(id: string, title: string): Promise<void> {
  const prev = $sessions.get()
  $sessions.set(prev.map(s => (s.id === id ? { ...s, title } : s)))

  try {
    await renameSession(id, title)
  } catch (err) {
    $sessions.set(prev)
    notifyError(err, 'Rename failed')
  }
}

export async function deleteSessionLocal(id: string): Promise<void> {
  const prev = $sessions.get()
  $sessions.set(prev.filter(s => s.id !== id))
  $sessionsTotal.set(Math.max(0, $sessionsTotal.get() - 1))

  if ($activeStoredSessionId.get() === id) {
    newSession()
  }

  try {
    await deleteSession(id)
  } catch (err) {
    $sessions.set(prev)
    $sessionsTotal.set($sessionsTotal.get() + 1)
    notifyError(err, 'Delete failed')
  }
}

export async function archiveSessionLocal(id: string): Promise<void> {
  const prev = $sessions.get()
  $sessions.set(prev.filter(s => s.id !== id))

  if ($activeStoredSessionId.get() === id) {
    newSession()
  }

  try {
    await setSessionArchived(id, true)
  } catch (err) {
    $sessions.set(prev)
    notifyError(err, 'Archive failed')
  }
}

export async function searchSessionsQuery(query: string): Promise<void> {
  const q = query.trim()

  if (!q) {
    $sessionSearch.set([])

    return
  }

  $searchLoading.set(true)

  try {
    const res = await searchSessions(q)
    $sessionSearch.set(res.results ?? [])
  } catch {
    $sessionSearch.set([])
  } finally {
    $searchLoading.set(false)
  }
}
