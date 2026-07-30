import type * as React from 'react'

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

import { SidebarRowBody, SidebarRowGrab, SidebarRowLabel, SidebarRowLead, SidebarRowShell } from './chrome'
import { SessionActionsMenu, SessionContextMenu } from './session-actions-menu'

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
                className="size-5 rounded-[4px] bg-transparent text-transparent transition-colors duration-100 hover:bg-(--ui-control-active-background) hover:text-foreground focus-visible:bg-(--ui-control-active-background) focus-visible:text-foreground focus-visible:ring-0 data-[state=open]:bg-(--ui-control-active-background) data-[state=open]:text-foreground group-hover:text-(--ui-text-tertiary) [&_svg]:size-3.5!"
                size="icon"
                title={r.sessionActions}
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
        {isWorking && !needsInput && <span aria-hidden="true" className="arc-border" />}
        <SidebarRowBody
          className={cn('z-0 group-hover:pr-12', branchStem && 'pl-3.5')}
          onClick={event => {
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
            if ((event.target as HTMLElement).closest('[data-reorder-handle], [data-row-actions]')) {
              return
            }

            startSessionDrag({ id: session.id, profile: session.profile || 'default', title }, event)
          }}
        >
          {reorderable ? (
            <SidebarRowGrab
              ariaLabel={`${r.rename} ${title}`}
              dragging={dragging}
              dragHandleProps={dragHandleProps}
              leadClassName={needsInput ? 'overflow-visible' : undefined}
            >
              <SessionRowLeadDot
                branchStem={branchStem}
                className="transition-opacity group-hover/handle:opacity-0 group-focus-within/handle:opacity-0"
                isWorking={isWorking}
                needsInput={needsInput}
              />
            </SidebarRowGrab>
          ) : (
            <SidebarRowLead className={needsInput ? 'overflow-visible' : 'overflow-hidden'}>
              <SessionRowLeadDot branchStem={branchStem} isWorking={isWorking} needsInput={needsInput} />
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

function SessionRowLeadDot({
  branchStem,
  isWorking,
  needsInput = false,
  className
}: {
  branchStem?: string
  isWorking: boolean
  needsInput?: boolean
  className?: string
}) {
  return (
    <span className={cn('flex items-center gap-0.5', className)}>
      {branchStem ? (
        <span aria-hidden className="shrink-0 font-mono text-[0.625rem] leading-none text-(--ui-text-quaternary)">
          {branchStem}
        </span>
      ) : null}
      <SidebarRowDot isWorking={isWorking} needsInput={needsInput} />
    </span>
  )
}

function SidebarRowDot({
  isWorking,
  needsInput = false,
  className
}: {
  isWorking: boolean
  needsInput?: boolean
  className?: string
}) {
  const { t } = useI18n()
  const r = t.sidebar.row

  if (needsInput) {
    return (
      <span
        aria-label={r.needsInput}
        className={cn('quest-glow relative size-1.5 rounded-full bg-amber-500', className)}
        role="status"
        title={r.waitingForAnswer}
      />
    )
  }

  return (
    <span
      aria-label={isWorking ? r.sessionRunning : undefined}
      className={cn(
        'rounded-full',
        isWorking
          ? "relative size-1.5 bg-(--ui-accent) shadow-[0_0_0.625rem_color-mix(in_srgb,var(--ui-accent)_55%,transparent)] before:absolute before:inset-0 before:animate-ping before:rounded-full before:bg-(--ui-accent) before:opacity-70 before:content-['']"
          : 'size-1 bg-(--ui-text-quaternary) opacity-80',
        className
      )}
      role={isWorking ? 'status' : undefined}
    />
  )
}
