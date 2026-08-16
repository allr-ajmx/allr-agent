import { useAuiState } from '@assistant-ui/react'
import { computed } from 'nanostores'
import { type FC, type ReactNode, useEffect, useMemo, useState } from 'react'

import { useSessionView } from '@/app/chat/session-view'
import { useElapsedSeconds } from '@/components/chat/activity-timer'
import { ActivityTimerText } from '@/components/chat/activity-timer-text'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import { sessionCompacting, sessionCompactingSince } from '@/store/compaction'
import { $sessionStates } from '@/store/session-state-types'

// Ported (lean) from apps/desktop/src/components/assistant-ui/thread/status.tsx.
//
// FLAG(chat-port): desktop's awaiting-input gate ($activeSessionAwaitingInput),
// its tool-drafting hint (sessionDraftingTool) and the CenteredThreadSpinner /
// BackgroundResumeNotice status rows are deferred — those stores/loader don't
// exist in universal yet. The turn timer no longer is: it reads `turnStartedAt`
// off the surface's own slice below.
const StatusRow: FC<{ children: ReactNode; label: string } & React.ComponentPropsWithoutRef<'div'>> = ({
  children,
  label,
  className,
  ...rest
}) => (
  <div
    aria-label={label}
    aria-live="polite"
    className={cn('flex max-w-full items-center gap-2 self-start text-sm text-muted-foreground/70', className)}
    role="status"
    {...rest}
  >
    {children}
  </div>
)

const HintText: FC<{ children: ReactNode }> = ({ children }) => (
  <span className="min-w-0 truncate text-sm text-muted-foreground/70">{children}</span>
)

/**
 * The status of the session THIS transcript renders.
 *
 * Read through the surface's own session view, never the active chat: a tile
 * must not show the main pane's compaction or its turn clock, and vice versa
 * (desktop's `useThreadSessionStatus` reads the same way).
 *
 * `since` is what the elapsed timer counts from. Without it these rows passed no
 * origin at all, and an anonymous timer counts from MOUNT — but the loading row
 * is rendered unconditionally by the thread list and merely returns null when
 * idle, so it is mounted for the life of the transcript. A prompt sent into a
 * chat that had been open ten minutes opened its "working" row at 10:00.
 */
function useThreadSessionStatus(): { compacting: boolean; since: number | undefined } {
  const sessionKey = useStore(useSessionView().$runtimeId)
  const compacting = useStore(useMemo(() => sessionCompacting(sessionKey), [sessionKey]))
  const compactingSince = useStore(useMemo(() => sessionCompactingSince(sessionKey), [sessionKey]))

  const turnStartedAt = useStore(
    useMemo(
      () => computed($sessionStates, states => (sessionKey ? states[sessionKey]?.turnStartedAt : null)),
      [sessionKey]
    )
  )

  // Compaction owns the whole wait, so it counts from when summarizing began —
  // which for a manual `/compress` is the only clock there is, the session
  // having no turn at all.
  return { compacting, since: (compacting ? compactingSince : null) ?? turnStartedAt ?? undefined }
}

// Pre-first-token "working" indicator (ported from desktop's
// ResponseLoadingIndicator). Rendered as the thread's `loadingIndicator` at the
// bottom of the list. Shows the pulsing square + elapsed timer from the moment
// the turn starts (sendPrompt sets $busy) until the assistant produces its first
// part — the empty running message renders null, so without this nothing signals
// that work is underway and it reads as "stopped". Once ANY content arrives the
// message body + its tail StreamStallIndicator take over, so this self-hides.
export const ResponseLoadingIndicator: FC = () => {
  const { t } = useI18n()
  const view = useSessionView()
  // The SURFACE's own session, not the global chat atoms. Reading `$busy` /
  // `$messages` straight from `store/chat` meant every tile rendered the MAIN
  // pane's working row — a pulsing spinner and a running clock on an idle chat
  // whenever the primary was busy, and nothing at all on a busy tile. It also
  // gated the compaction hint below on the wrong session's turn, so the hint
  // this component exists for could not appear in a tile at all (MJXHRM-357).
  const busy = useStore(view.$busy)
  const messages = useStore(view.$messages)
  const { compacting, since } = useThreadSessionStatus()

  const last = messages[messages.length - 1]
  const waiting = busy && (!last || last.role !== 'assistant' || last.parts.length === 0)
  // A compaction with a partial answer already on screen is narrated by the tail
  // StreamStallIndicator instead — that row sits with the text it interrupted.
  // Anything else compacting is this row's: notably a manual `/compress`, which
  // summarizes an IDLE session and so never sets `busy` at all. Without this the
  // command the ticket names as the way to trigger a compaction showed nothing.
  const visible = waiting || (compacting && !busy)

  const elapsed = useElapsedSeconds(visible, undefined, since)

  if (!visible) {
    return null
  }

  // Compaction is otherwise INVISIBLE: it emits no `message.start` of its own and
  // no output, so the transcript just sits there for the length of a summarize
  // call and reads as a hang (MJXHRM-357). Naming the wait is the whole fix.
  const hint = compacting ? t.assistant.thread.compacting : ''

  return (
    <StatusRow className="mt-1.5" data-slot="aui_response-loading" label={hint || t.assistant.thread.loadingResponse}>
      <span aria-hidden="true" className="dither inline-block size-3 rounded-[2px] text-midground/80 animate-pulse" />
      {hint && <HintText>{hint}</HintText>}
      <ActivityTimerText seconds={elapsed} />
    </StatusRow>
  )
}

// Seconds of no visible output (text or part count) before a still-running turn
// is treated as stalled and the thinking indicator returns at the tail.
const STREAM_STALL_S = 2

// Tail "still thinking" indicator: the pre-first-token spinner goes away once
// text flows, but if the stream then goes quiet mid-turn (tool think-time,
// provider stall) nothing signals that work continues. Watch a per-flush
// activity signal; when it hasn't changed for STREAM_STALL_S, re-show the
// dither + a timer counting from the last activity.
//
// Subscribes to the activity signal ITSELF (rather than taking it as a prop)
// so that per-token updates re-render only this leaf, not the whole
// AssistantMessage subtree.
export const StreamStallIndicator: FC = () => {
  const { t } = useI18n()
  const { compacting, since } = useThreadSessionStatus()

  const activity = useAuiState(s => {
    let textLength = 0

    for (const part of s.message.content) {
      const text = (part as { text?: unknown }).text

      if (typeof text === 'string') {
        textLength += text.length
      }
    }

    return `${s.message.content.length}:${textLength}`
  })

  // Timestamp of the activity that preceded the current quiet spell, set once
  // the spell qualifies as a stall. Holding the timestamp rather than a boolean
  // is what lets the timer read "quiet for 12s" instead of the age of this
  // component, which is the whole answer so far (desktop's `quietSince`).
  const [quietSince, setQuietSince] = useState<number | undefined>(undefined)

  useEffect(() => {
    setQuietSince(undefined)
    const seenAt = Date.now()
    const id = window.setTimeout(() => setQuietSince(seenAt), STREAM_STALL_S * 1000)

    return () => window.clearTimeout(id)
  }, [activity])

  // A compaction that starts mid-answer is the worst case for the 2s heuristic:
  // the stream has already produced text, so the pre-first-token indicator is
  // gone, and the summarize call can run far longer than the stall window. Show
  // the row immediately and NAME the wait rather than making the user infer it.
  const visible = quietSince !== undefined || compacting

  // Compaction owns the whole wait and counts from when summarizing began;
  // an ordinary stall counts from the moment the stream went quiet.
  const elapsed = useElapsedSeconds(visible, undefined, compacting ? since : quietSince)

  if (!visible) {
    return null
  }

  const hint = compacting ? t.assistant.thread.compacting : ''

  return (
    <StatusRow className="mt-1.5" data-slot="aui_stream-stall" label={hint || 'Hermes is thinking'}>
      <span aria-hidden="true" className="dither inline-block size-3 rounded-[2px] text-midground/80 animate-pulse" />
      {hint && <HintText>{hint}</HintText>}
      <ActivityTimerText seconds={elapsed} />
    </StatusRow>
  )
}
