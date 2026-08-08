import type * as React from 'react'
import { useRef } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { type Translations, useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import { $attentionSessionIds } from '@/store/session'
import { canOpenSessionWindow, openSessionInNewWindow } from '@/store/windows'
import type { SessionInfo } from '@/types/hermes'

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

export function SidebarSessionRow({
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
  const needsInput = useStore($attentionSessionIds).includes(session.id)
  // Latched by the touch tap below, cleared on the next press, so a synthetic
  // click trailing the same gesture can't resume the session twice.
  const tapped = useRef(false)

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
            {!isWorking && (
              <span className="pointer-events-none absolute right-6 top-1/2 min-w-6 -translate-y-1/2 text-right text-[0.625rem] leading-none text-(--ui-text-tertiary) opacity-0 transition-opacity group-hover:opacity-100">
                {age}
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
          className={cn('z-0 group-hover:pr-12 coarse:pr-12', branchStem && 'pl-3.5')}
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
          onPointerDown={event => {
            tapped.current = false

            if ((event.target as HTMLElement).closest('[data-reorder-handle], [data-row-actions]')) {
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
        >
          {reorderable ? (
            <SidebarRowGrab
              ariaLabel={`${r.rename} ${title}`}
              dragging={dragging}
              dragHandleProps={dragHandleProps}
              leadClassName={needsInput ? 'overflow-visible' : undefined}
            >
              <SessionStatusDot
                branchStem={branchStem}
                className="transition-opacity group-hover/handle:opacity-0 group-focus-within/handle:opacity-0"
                session={session}
                storedSessionId={session.id}
              />
            </SidebarRowGrab>
          ) : (
            <SidebarRowLead className={needsInput ? 'overflow-visible' : 'overflow-hidden'}>
              <SessionStatusDot branchStem={branchStem} session={session} storedSessionId={session.id} />
            </SidebarRowLead>
          )}
          {showProfile && <ProfileTag profile={session.profile} />}
          <SidebarRowLabel className="flex-1 font-normal group-hover:text-foreground group-data-[working=true]:text-foreground/90">
            {title}
          </SidebarRowLabel>
        </SidebarRowBody>
      </SidebarRowShell>
    </SessionContextMenu>
  )
}
