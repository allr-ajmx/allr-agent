import { useStore } from '@nanostores/react'

import { type Translations, useI18n } from '@/i18n'
import { useStoreSelector } from '@/lib/use-session-slice'
import { cn } from '@/lib/utils'
import { $attentionSessionIds, $unreadFinishedSessionIds, $workingSessionIds, sessionAliasIds } from '@/store/session'
import { $sessionColorById, sessionColorFor } from '@/store/session-color'
import { $stalledSessionIds } from '@/store/session-states'
import type { SessionInfo } from '@/types/hermes'

import { type SessionDotState, sessionDotState } from './sidebar/session-row-state'

// A pure lookup table: each state maps to its className, aria-label, and title.
// No priority resolution here — sessionDotState already picked one. Label/title
// resolve from sidebar.row translations, keyed by name.
type DotVariant = {
  ariaLabel?: (r: Translations['sidebar']['row']) => string
  className: string
  role?: 'status'
  title?: (r: Translations['sidebar']['row']) => string
}

// Shared base for every active dot; idle is smaller and uses its own class.
const DOT_BASE = 'size-1.5 rounded-full'

// Three colors and one fill/hollow axis, none of it moving. Motion on a 6px
// circle can only say "something is happening" — which the row's arc already
// says, better — while costing a repaint per frame on every row at once. What
// the dot is for is telling states APART, and that is a job for color and fill:
// filled means producing, hollow means open but quiet.
const DOT_VARIANTS: Record<SessionDotState, DotVariant> = {
  // Yellow — a clarify/approval is blocking the turn. The one "act now" color,
  // and the only state the user is required to do something about.
  'needs-input': {
    ariaLabel: r => r.needsInput,
    className: `${DOT_BASE} bg-(--ui-yellow)`,
    role: 'status',
    title: r => r.waitingForAnswer
  },
  // Accent — the turn is running. The row's arc carries the motion.
  working: {
    ariaLabel: r => r.sessionRunning,
    className: `${DOT_BASE} bg-(--ui-accent)`,
    role: 'status'
  },
  // Hollow accent — still authoritatively running, but nothing has arrived for
  // the watchdog window. Same color as working because it IS working; hollow
  // because nothing is coming out of it right now.
  stalled: {
    ariaLabel: r => r.sessionRunning,
    className: `${DOT_BASE} border border-(--ui-accent)`,
    role: 'status',
    title: r => r.sessionRunning
  },
  // Green — the turn finished while the user was looking elsewhere.
  unread: {
    ariaLabel: r => r.finishedUnread,
    className: `${DOT_BASE} bg-(--ui-green)`,
    role: 'status',
    title: r => r.finishedUnread
  },
  // Hollow grey, the faintest ink the app has — nothing has ever run here. An
  // outline says "open, not producing"; a draft is the one state that has yet to
  // do anything at all, so it sits a shade dimmer than any live outline would.
  draft: {
    ariaLabel: r => r.draftSession,
    className: `${DOT_BASE} border border-(--ui-text-quaternary)`,
    title: r => r.draftSession
  },
  // Settled: the project color, or nothing at all. An uncolored session used to
  // get a grey dot, which put a mark of the same weight as a status next to
  // every resting row and made "no color" look like a state of its own.
  idle: {
    className: 'size-1 rounded-full'
  }
}

/** The dot a state paints, for surfaces that DESCRIBE a status rather than
 *  render a session — the sidebar's status filter, say. Idle carries no color of
 *  its own (it inherits the project's), so callers supply one. */
export const sessionDotClassName = (state: SessionDotState): string => DOT_VARIANTS[state].className

export interface SessionStatusDotProps {
  /** The STORED session id — the key every live-state atom (working /
   *  attention / stalled / unread) is keyed by, on BOTH surfaces: the sidebar
   *  row's `session.id` and a pane tile's `storedSessionId` are the same stored
   *  id (`$workingSessionIds` et al. map `storedSessionId`). It may be a
   *  PRE-ROTATION id — a tile or bubble opened before an auto-compression keeps
   *  the one it was created with — which is why the lookups below go through
   *  `sessionAliasIds` rather than this value alone.
   *
   *  Null on a chat that has yet to reach the backend — the workspace tab on a
   *  fresh draft, a draft tile. There is no id to key by and no turn behind it,
   *  which is the draft state by definition. */
  storedSessionId: null | string
  /** The session row for color resolution — recents OR the project tree. Call
   *  sites already hold it; passing it lets the idle dot inherit the project
   *  color even for a session older than the paginated recents page (which has
   *  no `$sessionColorById` entry). */
  session?: null | SessionInfo
  /** TUI-style tree stem for a branched session (`└─ ` / `├─ `). */
  branchStem?: string
  /** Applied to the OUTER wrapper (stem + dot) — e.g. hover-fade on the
   *  reorder handle. */
  className?: string
}

/**
 * SESSION STATUS DOT — the ONE primitive the sidebar row, the PANE TABS (the
 * main workspace tab and every session tile's tab, via `TileChrome.tabLead`),
 * the ⌃Tab switcher and the mobile bubble strip render, so a session's status
 * and color can never disagree between surfaces. Before MJXHRM-385 the switcher
 * and the bubble strip each hand-rolled their own dot, and the bubble's used
 * AMBER for a running turn and RED for an unread one — the amber this component
 * reserves for "needs your input", and a colour nothing else used at all.
 * It reads every signal itself from the shared stores keyed by the stored
 * session id: live state (working / needs-input / stalled / unread, made
 * mutually exclusive by `sessionDotState`) and the resolved color (override →
 * project color, via `sessionColorFor`). An idle session shows its project
 * color; the active states own the dot with their semantic color so an
 * attention cue is never masked by the inherited tint.
 *
 * Ported from desktop `app/chat/session-status-dot.tsx`.
 */
export function SessionStatusDot({ storedSessionId, session, branchStem, className }: SessionStatusDotProps) {
  const { t } = useI18n()
  const r = t.sidebar.row

  // Subscribe to the shared color map for reactivity; sessionColorFor falls
  // back to the resolver for a session outside the recents page.
  useStore($sessionColorById)
  const color = sessionColorFor(session) ?? null

  // EVERY id that names this conversation, not just the one the caller holds.
  // Auto-compression rotates a session's stored id and universal deliberately
  // leaves tiles / bubbles / pane ids on the pre-rotation one; the live-status
  // collections are keyed by the slice's current id, so asking under a single
  // id painted a tab or a bubble `idle` straight through a running turn (and
  // lost needs-input and unread with it). Cheap — at most three ids, resolved
  // from the row this dot already holds for its colour.
  const aliases = sessionAliasIds(storedSessionId, session)

  // Per-session membership as booleans via useStoreSelector: these collections
  // tick on every stream delta (any session working/stalled/etc changes the
  // reference), but a given dot only repaints when ITS OWN membership flips.
  // A plain useStore(collection).has(id) re-rendered every dot on every tick.
  //
  // Note the shape split, unlike desktop: universal's $workingSessionIds
  // resolves to a Set, the other three to arrays.
  const needsInput = useStoreSelector($attentionSessionIds, ids => aliases.some(id => ids.includes(id)))
  const isWorking = useStoreSelector($workingSessionIds, ids => aliases.some(id => ids.has(id)))
  const isStalled = useStoreSelector($stalledSessionIds, ids => aliases.some(id => ids.includes(id)))
  const isUnread = useStoreSelector($unreadFinishedSessionIds, ids => aliases.some(id => ids.includes(id)))

  const dotState = sessionDotState({ isDraft: storedSessionId === null, isStalled, isUnread, isWorking, needsInput })
  const variant = DOT_VARIANTS[dotState]

  return (
    <span className={cn('flex items-center gap-0.5', className)}>
      {branchStem ? (
        <span aria-hidden className="shrink-0 font-mono text-[0.625rem] leading-none text-(--ui-text-quaternary)">
          {branchStem}
        </span>
      ) : null}
      {dotState === 'idle' ? (
        // Rendered even with no color to paint: an empty dot of the same size
        // keeps every row's title on one left edge, so a session finishing
        // can't shift the list under the pointer.
        <span aria-hidden="true" className={variant.className} style={color ? { backgroundColor: color } : undefined} />
      ) : (
        <span
          aria-label={variant.ariaLabel?.(r)}
          className={variant.className}
          role={variant.role}
          title={variant.title?.(r)}
        />
      )}
    </span>
  )
}
