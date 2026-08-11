/**
 * THE transcript reducer — one pure function that folds a gateway event into ONE
 * session's slice. It is applied identically to every session: the chat on
 * screen, a layout-tree tile, a background mobile bubble.
 *
 * There used to be two reducers — this one for tiles and a parallel copy inside
 * `store/chat.ts` writing global atoms for the visible chat. Keeping them in
 * sync was the source of MJX-132 (a background session's tokens reaching the
 * on-screen transcript) and of quieter divergences: tiles never applied the
 * authoritative `final_response`, never rendered MEDIA: tags, and asked the
 * GLOBAL `$busy` whether a late tool event belonged to a settled turn.
 *
 * Side effects (pet, TTS, notifications, sound, workspace nudges) are NOT here —
 * they live in `store/event-router.ts`, which decides which of them are scoped
 * to the session that produced the event and which follow the active one.
 */

import type { GatewayEvent } from '@/gateway'
import {
  appendAssistantTextPart,
  appendStreamPart,
  applyCompletion,
  applySettledReasoning,
  type ChatMessage,
  coerceText,
  patchActive,
  withActiveAssistant
} from '@/lib/chat-messages'
import { coerceThinkingText } from '@/lib/chat-runtime'
import { type GatewayToolPayload, upsertToolPart } from '@/lib/chat-tool-parts'
import { isLiveTailRow } from '@/lib/live-tail'
import { type ClientSessionState } from '@/store/session-state-types'

const patchLastAssistant = (state: ClientSessionState, patch: (m: ChatMessage) => ChatMessage): ClientSessionState => ({
  ...state,
  messages: patchActive(state.messages, patch)
})

/** A payload counter, or undefined when the gateway omitted it. Distinct from
 *  `coerceText`: a 0 must survive, and a missing count must not render as "0". */
const numeric = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

/**
 * Route a tool event into a session's transcript. While a turn is live the parts
 * land on the pending assistant; a LATE event (one arriving after
 * `message.complete` — a trailing completion, a sub-agent mirror) must merge
 * into the last assistant instead of opening a fresh `pending: true` bubble that
 * nothing ever settles.
 *
 * Desktop gets this from `pending: m => phase !== 'complete' || (m.pending ??
 * false)` in use-message-stream. The "is the turn settled?" question is answered
 * from THIS session's `busy`, never a global one — asking the global `$busy` (as
 * the old primary reducer did) makes one session's turn state decide where
 * another session's tool rows land.
 */
function applyToolEvent(
  state: ClientSessionState,
  payload: GatewayToolPayload,
  phase: 'complete' | 'running'
): ClientSessionState {
  const messages = state.messages
  const last = messages[messages.length - 1]
  const settledAssistant = !state.busy && last?.role === 'assistant' && !last.pending

  if (settledAssistant) {
    const copy = messages.slice()
    copy[copy.length - 1] = { ...last, parts: upsertToolPart(last.parts, payload, phase) }

    return { ...state, messages: copy }
  }

  return patchLastAssistant(state, m => ({ ...m, parts: upsertToolPart(m.parts, payload, phase) }))
}

/** Reduce ONE gateway event into ONE session's state slice. Pure. */
export function reduceSessionState(
  state: ClientSessionState,
  event: GatewayEvent,
  payload: Record<string, unknown>
): ClientSessionState {
  switch (event.type) {
    case 'message.start':
      return {
        ...state,
        busy: true,
        turnStartedAt: Date.now(),
        statusLine: '',
        interrupted: false,
        interimBoundaryPending: false,
        messages: withActiveAssistant(state.messages)
      }

    case 'message.delta':
      return patchLastAssistant(state, m => ({
        ...m,
        parts: appendAssistantTextPart(m.parts, coerceText(payload.text))
      }))

    // An interim finalizes the current bubble mid-turn: the next delta opens a
    // fresh one rather than appending to a paragraph the agent considers done.
    case 'message.interim':
      return {
        ...state,
        interimBoundaryPending: true,
        // Which row the live tail is currently writing into is `live-tail`'s
        // question, not this reducer's — asking it here keeps the seal and the
        // reconciler from ever disagreeing about what "still in flight" means.
        // The seal is also recorded on the row: a settled interim is mid-turn
        // commentary, and the renderer hangs no action bar off one.
        messages: state.messages.map(m =>
          m.role === 'assistant' && isLiveTailRow(m) ? { ...m, interim: true, pending: false } : m
        )
      }

    case 'reasoning.delta':
      return patchLastAssistant(state, m => ({
        ...m,
        parts: appendStreamPart(m.parts, 'reasoning', coerceThinkingText(payload.text))
      }))

    // A COALESCED reasoning batch from lib/stream-batch. `coerceThinkingText`
    // has per-chunk semantics — it strips a leading spinner prefix and drops
    // placeholder-only chunks — so it runs when each delta is queued, not here:
    // re-running it on the joined batch would only ever look at the batch's
    // leading edge and would miss an interior placeholder entirely.
    case 'reasoning.batch':
      return patchLastAssistant(state, m => ({
        ...m,
        parts: appendStreamPart(m.parts, 'reasoning', coerceText(payload.text))
      }))

    case 'reasoning.available':
      return patchLastAssistant(state, m => ({
        ...m,
        parts: applySettledReasoning(m.parts, coerceThinkingText(payload.text))
      }))
    // MoA fan-out progress. These arrive BEFORE any `moa.reference`: the loop
    // emits one `moa.progress` per reference as it completes, but only emits the
    // reference BODIES once the whole fan-out is done (agent/moa_loop.py). So
    // without this the chat sits on a bare spinner for the length of the slowest
    // reference — which, against the 900s `moa_reference` timeout, is a very
    // long time to show nothing at all.
    case 'moa.progress': {
      const done = numeric(payload.refs_done)
      const total = numeric(payload.refs_total)

      if (done === undefined || total === undefined) {
        return state
      }

      const label = coerceText(payload.label)
      const line = `◇ MoA refs ${done}/${total}${label ? ` — ${label}` : ''}\n`

      return patchLastAssistant(state, m => ({
        ...m,
        // The FIRST reference opens its own block rather than coalescing into
        // whatever reasoning the model was mid-way through; the rest of the
        // trail accumulates into that same block.
        parts:
          done <= 1 ? [...m.parts, { type: 'reasoning', text: line }] : appendStreamPart(m.parts, 'reasoning', line)
      }))
    }

    // Phase transition. Only `aggregator` is meaningful here — `phase:
    // "reference"` deliberately mirrors `moa.progress`, which is already
    // rendered above, so replaying it would double every line.
    //
    // Unlike desktop, the trail is NOT cleared when the references land:
    // desktop's reasoning is one accumulating buffer that `moa.reference`
    // replaces wholesale, while universal makes every burst its own block
    // (see the case below). Keeping the trail above the reference blocks is the
    // honest analogue — it reads as a record of the fan-out, not as leftovers.
    case 'moa.phase':
      return payload.phase === 'aggregator'
        ? patchLastAssistant(state, m => ({
            ...m,
            parts: appendStreamPart(m.parts, 'reasoning', '◇ MoA aggregating…\n')
          }))
        : state
    case 'moa.reference': {
      const label = coerceText(payload.label)
      // The counters are NUMBERS on a key called `count` (agent/moa_loop.py).
      // This used to read `payload.total` through `coerceText`, which returns ''
      // for anything non-string — so both halves were always blank and every
      // reference rendered its header as a bare "◇ Reference / — model". Drop
      // the fraction entirely when the gateway omits it, rather than printing an
      // empty one.
      const idx = numeric(payload.index)
      const count = numeric(payload.count)
      const position = idx !== undefined && count !== undefined ? ` ${idx}/${count}` : ''
      const header = `◇ Reference${position}${label ? ` — ${label}` : ''}\n`

      // A reference block is its own labelled thinking block — never merged into
      // the neighbouring one (desktop appends it as a settled burst too).
      return patchLastAssistant(state, m => ({
        ...m,
        parts: [...m.parts, { type: 'reasoning', text: header + coerceThinkingText(payload.text) }]
      }))
    }

    case 'tool.start':

    case 'tool.progress':

    case 'tool.generating':
      return applyToolEvent(state, payload as GatewayToolPayload, 'running')

    case 'tool.complete':
      return applyToolEvent(state, payload as GatewayToolPayload, 'complete')

    case 'message.complete':
      return {
        ...state,
        busy: false,
        turnStartedAt: null,
        statusLine: '',
        needsInput: false,
        // `text` is the turn's final_response; `rendered` is its ANSI/markdown
        // render (desktop reads the same pair).
        messages: applyCompletion(state.messages, (coerceText(payload.text) || coerceText(payload.rendered)).trim())
      }

    /**
     * The gateway's transient narration — `{kind, text}`, always: `_status_update`
     * in `tui_gateway/server.py` is the only builder, and every other
     * `_emit("status.update", …)` site hand-builds the same pair.
     *
     * This read `payload.status || payload.message`, neither of which the wire
     * carries (`message` is the ERROR event's key). Every status frame therefore
     * resolved to `''` — and because the case still assigns, each one WIPED the
     * line instead of leaving it alone. So universal's status surface
     * (`chat-screen.tsx`'s `busy && statusLine` row) was dead for its only
     * producer, which is most of why a compaction reads as a hang: the backend
     * narrates it in so many words — "🗜️ Compacting context — summarizing
     * earlier conversation so I can continue…"
     * (`agent/conversation_compression.py::COMPACTION_STATUS`, which the gateway
     * re-tags `kind:'compacting'`) — and the client threw the sentence away
     * (MJXHRM-357).
     */
    case 'status.update':
      return { ...state, statusLine: coerceText(payload.text) }

    case 'session.info':
      // Truthiness-gated (desktop parity): an empty cwd means "unknown", not
      // "detach the current one".
      return typeof payload.cwd === 'string' && payload.cwd ? { ...state, cwd: payload.cwd } : state
    /**
     * A clarify parks the agent in the backend's `_block` until
     * `clarify.respond` lands, and the inline ClarifyTool normally mounts from
     * the EARLIER `tool.start` row. When that row was missed — a stream
     * reconnect, a hydration race, a background session whose slice was created
     * by this very event — the sidebar said "needs input" and there was nowhere
     * to render the question, so the turn was unanswerable and hung forever.
     *
     * Upsert a stable pending clarify row from the request itself, keyed on the
     * REQUEST id. The ids deliberately do NOT line up: `tool.start` carries the
     * model's `tool_call_id`, this event the gateway's `request_id`, so the two
     * rows correlate on `question` instead — `tool.start` ships it as the
     * truncated `context` preview, and `lib/chat-tool-parts` matches on it. That
     * is what makes this an upsert in the normal path rather than a second live
     * card, and what lets the synthetic row settle on the real `tool.complete`.
     * Desktop does the same in `use-message-stream/gateway-event.ts`.
     */
    case 'clarify.request': {
      const requestId = coerceText(payload.request_id)
      const question = coerceText(payload.question)

      if (!requestId || !question) {
        return { ...state, needsInput: true }
      }

      // Raw strings only; the panel normalizes at the render boundary
      // (store/clarify.ts) and re-reads the store's copy in preference to these.
      const choices = Array.isArray(payload.choices)
        ? payload.choices.filter((choice): choice is string => typeof choice === 'string')
        : []

      return {
        ...state,
        needsInput: true,
        messages: patchActive(state.messages, m => ({
          ...m,
          parts: upsertToolPart(
            m.parts,
            { args: { choices, question }, name: 'clarify', tool_id: requestId },
            'running'
          )
        }))
      }
    }

    case 'approval.request':

    case 'sudo.request':

    case 'secret.request':
      return { ...state, needsInput: true }

    case 'error':
      return {
        ...state,
        busy: false,
        turnStartedAt: null,
        needsInput: false,
        statusLine: coerceText(payload.message) || 'Something went wrong',
        messages: state.messages.map(m =>
          m.pending ? { ...m, pending: false, error: coerceText(payload.message) } : m
        )
      }

    default:
      return state
  }
}
