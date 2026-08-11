import { ThreadPrimitive, useAuiEvent, useAuiState } from '@assistant-ui/react'
import {
  type ComponentProps,
  type CSSProperties,
  type FC,
  memo,
  type ReactNode,
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { useStickToBottom } from 'use-stick-to-bottom'

import { MessageRenderBoundary } from '@/components/assistant-ui/message-render-boundary'
import { resolveShowEarlierAction, useTranscriptWindow } from '@/components/assistant-ui/thread/transcript-window'
import { usePaneVisible } from '@/components/pane-shell/pane-visibility'
import { useI18n } from '@/i18n'
import { messagePaintWeight } from '@/lib/render-weight'
import { cn } from '@/lib/utils'
import { atom, useStore } from '@/store/atom'
import {
  onScrollToBottomRequest,
  onThreadEditClose,
  onThreadEditOpen,
  resetThreadScroll,
  setThreadAtBottom
} from '@/store/thread-scroll'

type ThreadMessageComponents = ComponentProps<typeof ThreadPrimitive.MessageByIndex>['components']

export type MessageGroup = { id: string; weight: number } & (
  { index: number; kind: 'standalone' } | { indices: number[]; kind: 'turn' }
)

// DOM is bounded by a render-cost budget, not a message/turn count. The
// currency is `messagePaintWeight`: what a turn actually MOUNTS, which is what
// the grouping decides rather than what the payload weighs. A settled run of
// twelve reads is one grey summary line, a thought is one collapsed
// disclosure, a hoisted `todo` is nothing — while a diff, an image card or a
// wall of markdown really does build DOM and is charged for it.
//
// Pricing by part count instead had the budget counting work that never
// mounts: one tool-heavy turn is dozens of parts that paint as a handful of
// one-line summaries, so a session spent the whole page in two or three turns
// and offered "Show earlier" over a screen and a half of transcript.
//
// "Show earlier" prepends another page; whole turns stay intact so the sticky
// human bubble never loses its turn. This is the long-session perf lever
// WITHOUT a virtualizer — pure rendering, never touches scrollTop, so it can't
// fight use-stick-to-bottom (the single scroll owner). What the DOM can hold is
// bounded above by the store window regardless (TRANSCRIPT_WINDOW_BUDGET), so
// this cannot admit more than one window's content.
const RENDER_BUDGET = 600

// Every transcript list that is actually on screen registers here (see the
// mount effect). The budget above is sized for ONE full-height pane; a grid
// split shows several at once, each a fraction of the screen — yet each was
// still mounting the full budget. Four visible panes meant 4x the mounted
// message fibers, and every streaming flush pays selector re-runs and React
// commit traversal over ALL of them. Sharing the budget keeps "screens of
// scrollback" constant instead of "turns per pane": a pane a quarter the height
// gets a quarter the page, floored at a quarter budget (MIN_VISIBLE_GROUPS
// still floors the turn count regardless of weight). Panes that already
// backfilled keep their mounted content when the count changes — the share only
// caps where NEW backfills stop.
//
// VISIBLE panes, not mounted ones (desktop counts mounts). Keep-alive leaves
// every ever-activated tab mounted, so counting mounts would divide a lone
// visible pane's page by the number of tabs behind it — a budget cut paid for
// fibers nobody is looking at.
const $visibleTranscriptPanes = atom(0)

// Never offer "Show earlier" over fewer turns than this, however heavy they
// are. A weight-only cut on a session of enormous turns put the button two
// turns from the bottom, where it reads as broken rather than as paging — the
// user has not been given enough transcript to have gone looking for more.
const MIN_VISIBLE_GROUPS = 8

// On session switch, paint a small budget first (enough for the bottom turn(s)
// the user actually sees after scroll-to-bottom), then bump to the full budget
// in a requestAnimationFrame — defers the heavy markdown+KaTeX render past the
// initial commit, so the switch feels instant. A viewport after
// scroll-to-bottom shows 1-2 normal turns ≈ 10-20 cost units; the transition
// backfill fills the rest interruptibly, so a smaller budget only changes how
// much work blocks the click-to-paint path.
const FIRST_PAINT_BUDGET = 20

// Units the backfill adds per committed step (see the backfill effect). ~8-15
// ordinary turns or 1-2 tool-heavy ones per frame — big enough to fill a page
// in ~10 frames, small enough that no single commit approaches a frame budget.
const BACKFILL_STEP = 60

interface ThreadMessageListProps {
  clampToComposer: boolean
  components: ThreadMessageComponents
  emptyPlaceholder?: ReactNode
  loadingIndicator?: ReactNode
  sessionKey?: string | null
}

// Group each user message with the assistant turn(s) that follow it so the
// human bubble can `position: sticky` against the scroller across its whole
// turn (see StickyHumanMessageContainer in user-message.tsx).
export function buildGroups(signature: string): MessageGroup[] {
  if (!signature) {
    return []
  }

  const messages = signature.split('\n').map(row => {
    const [index, id, role, weight] = row.split(':')

    return { id, index: Number(index), role, weight: Number(weight) || 1 }
  })

  const groups: MessageGroup[] = []

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]

    if (message.role !== 'user') {
      groups.push({ id: message.id, index: message.index, kind: 'standalone', weight: message.weight })

      continue
    }

    const indices = [message.index]
    let weight = message.weight

    while (i + 1 < messages.length && messages[i + 1].role !== 'user') {
      weight += messages[++i].weight
      indices.push(messages[i].index)
    }

    groups.push({ id: message.id, indices, kind: 'turn', weight })
  }

  return groups
}

// Walk turns newest-first, summing their render weights until the budget is
// met; everything before the first kept turn is hidden. `minVisible` turns are
// kept regardless of weight. Returns the index of that first visible group.
export function firstVisibleGroupIndex(groups: readonly MessageGroup[], budget: number, minVisible = 0): number {
  let firstVisible = groups.length

  for (let i = groups.length - 1, weight = 0; i >= 0; i--) {
    weight += groups[i].weight
    firstVisible = i

    if (weight >= budget) {
      break
    }
  }

  return Math.min(firstVisible, Math.max(0, groups.length - minVisible))
}

// LIVE-TAIL EXEMPTION (ported from desktop `list.tsx` — MJXHRM-45). The port of
// `content-visibility:auto` came across without desktop's gate, which is the
// half that keeps it CORRECT rather than merely fast.
//
// With `contain-intrinsic-size:auto` the browser only remembers a turn's size
// AFTER it has rendered. A turn that finishes streaming near the bottom may have
// had its smaller mid-stream size remembered; when it scrolls just off the top
// edge and gets skipped, it snaps back to that stale height and shifts content
// down. With `overflow-anchor:none` the viewport cannot self-correct, so the
// stick-to-bottom lock drifts and the view creeps up over older turns — the
// "long session eventually shows old responses" glitch.
//
// Keeping the newest turns always-rendered means a turn is only ever virtualized
// once its layout has settled at its final size (remembered == real, so skipping
// it changes no height). Off-screen OLDER turns still skip, so the whole point of
// the containment — a Radix overlay's whole-document style recalc staying at
// ~100-200ms instead of ~650-730ms on a long transcript — is preserved.
//
// Budgeted in render-cost units, not turns, because that is what the cost scales
// with (the same currency as the render budgets above). A turn-count tail defeats
// itself on agent transcripts: one tool-heavy turn is 50-200 units, so a 6-turn
// tail would exempt the entire visible transcript and nothing would virtualize.
//
// 40 units ≈ the 1-2 turns a viewport shows after scroll-to-bottom, doubled so a
// turn that grows mid-stream doesn't fall out of the tail as it settles.
export const LIVE_TAIL_PARTS = 40
/** Floor: always exempt this many turns however heavy, so a transcript of huge
 *  turns still keeps the streaming one unvirtualized. */
export const LIVE_TAIL_MIN_GROUPS = 2
/** Ceiling: never exempt more than this many turns however light, so a long
 *  transcript of tiny turns can't walk the tail back and virtualize less. */
export const LIVE_TAIL_MAX_GROUPS = 6

/**
 * Index of the newest group that still virtualizes — everything at or after it
 * is the live tail and stays rendered. Walks newest-first accumulating weight so
 * the tail covers a viewport's worth of CONTENT rather than a fixed number of
 * turns, clamped to [min, max] turns. Computed once per render, not per row.
 */
export function liveTailStart(
  groups: readonly MessageGroup[],
  tailWeight = LIVE_TAIL_PARTS,
  minGroups = LIVE_TAIL_MIN_GROUPS,
  maxGroups = LIVE_TAIL_MAX_GROUPS
): number {
  let weight = 0
  let start = groups.length

  for (let i = groups.length - 1; i >= 0; i--) {
    weight += groups[i]?.weight ?? 1
    start = i

    if (weight > tailWeight) {
      break
    }
  }

  const floor = Math.max(0, groups.length - minGroups)
  const ceiling = Math.max(0, groups.length - maxGroups)

  return Math.min(floor, Math.max(ceiling, start))
}

interface TurnRowProps {
  components: ThreadMessageComponents
  group: MessageGroup
  resetKey: string
  virtualized: boolean
}

// One turn (or standalone message) of the transcript. memo() is the point: the
// rows array below is REBUILT whenever the DOM budget's cut advances
// (hiddenCount changes its slice), and without per-row bail-out that rebuild
// re-rendered every mounted turn — markdown, code cards, tool blocks — in one
// synchronous frame. With memo, a rebuild re-renders only rows whose props
// changed: the dropped head row unmounts, the virtualization boundary rows flip
// their flag, and everything else bails on identical group/resetKey identity.
//
// content-visibility:auto (virtualized rows) — off-screen turns skip style
// recalc, layout, and paint. On a long transcript this is what keeps UNRELATED
// UI fast: any dialog/popover mount (Radix Presence reads getComputedStyle)
// forces a whole-document style recalc, measured ~650-730ms per open on a
// 1300-message session and ~100-200ms with this on. The same applies to any
// width change — toggling a sidebar re-lays-out every rendered turn, which on a
// KaTeX-heavy transcript (dozens-to-hundreds of inline-styled spans per
// equation) froze the window until this landed. contain-intrinsic-size keeps a
// placeholder height for never-rendered turns (auto: remembered real size once
// rendered), so scrollbar/anchoring stay stable. Sticky human bubbles are
// unaffected — their turn is rendered whenever any part of it intersects the
// viewport.
//
// The live tail (newest turns) is EXEMPT: virtualizing a turn whose final size
// hasn't been remembered yet snaps it to a stale height when it scrolls off,
// drifting stick-to-bottom up over old turns. See `liveTailStart`.
const TurnRow = memo(function TurnRow({ components, group, resetKey, virtualized }: TurnRowProps) {
  return (
    <div
      className={cn(
        'flex min-w-0 flex-col gap-(--conversation-turn-gap) pb-(--conversation-turn-gap)',
        virtualized && '[contain-intrinsic-size:auto_37.5rem] [content-visibility:auto]'
      )}
    >
      <MessageRenderBoundary resetKey={resetKey}>
        {group.kind === 'turn' ? (
          <div
            className="composer-human-ai-pair-container relative flex min-w-0 flex-col gap-(--conversation-turn-gap)"
            data-slot="aui_turn-pair"
          >
            {group.indices.map(index => (
              <ThreadPrimitive.MessageByIndex components={components} index={index} key={index} />
            ))}
          </div>
        ) : (
          <ThreadPrimitive.MessageByIndex components={components} index={group.index} />
        )}
      </MessageRenderBoundary>
    </div>
  )
})

const ThreadMessageListInner: FC<ThreadMessageListProps> = ({
  clampToComposer,
  components,
  emptyPlaceholder,
  loadingIndicator,
  sessionKey
}) => {
  // TWO signatures, deliberately split. The STRUCTURAL one (ids/roles/count)
  // changes only when messages are added/removed/swapped — it keys the error
  // boundaries and the row identity. The WEIGHT one ticks while a streaming
  // turn appends content and feeds only the render budget. Folding weights into
  // the structural key handed every boundary a new resetKey per appended part,
  // reconciling every turn's subtree on every tick.
  const messageSignature = useAuiState(s =>
    s.thread.messages.map((message, index) => `${index}:${message.id}:${message.role}`).join('\n')
  )

  const weightSignature = useAuiState(s =>
    s.thread.messages.map(message => messagePaintWeight(message.content)).join(',')
  )

  const { t } = useI18n()
  // Row structure is memoized on the STRUCTURAL signature only, so streaming
  // part-appends can't churn group identity. Weights fold in separately below.
  const groups = useMemo(() => buildGroups(messageSignature), [messageSignature])
  const renderEmpty = groups.length === 0 && Boolean(emptyPlaceholder)
  const { olderAvailable, expandWindow } = useTranscriptWindow()

  // use-stick-to-bottom owns scrollTop (single writer): follow while locked,
  // escape on user scroll-up, re-lock at bottom. Snap instantly, not spring — a
  // spring can't tell live-token growth from a session-switch bulk relayout, and
  // chasing the latter reads as the view scrolling to random spots before
  // settling. Its refs hang off our own DOM so the sticky human bubbles survive.
  const { scrollRef, contentRef, isAtBottom, scrollToBottom, stopScroll } = useStickToBottom({
    initial: 'instant',
    resize: 'instant'
  })

  // Only a pane that is actually painting claims a share — see
  // `$visibleTranscriptPanes`. An inactive keep-alive tab stays mounted with a
  // frozen transcript and must not shrink its neighbours' page.
  const paneVisible = usePaneVisible()

  useEffect(() => {
    if (!paneVisible) {
      return
    }

    $visibleTranscriptPanes.set($visibleTranscriptPanes.get() + 1)

    return () => $visibleTranscriptPanes.set($visibleTranscriptPanes.get() - 1)
  }, [paneVisible])

  const visiblePanes = useStore($visibleTranscriptPanes)
  // This pane's share of the render budget — see `$visibleTranscriptPanes`.
  const paneBudget = Math.max(Math.ceil(RENDER_BUDGET / Math.max(1, visiblePanes)), RENDER_BUDGET / 4)

  const [renderBudget, setRenderBudget] = useState(FIRST_PAINT_BUDGET)

  // Cut the budget during RENDER, not in the post-commit layout effect. An
  // effect-time cut is too late: React would first build the whole tree with
  // the full budget (up to 300 parts of markdown + syntax highlighting),
  // commit it, and only then re-render at the small budget. The render-phase
  // state adjustment restarts this component immediately — before any child
  // renders — so the heavy commit never happens.
  //
  // Two triggers, because the transcript swap arrives differently per path:
  // a WARM switch publishes sessionKey + messages in one commit (the key
  // branch), while a COLD switch changes sessionKey with an empty transcript
  // and the hydrated messages land hundreds of ms later under the SAME key
  // (the empty→non-empty branch).
  const hasGroups = groups.length > 0
  const [budgetSessionKey, setBudgetSessionKey] = useState(sessionKey)
  const [hadGroups, setHadGroups] = useState(hasGroups)

  if (budgetSessionKey !== sessionKey) {
    setBudgetSessionKey(sessionKey)
    setHadGroups(hasGroups)
    setRenderBudget(FIRST_PAINT_BUDGET)
  } else if (hadGroups !== hasGroups) {
    setHadGroups(hasGroups)

    if (hasGroups) {
      setRenderBudget(FIRST_PAINT_BUDGET)
    }
  }

  // Backfill from FIRST_PAINT_BUDGET to the full budget after the small
  // commit painted — as a TRANSITION, so the heavy markdown + KaTeX render of
  // the older turns is interruptible instead of one long synchronous commit
  // that freezes input right after the switch. "Show earlier" pages
  // (budget > paneBudget) never re-enter here.
  //
  // In BOUNDED STEPS, not one jump to the full budget. A transition render is
  // interruptible but its COMMIT is not, and one 20→600 step commits every
  // backfilled turn at once — measured upstream as a 780ms uninterruptible
  // frame when a session was revealed while other tiles streamed (the flushes
  // kept interrupting the transition, which finally landed whole, seconds
  // later, mid-stream). Each step commits at most BACKFILL_STEP units; the
  // effect re-arms off the committed budget, so steps pace one per frame.
  useEffect(() => {
    if (renderBudget >= paneBudget) {
      return
    }

    const rafId = requestAnimationFrame(() => {
      // Functional max, not a plain set: an urgent "Show earlier" click can
      // land between scheduling and committing this transition, and a plain
      // set would rebase over it and shrink the budget back down.
      startTransition(() => setRenderBudget(budget => Math.max(budget, Math.min(budget + BACKFILL_STEP, paneBudget))))
    })

    return () => cancelAnimationFrame(rafId)
  }, [paneBudget, renderBudget])

  // Weights fold into the BUDGET only. Group identity stays structural, so a
  // streaming append re-runs this cheap sum — not the row JSX. Settled content
  // hits messagePaintWeight's WeakMap.
  const weightedGroups = useMemo(() => {
    const weights = weightSignature.split(',').map(w => Number(w) || 1)

    return groups.map(group => ({
      ...group,
      weight:
        group.kind === 'turn'
          ? group.indices.reduce((sum, index) => sum + (weights[index] ?? 1), 0)
          : (weights[group.index] ?? 1)
    }))
  }, [groups, weightSignature])

  // The turn floor applies to a real page only. During the first-paint budget
  // the point is a small synchronous commit; forcing 8 turns into it would put
  // back exactly the freeze FIRST_PAINT_BUDGET exists to avoid, and the rAF
  // backfill a frame later fills them in anyway.
  const hiddenCount = firstVisibleGroupIndex(
    weightedGroups,
    renderBudget,
    renderBudget >= paneBudget ? MIN_VISIBLE_GROUPS : 0
  )

  // Memoized for IDENTITY, not to save the slice: `rows` below keys off this
  // array, and an inline slice handed it a fresh array every render — so the
  // moment a transcript outgrew the render budget (hiddenCount > 0), every
  // streamed token rebuilt every visible row's JSX and re-rendered the whole
  // mounted transcript. Under the budget the raw `groups` identity made the
  // memo hold; heavy sessions lost it exactly when they could least afford to.
  const visibleGroups = useMemo(() => (hiddenCount > 0 ? groups.slice(hiddenCount) : groups), [groups, hiddenCount])

  // Where the always-rendered live tail begins. Derived from the WEIGHTED groups
  // (render cost, not turn count) so the tail is a viewport's worth of content —
  // see `liveTailStart`. Computed once here rather than per row.
  const tailStart = useMemo(
    () => liveTailStart(hiddenCount > 0 ? weightedGroups.slice(hiddenCount) : weightedGroups),
    [hiddenCount, weightedGroups]
  )

  const restoreFromBottomRef = useRef<number | null>(null)

  useEffect(() => setThreadAtBottom(isAtBottom), [isAtBottom])
  useEffect(() => () => resetThreadScroll(), [])

  // Floating jump button (outside this subtree) → return to the bottom.
  useEffect(() => onScrollToBottomRequest(() => void scrollToBottom()), [scrollToBottom])

  const endEditHold = useCallback(() => {
    scrollRef.current?.removeAttribute('data-editing')
  }, [scrollRef])

  // Inline edit grows a sticky bubble. Escape before focus/layout so the
  // resize-follow can't snap scrollTop; native anchoring holds the viewport.
  // FLAG(chat-port): universal's stock runtime has no inline edit yet, so these
  // hold handlers register but never fire — kept so edit lights up once branching
  // lands (see thread-scroll.ts).
  const beginEditHold = useCallback(() => {
    const el = scrollRef.current

    if (!el) {
      return
    }

    endEditHold()
    stopScroll()
    el.setAttribute('data-editing', 'true')
  }, [endEditHold, scrollRef, stopScroll])

  useEffect(() => onThreadEditOpen(beginEditHold), [beginEditHold])
  useEffect(() => onThreadEditClose(endEditHold), [endEditHold])
  useEffect(() => () => endEditHold(), [endEditHold])
  // New run → snap to the latest turn.
  useAuiEvent('thread.runStart', () => void scrollToBottom())

  // Pin to bottom on mount + every session switch (messages swap in place on a
  // long-lived runtime, so sessionKey is the only signal). The swap is
  // multi-step and lays out over many frames; letting the library follow re-pins
  // every frame to a moving target — visible as ~10 scroll jumps. Instead:
  // quiet it, glue to the true bottom until the height holds steady, then hand
  // back locked. Live streaming afterward uses the normal resize follow. (The
  // render budget is cut during render above, not here — an effect-time cut
  // would commit the full tree first.)
  useLayoutEffect(() => {
    const el = scrollRef.current

    if (!el) {
      return
    }

    stopScroll()
    el.scrollTop = el.scrollHeight

    let frame = 0
    let stableFrames = 0
    let lastHeight = el.scrollHeight

    const settle = () => {
      const node = scrollRef.current

      if (!node) {
        return
      }

      const height = node.scrollHeight

      stableFrames = height === lastHeight ? stableFrames + 1 : 0
      lastHeight = height
      node.scrollTop = height

      // Most session switches are synchronous and stabilize within 2 frames;
      // a 90-frame ceiling only matters for slow async image loads. Cap at 15
      // frames to minimize the settle loop racing markdown paint on every switch.
      if (stableFrames >= 2 || ++frame > 15) {
        void scrollToBottom('instant')

        return
      }

      rafId = requestAnimationFrame(settle)
    }

    let rafId = requestAnimationFrame(settle)

    return () => cancelAnimationFrame(rafId)
  }, [scrollRef, scrollToBottom, sessionKey, stopScroll])

  // Prepend an older page while preserving the on-screen position. The user is
  // scrolled up (reading history) so the stick-to-bottom lock is escaped and
  // won't fight this manual restore.
  const showEarlier = useCallback(() => {
    const action = resolveShowEarlierAction(hiddenCount, olderAvailable)

    if (!action) {
      return
    }

    const el = scrollRef.current
    restoreFromBottomRef.current = el ? el.scrollHeight - el.scrollTop : null

    if (action === 'dom') {
      setRenderBudget(budget => budget + paneBudget)

      return
    }

    expandWindow()
  }, [expandWindow, hiddenCount, olderAvailable, paneBudget, scrollRef])

  useLayoutEffect(() => {
    const el = scrollRef.current

    if (el && restoreFromBottomRef.current != null) {
      el.scrollTop = el.scrollHeight - restoreFromBottomRef.current
      restoreFromBottomRef.current = null
    }
    // `messageSignature` is in the deps because a WINDOW expansion prepends
    // messages without changing the DOM budget — the anchor has to be re-applied
    // in the commit the taller tree lands in either way.
  }, [messageSignature, renderBudget, scrollRef])

  // The row array is memoized on the inputs the rows actually read. This
  // component re-renders on every isAtBottom flip — and use-stick-to-bottom
  // flips it from a ResizeObserver, so a pane/sash DRAG re-renders this list
  // per frame. Without the memo, the inline .map() rebuilt every row's JSX each
  // time, and rebuilt children re-render their whole subtree even when nothing
  // changed. With it, React bails out on element identity and a scroll flip
  // re-renders nothing below.
  const rows = useMemo(
    () =>
      visibleGroups.map((group, indexInVisible) => (
        <TurnRow
          components={components}
          group={group}
          key={group.id}
          resetKey={messageSignature}
          virtualized={indexInVisible < tailStart}
        />
      )),
    [components, messageSignature, tailStart, visibleGroups]
  )

  return (
    <div
      className="relative min-h-0 max-w-full overflow-hidden contain-[layout_paint]"
      style={{ height: clampToComposer ? 'var(--thread-viewport-height)' : '100%' } as CSSProperties}
    >
      <div
        className="size-full overflow-x-hidden overflow-y-auto overscroll-contain"
        data-following={isAtBottom ? 'true' : 'false'}
        data-slot="aui_thread-viewport"
        ref={scrollRef as React.RefCallback<HTMLDivElement>}
      >
        {renderEmpty ? (
          <div
            className="mx-auto grid h-full w-full max-w-(--composer-width) grid-rows-[minmax(0,1fr)_auto] min-w-0 gap-(--conversation-turn-gap) px-6 py-8"
            data-slot="aui_thread-content"
          >
            {emptyPlaceholder}
          </div>
        ) : (
          <div
            className="mx-auto flex w-full max-w-(--composer-width) min-w-0 flex-col px-6 pt-4"
            data-slot="aui_thread-content"
            ref={contentRef as React.RefCallback<HTMLDivElement>}
          >
            {(hiddenCount > 0 || olderAvailable) && (
              <button
                className="mx-auto mb-(--conversation-turn-gap) rounded-full border border-border/65 bg-(--composer-fill) px-3 py-1 text-xs text-muted-foreground hover:text-foreground"
                onClick={showEarlier}
                type="button"
              >
                {t.assistant.thread.showEarlier}
              </button>
            )}
            {rows}
            {loadingIndicator}
            {clampToComposer && (
              <div
                aria-hidden="true"
                className="shrink-0"
                data-slot="aui_composer-clearance"
                style={{ height: 'var(--thread-last-message-clearance)' }}
              />
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export const ThreadMessageList = memo(ThreadMessageListInner)
