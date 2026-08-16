import type * as React from 'react'
import { memo, useRef } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { type Translations, useI18n } from '@/i18n'
import { compactNumber } from '@/lib/format'
import { triggerHaptic } from '@/lib/haptics'
import { middleClickHandlers } from '@/lib/middle-click'
import { IS_MOBILE } from '@/lib/platform'
import { useStoreSelector } from '@/lib/use-session-slice'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import { addBubble } from '@/store/chat-bubbles'
import { $sidebarRowMeta } from '@/store/layout'
import { $pullRequestsByBranch, sessionPrKey } from '@/store/pull-requests'
import { $attentionSessionIds } from '@/store/session'
import { openSessionTile } from '@/store/session-states'
import { sessionCostUsd } from '@/store/sidebar-archive'
import { canOpenSessionWindow, openSessionInNewWindow } from '@/store/windows'
import type { SessionInfo } from '@/types/hermes'

import { PrTag } from '../pr-tag'
import { ProfileTag } from '../profile-tag'
import { startSessionDrag } from '../session-drag'
import { SessionStatusDot } from '../session-status-dot'

import { SidebarRowBody, SidebarRowGrab, SidebarRowLabel, SidebarRowLead, SidebarRowShell } from './chrome'
import { SessionActionsMenu, SessionContextMenu } from './session-actions-menu'
import { sessionShowsRunningArc } from './session-row-state'

// Ported/adapted from desktop `app/chat/sidebar/session-row.tsx`. ⇧⌘-click pops
// the conversation into a native window on desktop (MJX-104); drag-to-composer is
// dropped; the handoff-origin platform badge lands with Phase 7 (PlatformAvatar).

interface SidebarSessionRowProps extends React.ComponentProps<'div'> {
  session: SessionInfo
  /** TUI-style tree stem for branched sessions (`└─ ` / `├─ `). */
  branchStem?: string
  isPinned: boolean
  isSelected: boolean
  isWorking: boolean
  onArchive: () => void
  onDelete: () => void
  onPin: () => void
  onResume: () => void
  /** Owning-profile chip, shown only in the all-profiles browse scope. */
  showProfile?: boolean
  reorderable?: boolean
  dragging?: boolean
  dragHandleProps?: React.HTMLAttributes<HTMLElement>
}

const AGE_KEY = { day: 'ageDay', hour: 'ageHour', minute: 'ageMin' } as const

function formatAge(seconds: number, r: Translations['sidebar']['row']): string {
  const ms = Date.now() - (seconds < 1e12 ? seconds * 1000 : seconds)
  const minutes = Math.floor(ms / 60_000)

  if (minutes < 1) {
    return r.ageNow
  }

  if (minutes < 60) {
    return `${minutes}${r[AGE_KEY.minute]}`
  }

  const hours = Math.floor(minutes / 60)

  if (hours < 24) {
    return `${hours}${r[AGE_KEY.hour]}`
  }

  return `${Math.floor(hours / 24)}${r[AGE_KEY.day]}`
}

function sessionTitle(session: SessionInfo): string {
  // Fall back to the first-message preview before the generic "Untitled" (parity
  // with desktop `lib/chat-runtime` sessionTitle).
  return session.title?.trim() || session.preview?.trim() || 'Untitled'
}

function SidebarSessionRowImpl({
  session,
  branchStem,
  isPinned,
  isSelected,
  isWorking,
  onArchive,
  onDelete,
  onPin,
  onResume,
  showProfile = false,
  reorderable = false,
  dragging = false,
  dragHandleProps,
  className,
  style,
  ref,
  ...rest
}: SidebarSessionRowProps) {
  const { t } = useI18n()
  const r = t.sidebar.row
  const title = sessionTitle(session)
  const age = formatAge(session.last_active || session.started_at, r)
  // Selector, not `useStore(...).includes(...)`: the attention array's reference
  // changes whenever ANY session starts or stops waiting on an answer, which
  // re-rendered every row in the sidebar for one row's state.
  const needsInput = useStoreSelector($attentionSessionIds, ids => ids.includes(session.id))
  // The session's PR. A selector, not a plain useStore: a repo's PRs land as a
  // single map write, and only the rows on those branches should repaint.
  const prKey = sessionPrKey(session)
  const pr = useStoreSelector($pullRequestsByBranch, prs => (prKey ? prs[prKey] : undefined))
  // The filter menu's "Show" submenu. Purely ADDITIVE here: it pins the age
  // that is otherwise hover-only and adds two chips the row has never had — it
  // can never take away the PR or profile chips, which universal renders by
  // their own rules (see `SidebarRowMeta` in store/layout).
  const rowMeta = useStore($sidebarRowMeta)
  const pinnedAge = rowMeta.includes('updated')
  const totalTokens = session.input_tokens + session.output_tokens
  const cost = sessionCostUsd(session)

  // Tokens, cost and age share the ONE trailing slot rather than each claiming
  // its own column, so switching two on doesn't squeeze the title.
  const meta = [
    rowMeta.includes('tokens') && totalTokens > 0 ? compactNumber(totalTokens) : null,
    // Below a cent every row reads "$0.00", which says nothing.
    rowMeta.includes('cost') && cost >= 0.01 ? `$${cost.toFixed(2)}` : null,
    pinnedAge ? age : null
  ]
    .filter(Boolean)
    .join(' · ')

  // Latched by the touch tap below, cleared on the next press, so a synthetic
  // click trailing the same gesture can't resume the session twice.
  const tapped = useRef(false)

  // Split across the row's own pointer handlers rather than spread, because the
  // press handler has to run the drag decision after arming the gesture.
  const middle = middleClickHandlers(() => {
    void triggerHaptic('selection')

    if (IS_MOBILE) {
      addBubble(session.id)
    } else {
      openSessionTile(session.id, 'right')
    }
  })

  return (
    <SessionContextMenu
      onArchive={onArchive}
      onDelete={onDelete}
      onPin={onPin}
      pinned={isPinned}
      sessionId={session.id}
      title={title}
    >
      <SidebarRowShell
        actions={
          <div className="relative z-2 grid w-[1.375rem] place-items-center">
            {/* Switched-on metadata stays put; the bare age is hover-only, so a
                resting sidebar is titles and nothing else. A running row hides
                the hover age (the arc already owns that space) but keeps any
                metadata the user explicitly asked for. */}
            {(meta ? true : !isWorking) && (
              <span
                className={cn(
                  'pointer-events-none absolute end-6 top-1/2 min-w-6 -translate-y-1/2 whitespace-nowrap text-end text-[0.625rem] leading-none text-(--ui-text-tertiary)',
                  !meta && 'opacity-0 transition-opacity group-hover:opacity-100'
                )}
              >
                {meta || age}
              </span>
            )}
            <SessionActionsMenu
              onArchive={onArchive}
              onDelete={onDelete}
              onPin={onPin}
              pinned={isPinned}
              sessionId={session.id}
              title={title}
            >
              <Button
                aria-label={r.actionsFor(title)}
                className="size-5 rounded-[4px] bg-transparent text-transparent transition-colors duration-100 hover:bg-(--ui-control-active-background) hover:text-foreground focus-visible:bg-(--ui-control-active-background) focus-visible:text-foreground focus-visible:ring-0 data-[state=open]:bg-(--ui-control-active-background) data-[state=open]:text-foreground group-hover:text-(--ui-text-tertiary) coarse:text-(--ui-text-tertiary) [&_svg]:size-3.5!"
                // No tip: this is a DropdownMenu trigger, and a tooltip on a
                // menu trigger fights the open menu (see DESIGN rule). The
                // aria-label above already names it for assistive tech.
                size="icon"
                variant="ghost"
              >
                <Codicon name="kebab-vertical" size="0.875rem" />
              </Button>
            </SessionActionsMenu>
          </div>
        }
        className={cn(
          'group row-hover relative',
          isSelected && 'bg-(--ui-row-active-background)',
          isWorking && 'text-foreground',
          dragging && 'z-10 cursor-grabbing bg-(--ui-sidebar-surface-background)',
          className
        )}
        data-working={isWorking ? 'true' : undefined}
        ref={ref}
        style={style}
        {...rest}
      >
        {sessionShowsRunningArc({ isWorking, needsInput }) && <span aria-hidden="true" className="arc-border" />}
        <SidebarRowBody
          // The kebab is permanently visible on touch, so the padding that
          // keeps the label out from under it has to be permanent too.
          className={cn('z-0 group-hover:pe-12 coarse:pe-12', branchStem && 'ps-3.5')}
          onClick={event => {
            // A finger already resumed this row from `onTap` below; whether the
            // engine also synthesizes a click is its business, not ours.
            if (tapped.current) {
              return
            }

            // ⇧⌘/⇧⌃-click pops the conversation into its own native window
            // (desktop only; MJX-104). ⇧-click alone still pins.
            if ((event.metaKey || event.ctrlKey) && event.shiftKey && canOpenSessionWindow()) {
              event.preventDefault()
              event.stopPropagation()
              void triggerHaptic('selection')
              void openSessionInNewWindow(session.id)

              return
            }

            if (event.shiftKey) {
              event.preventDefault()
              event.stopPropagation()
              void triggerHaptic('selection')
              onPin()

              return
            }

            onResume()
          }}
          // Drag this conversation into the workspace to tile it (stack on a tab
          // strip, split on an edge, or link into a composer). A sub-threshold
          // release stays a plain click (onClick above), so click-to-open and
          // shift-to-pin are untouched. The reorder grab keeps its own dnd-kit gesture.
          onMouseDown={middle.onMouseDown}
          // Middle-click opens the conversation in its own TILE — browser
          // muscle memory ("open in a new tab"), and the gesture form of the
          // row menu's "Open in tile". NOT close: a sidebar row is a session,
          // not a tab, and there is nothing there to close. Through
          // `middleClickHandlers` because the session list is a scroller, where
          // `auxclick` is eaten by the autoscroll pan on Windows and Linux.
          onPointerDown={event => {
            tapped.current = false

            // The reorder grab sits INSIDE this button and runs its own dnd-kit
            // gesture, so a press on it must arm neither the middle-click nor
            // the session drag. The kebab needs no such guard: it is a grid
            // SIBLING of the row body (`SidebarRowShell`), so its presses never
            // reach here at all — the `[data-row-actions]` half of this check
            // named an attribute nothing in the app has ever set.
            if ((event.target as HTMLElement).closest('[data-reorder-handle]')) {
              return
            }

            middle.onPointerDown(event)

            // The session drag is a PRIMARY-button gesture; arming it on a
            // middle press would leave a drag session live with no button to
            // end it.
            if (event.button !== 0) {
              return
            }

            startSessionDrag(
              { id: session.id, profile: session.profile || 'default', title },
              event,
              // Touch only. A finger's `click` is a verdict the engine reaches
              // after ruling out a scroll and a drag; the session drag already
              // knows this release was neither, so resume from that rather than
              // waiting to see whether a click shows up. A mouse keeps its
              // native click — modifiers live there.
              event.pointerType === 'mouse'
                ? undefined
                : {
                    onTap: () => {
                      tapped.current = true
                      onResume()
                    }
                  }
            )
          }}
          onPointerUp={middle.onPointerUp}
        >
          {reorderable ? (
            <SidebarRowGrab ariaLabel={`${r.rename} ${title}`} dragging={dragging} dragHandleProps={dragHandleProps}>
              <SessionStatusDot
                branchStem={branchStem}
                className="transition-opacity group-hover/handle:opacity-0 group-focus-within/handle:opacity-0"
                session={session}
                storedSessionId={session.id}
              />
            </SidebarRowGrab>
          ) : (
            <SidebarRowLead className="overflow-hidden">
              <SessionStatusDot branchStem={branchStem} session={session} storedSessionId={session.id} />
            </SidebarRowLead>
          )}
          {showProfile && <ProfileTag profile={session.profile} />}
          <SidebarRowLabel className="flex-1 font-normal group-hover:text-foreground group-data-[working=true]:text-foreground/90">
            {title}
          </SidebarRowLabel>
          {/* Stays put on hover, unlike the other chips: it's a link, and the
              kebab lives in its own column rather than over this one. */}
          {pr && <PrTag pr={pr} />}
        </SidebarRowBody>
      </SidebarRowShell>
    </SessionContextMenu>
  )
}

/** Shallow-compares the two props that arrive as fresh objects from the sortable
 *  bindings. dnd-kit memoizes the attributes and listeners inside them, so their
 *  VALUES are stable even though the wrapper object is rebuilt each render.
 *
 *  That stability is CONDITIONAL, and it was false here until MJXHRM-383: the
 *  synthetic `listeners` are memoized on the sensor array, which is memoized on
 *  the option objects the list hands `useSensor`. `reorderable-list.tsx` built
 *  those as literals inside its render, so `onPointerDown` was a new function
 *  every render and this comparator reported `dragHandleProps` unequal every
 *  time — no row in the sortable path (Recents, Pinned) ever bailed out. The
 *  options are module-level now; a per-render sensor option silently kills it
 *  again. */
function shallowEqual(a: object | undefined, b: object | undefined): boolean {
  if (a === b) {
    return true
  }

  if (!a || !b) {
    return false
  }

  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)

  return keys.length === Object.keys(right).length && keys.every(key => Object.is(left[key], right[key]))
}

/**
 * Deliberately ignored: `onArchive`/`onDelete`/`onPin`/`onResume` (desktop's
 * `rowPropsEqual` makes the same call). `sessions-section` builds those as fresh
 * closures for every row on every render — comparing them would mean no row ever
 * bails out, which is the whole point of the boundary. They close over nothing
 * but the session id, which `session` already covers.
 */
const IGNORED_ROW_PROPS: ReadonlySet<string> = new Set(['onArchive', 'onDelete', 'onPin', 'onResume'])

/** Props that arrive as a fresh WRAPPER around stable members (dnd-kit). */
const SHALLOW_ROW_PROPS: ReadonlySet<string> = new Set(['dragHandleProps', 'style'])

/**
 * WALKS THE PROPS rather than naming them (MJXHRM-45). The hand-written list it
 * replaces compared 12 named props — and `SidebarSessionRowProps` extends
 * `React.ComponentProps<'div'>`, so a caller can pass anything a div takes and
 * the comparator would silently claim equality.
 *
 * That was not hypothetical: `virtual-session-list.tsx` passes
 * `data-index={virtualItem.index}`, which TanStack Virtual reads back off the
 * DOM node in `measureElement` (`indexAttribute`, default `data-index`) to
 * decide WHICH row a ResizeObserver measurement belongs to. Reordering the list
 * — a drag-reorder of pins, a search narrowing, a session moving on activity —
 * changes a row's index while its `session` object stays identical, so the memo
 * bailed and left a stale `data-index` in the DOM. The next measurement was then
 * filed against the wrong row, corrupting the virtualizer's size cache: wrong
 * offsets, wrong top/bottom padding, jumpy scrolling.
 *
 * A key walk cannot regress that way. Anything added to the row's props is
 * compared by default; opting out is an explicit entry in the sets above.
 */
function rowPropsEqual(a: SidebarSessionRowProps, b: SidebarSessionRowProps): boolean {
  const left = a as unknown as Record<string, unknown>
  const right = b as unknown as Record<string, unknown>
  const keys = Object.keys(left)

  if (keys.length !== Object.keys(right).length) {
    return false
  }

  return keys.every(key => {
    if (IGNORED_ROW_PROPS.has(key)) {
      return true
    }

    if (SHALLOW_ROW_PROPS.has(key)) {
      return shallowEqual(left[key] as object | undefined, right[key] as object | undefined)
    }

    return Object.is(left[key], right[key])
  })
}

export const SidebarSessionRow = memo(SidebarSessionRowImpl, rowPropsEqual)
