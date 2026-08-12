import { useStore } from '@nanostores/react'
import type * as React from 'react'
import { useState } from 'react'

import { Codicon } from '@/components/ui/codicon'
import { useI18n } from '@/i18n'
import { useDisplayPath } from '@/store/display-home'
import { setWorkspaceNodeOpen } from '@/store/layout'
import { notifyError } from '@/store/notifications'
import { switchBranchInRepo } from '@/store/projects'
import { $removedSessionIds, withoutTombstoned } from '@/store/session'
import type { SessionInfo } from '@/types/hermes'

import { SidebarRowStack } from '../chrome'

import { SIDEBAR_GROUP_PAGE, type SidebarSessionGroup, useWorkspaceNodeOpen } from './model'
import {
  WorkspaceAddButton,
  WorkspaceContextMenu,
  WorkspaceHeader,
  WorkspaceMenu,
  WorkspaceShowMoreButton
} from './workspace-header'

// Ported from desktop, minus its profile-lane branch: desktop's all-profiles
// browse view (`mode: 'profile'` lanes with backend paging) has no universal
// equivalent, so lanes here only ever page within what's already loaded.

interface SidebarWorkspaceGroupProps {
  group: SidebarSessionGroup
  renderRows: (sessions: SessionInfo[]) => React.ReactNode
  onNewSession?: (path: null | string) => void
  // When set (linked worktree rows), shows a remove affordance that runs a real
  // `git worktree remove`.
  onRemove?: () => void
}

export function SidebarWorkspaceGroup({ group, renderRows, onNewSession, onRemove }: SidebarWorkspaceGroupProps) {
  const { t } = useI18n()
  const s = t.sidebar
  // The lane's rows come from the backend tree snapshot, which still lists a
  // session the user just deleted or archived until its next refresh — so the
  // optimistic tombstones evict it here too, keeping the lane and the flat
  // recents list in lockstep.
  useStore($removedSessionIds)
  const sessions = withoutTombstoned(group.sessions)
  // Empty worktree/branch lanes start collapsed — they only show a "No sessions
  // yet" placeholder, so defaulting them open just adds noise. Lanes that
  // already hold sessions default open.
  const defaultOpen = sessions.length > 0
  const [open, toggleOpen] = useWorkspaceNodeOpen(group.id, defaultOpen)
  const [visibleCount, setVisibleCount] = useState(SIDEBAR_GROUP_PAGE)
  // A lane path is a repo/worktree root on the GATEWAY's filesystem (MJXHRM-394).
  const displayPath = useDisplayPath()

  const visibleSessions = sessions.slice(0, visibleCount)
  const hiddenCount = Math.max(0, sessions.length - visibleSessions.length)
  const nextCount = Math.min(SIDEBAR_GROUP_PAGE, hiddenCount)

  // Leading glyph: a home mark for the repo's primary checkout (labeled by its
  // live branch), or a branch/kanban mark otherwise.
  const leadingIcon = group.color ? (
    <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ backgroundColor: group.color }} />
  ) : (
    <Codicon
      className="shrink-0 text-(--ui-text-tertiary)"
      name={group.isKanban ? 'checklist' : group.isHome ? 'home' : 'git-branch'}
      size="0.75rem"
    />
  )

  const handleNewSession = async () => {
    // Reveal the lane the new session targets — an empty worktree/branch lane
    // starts collapsed, so without this the session lands in a folder the user
    // can't see. Stable across the lane's default flipping open once populated.
    setWorkspaceNodeOpen(group.id, true)

    if (!onNewSession) {
      return
    }

    // Main-checkout lanes are branch-labeled views over the same repo root path.
    // Clicking "+" on `main` should open on `main`, not whatever branch the root
    // currently sits on, so explicitly switch first.
    if (group.isMain && group.path && group.label) {
      try {
        await switchBranchInRepo(group.path, group.label)
      } catch (err) {
        notifyError(err, t.statusStack.coding.switchFailed(group.label))

        return
      }
    }

    onNewSession(group.path)
  }

  return (
    <SidebarRowStack>
      <WorkspaceContextMenu onRemove={onRemove} path={group.path}>
        <WorkspaceHeader
          action={
            (onNewSession || onRemove) && (
              <div className="flex items-center">
                {onNewSession && (
                  <WorkspaceAddButton label={s.newSessionIn(group.label)} onClick={() => void handleNewSession()} />
                )}
                {onRemove && <WorkspaceMenu onRemove={onRemove} path={group.path} />}
              </div>
            )
          }
          icon={leadingIcon}
          label={group.label}
          onToggle={toggleOpen}
          open={open}
          title={group.path ? displayPath(group.path) : undefined}
        />
      </WorkspaceContextMenu>
      {open && (
        <>
          {visibleSessions.length === 0 ? (
            <div className="min-h-7 pl-2 text-[0.75rem] leading-7 text-(--ui-text-quaternary)">{s.noSessions}</div>
          ) : (
            renderRows(visibleSessions)
          )}
          {hiddenCount > 0 && (
            <WorkspaceShowMoreButton
              count={nextCount}
              label={group.label}
              onClick={() => setVisibleCount(count => count + SIDEBAR_GROUP_PAGE)}
            />
          )}
        </>
      )}
    </SidebarRowStack>
  )
}
