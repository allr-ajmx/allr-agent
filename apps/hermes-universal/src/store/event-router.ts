/**
 * THE gateway event router — the single consumer of the event stream.
 *
 * Every frame the gateway sends is attributed: `tui_gateway/server.py`'s
 * `_event_frame` stamps `session_id` unconditionally, and N concurrent sessions
 * multiplex over one socket. So the client's only job is to demux honestly:
 * resolve which session owns an event, fold it into THAT session's slice, and
 * fire side effects at the right scope.
 *
 * Two rules make cross-session bleed structurally impossible rather than merely
 * guarded (MJX-132):
 *
 *  1. Ownership is resolved against `$activeSessionKey`, which is NEVER null.
 *     The previous code compared against `$sessionId`, which is null on a draft
 *     chat — so its "does this event belong to me?" test silently passed for
 *     every foreign session, and a background turn painted into the empty chat
 *     the user was looking at.
 *  2. Unknown sessions FAIL CLOSED. The one exception is a blocking prompt: the
 *     Python side is parked in `_block` waiting for a response, so dropping one
 *     hangs that agent until it times out.
 */

import type { GatewayEvent } from '@/gateway'
import { translateNow } from '@/i18n'
import { coerceStringList, coerceText } from '@/lib/chat-messages'
import { type GatewayToolPayload, toolIdFromPayload } from '@/lib/chat-tool-parts'
import { playCompletionSound } from '@/lib/completion-sound'
import { resolveGatewayEventSessionId } from '@/lib/gateway-events'
import { triggerHaptic } from '@/lib/haptics'
import { stopSpeaking } from '@/lib/tts'
import { requestGateway } from '@/store/gateway'
import { dispatchNativeNotification } from '@/store/native-notifications'
import { flashPetActivity, setPetActivity } from '@/store/pet'
import {
  clearAllPrompts,
  setSessionApproval,
  setSessionClarify,
  setSessionSecret,
  setSessionSudo
} from '@/store/prompts'
import { reduceSessionState } from '@/store/session-reducer'
import {
  $activeSessionKey,
  $sessionStates,
  ensureSessionSlice,
  runtimeKeyForStoredSession,
  updateSession
} from '@/store/session-state-types'
import { upsertSubagent } from '@/store/subagents'
import { recordToolDiff } from '@/store/tool-diffs'
import type { ContextBreakdown, UsageStats } from '@/types/hermes'

// The session that owns the current unscoped stream — pinned on message.start,
// released on message.complete/error (see lib/gateway-events).
let unscopedStreamSessionId: null | string = null

/** Forget the unscoped-stream pin. Called on chat reset, session promote,
 *  gateway reconnect and profile switch — anywhere the stream's owner is no
 *  longer meaningful. */
export function resetUnscopedStreamPin(): void {
  unscopedStreamSessionId = null
}

/** Events that are about the app, not about one conversation — they are handled
 *  whether or not their session is known to us. */
const GLOBAL_EVENT_TYPES = new Set(['gateway.ready', 'session.title', 'sessions.changed', 'skin.changed'])

/** Blocking prompts: never dropped, because the agent is parked waiting. */
const BLOCKING_PROMPT_TYPES = new Set(['approval.request', 'clarify.request', 'secret.request', 'sudo.request'])

const EMPTY_USAGE: UsageStats = { calls: 0, input: 0, output: 0, total: 0 }

/**
 * Pull the live context breakdown for the statusbar label after a settled turn.
 * The ContextUsagePanel fetches its own breakdown on open; this only feeds the
 * label. Best-effort — keep the prior value on failure.
 */
async function refreshSessionUsage(key: string): Promise<void> {
  const sessionId = $sessionStates.get()[key]?.runtimeSessionId

  if (!sessionId) {
    return
  }

  try {
    const b = await requestGateway<ContextBreakdown>('session.context_breakdown', { session_id: sessionId })

    updateSession(key, state => ({
      ...state,
      usage: {
        ...EMPTY_USAGE,
        context_max: b.context_max,
        context_percent: b.context_percent,
        context_used: b.context_used,
        total: b.context_used ?? 0
      }
    }))
  } catch {
    /* leave the prior usage in place */
  }
}

// See the tool.complete case: lazy to avoid an event-router ↔ workspace-events cycle.
async function notifyWorkspaceChangeFromTool(payload: Record<string, unknown>): Promise<void> {
  const { notifyWorkspaceChanged, toolChangedPath, toolMayMutateFiles } = await import('@/store/workspace-events')

  if (toolMayMutateFiles(payload)) {
    notifyWorkspaceChanged(toolChangedPath(payload))
  }
}

/** Live auto-title push (the titler runs async, after the turn). Patches the
 *  owning session's live title and the sidebar list entry. */
function applySessionTitle(payload: Record<string, unknown>): void {
  const sid = coerceText(payload.session_id)
  const title = coerceText(payload.title).trim()

  if (!title) {
    return
  }

  // `session.title` carries a STORED id, so resolve through the reverse index
  // rather than comparing it to a runtime id (which never matched — the old code
  // tested `sid === $sessionId.get()`, so the live title landed on the wrong
  // chat or, more often, on none).
  const key = sid ? runtimeKeyForStoredSession(sid) : $activeSessionKey.get()

  if (key) {
    updateSession(key, state => ({ ...state, liveTitle: title }))
  }

  if (sid) {
    // Dynamic import — store/session imports this graph, so a static import
    // here would cycle.
    void import('@/store/session')
      .then(m => m.setSessions(prev => prev.map(s => (s.id === sid ? { ...s, title } : s))))
      .catch(() => {})
  }
}

/** Fold one gateway event into the session that owns it. */
export function routeGatewayEvent(event: GatewayEvent): void {
  const payload = (event.payload ?? {}) as Record<string, unknown>

  if (GLOBAL_EVENT_TYPES.has(event.type)) {
    if (event.type === 'session.title') {
      applySessionTitle(payload)
    }

    return
  }

  // Resolve the owning session. `activeSessionId` is the never-null map KEY, so
  // the fallback for an unscoped stream event can never resolve to nothing.
  const route = resolveGatewayEventSessionId({
    activeSessionId: $activeSessionKey.get(),
    eventType: event.type,
    explicitSessionId: event.session_id || '',
    unscopedStreamSessionId
  })

  unscopedStreamSessionId = route.nextUnscopedStreamSessionId

  if (route.drop || !route.sessionId) {
    return
  }

  const key = route.sessionId
  const isBlockingPrompt = BLOCKING_PROMPT_TYPES.has(event.type)

  if (!(key in $sessionStates.get())) {
    // Fail closed — except for a blocking prompt, whose agent is parked in
    // `_block` and would hang until timeout if we ignored it.
    if (!isBlockingPrompt) {
      return
    }

    ensureSessionSlice(key)
  }

  const isActive = key === $activeSessionKey.get()

  // --- Per-session blocking prompts ----------------------------------------
  switch (event.type) {
    case 'approval.request':
      setSessionApproval(key, {
        command: coerceText(payload.command),
        description: coerceText(payload.description) || 'dangerous command',
        // false only when a tirith warning forbids it; backend omits it otherwise.
        allowPermanent: payload.allow_permanent !== false,
        choices: coerceStringList(payload.choices) ?? undefined,
        smartDenied: payload.smart_denied === true
      })
      dispatchNativeNotification({
        kind: 'approval',
        title: translateNow('notifications.native.approvalTitle'),
        body: coerceText(payload.command) || coerceText(payload.description),
        sessionId: key
      })
      void triggerHaptic('warning')

      break
    case 'clarify.request': {
      // The gateway sends `question` + `choices` — NOT `prompt`; the other keys
      // are tolerated only as a fallback.
      const requestId = coerceText(payload.request_id)
      const question = coerceText(payload.question) || coerceText(payload.prompt) || coerceText(payload.message)

      if (requestId && question) {
        setSessionClarify(key, { requestId, question, choices: coerceStringList(payload.choices) })
        dispatchNativeNotification({
          kind: 'input',
          title: translateNow('notifications.native.inputTitle'),
          body: question,
          sessionId: key
        })
        void triggerHaptic('warning')
      }

      break
    }

    case 'sudo.request':
      setSessionSudo(key, {
        requestId: coerceText(payload.request_id),
        prompt: coerceText(payload.prompt) || coerceText(payload.command) || 'Enter your sudo password'
      })

      break

    case 'secret.request':
      setSessionSecret(key, {
        requestId: coerceText(payload.request_id),
        envVar: coerceText(payload.env_var),
        prompt: coerceText(payload.prompt) || coerceText(payload.message)
      })

      break

    case 'message.complete':
      clearAllPrompts(key)
      dispatchNativeNotification({
        kind: 'turnDone',
        title: translateNow('notifications.native.turnDoneTitle'),
        body: translateNow('notifications.native.turnDoneBody'),
        sessionId: key
      })
      // A turn finishing is worth hearing whichever session produced it — that
      // is the point of running several at once. (Gated by $hapticsMuted.)
      playCompletionSound()
      // Scoped to the session that settled, so a background completion can't
      // overwrite the visible chat's context-usage readout.
      void refreshSessionUsage(key)

      break

    case 'error':
      clearAllPrompts(key)
      dispatchNativeNotification({
        kind: 'turnError',
        title: translateNow('notifications.native.turnErrorTitle'),
        body: coerceText(payload.message),
        sessionId: key
      })

      break
    case 'tool.complete': {
      // Live side-channel diff: the gateway renders the edit diff itself and
      // ships it on tool.complete (server.py `_on_tool_complete`). The renderer
      // prefers this over one parsed out of the result, keyed by the SAME id the
      // part adopted in upsertToolPart.
      const inlineDiff = coerceText(payload.inline_diff)

      if (inlineDiff.trim()) {
        recordToolDiff(toolIdFromPayload(payload as GatewayToolPayload), inlineDiff)
      }

      // A file-mutating tool just finished — nudge the git-mirroring surfaces
      // (coding rail, review pane, file tree) to refresh. Event-driven, not
      // polled: fires exactly when the agent touches the tree.
      void notifyWorkspaceChangeFromTool(payload)

      break
    }

    default:
      // Subagent lifecycle (spawn/start/thinking/tool/progress/complete) feeds
      // the Agents view's spawn tree, keyed by the session that OWNS it — the
      // old code keyed every tree on the active session (or the literal
      // 'active'), so a background session's agents showed up under whichever
      // chat happened to be open.
      if (event.type.startsWith('subagent.')) {
        const createIfMissing = event.type === 'subagent.spawn_requested' || event.type === 'subagent.start'
        upsertSubagent(key, payload, createIfMissing, event.type)
      }

      break
  }

  // --- The transcript ------------------------------------------------------
  updateSession(key, state => reduceSessionState(state, event, payload))

  // --- ACTIVE-session-only presentation ------------------------------------
  // The pet, TTS and the workspace cwd describe what the user is looking at, so
  // they follow the active session rather than the one that emitted the event.
  if (!isActive) {
    return
  }

  switch (event.type) {
    case 'message.start':
      setPetActivity({ busy: true }) // pet: working pose
      stopSpeaking() // interrupt any TTS from the previous turn

      break

    case 'reasoning.available':

    case 'reasoning.delta':

    case 'moa.reference':
      setPetActivity({ reasoning: true }) // pet: thinking pose

      break

    case 'tool.start':

    case 'tool.progress':

    case 'tool.generating':
      setPetActivity({ reasoning: false, toolRunning: true }) // pet: working pose

      break

    case 'tool.complete':
      setPetActivity({ toolRunning: false })

      break

    case 'message.complete':
      setPetActivity({ busy: false, reasoning: false, toolRunning: false }) // pet: idle/roam
      // Auto-TTS is driven by `useAutoSpeakReplies` (guarded against a running
      // voice conversation + the shared dedupe cursor). Reading it here too
      // would speak every reply twice during a conversation (MJX-96).

      break

    case 'approval.request':

    case 'clarify.request':

    case 'secret.request':

    case 'sudo.request':
      setPetActivity({ awaitingInput: true }) // pet: waiting pose (blocked on user)

      break

    case 'error':
      // pet: crying pose, auto-decaying back to normal after 5s.
      setPetActivity({ busy: false, reasoning: false, toolRunning: false })
      flashPetActivity({ error: true }, 5000)

      break

    default:
      break
  }
}
