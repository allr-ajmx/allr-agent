import type * as React from 'react'
import { useState } from 'react'

import { Codicon } from '@/components/ui/codicon'
import { DisclosureCaret } from '@/components/ui/disclosure-caret'
import { useI18n } from '@/i18n'
import { useStore } from '@/store/atom'
import { $sidebarWorkspaceCollapsedIds, toggleWorkspaceNodeCollapsed } from '@/store/layout'
import type { SessionInfo } from '@/types/hermes'

import {
  SidebarCount,
  SidebarRowCluster,
  SidebarRowLead,
  SidebarRowLink,
  SidebarRowShell,
  SidebarRowStack
} from './chrome'
import { SidebarLoadMoreRow } from './load-more-row'
import type { SidebarSessionGroup } from './projects/model'

// One per-profile lane in the "All profiles" browse view: a color-dot header with
// the profile name, its session count, a "+" that starts a chat in that profile,
// and the lane's rows. Adapted from desktop `projects/workspace-group.tsx`,
// narrowed to profile lanes (universal has no worktree/branch lanes here) and
// built from universal's `chrome.tsx` primitives, which have no WorkspaceHeader.
//
// Desktop's lane pager can fetch another server page per profile, driven by the
// aggregator's per-profile `hasMore`. Universal has no such truncation signal, so
// "show more" only reveals rows already loaded into the recents page — the global
// `$sessionsLimit` is what fetches more (see `store/session.ts`).

// Rows revealed per "show more" press.
const SIDEBAR_GROUP_PAGE = 10

interface SidebarProfileGroupProps {
  group: SidebarSessionGroup
  renderRows: (sessions: SessionInfo[]) => React.ReactNode
  /** Start a fresh session in this profile WITHOUT leaving the browse view. */
  onNewSession?: (profileKey: string) => void
}

export function SidebarProfileGroup({ group, onNewSession, renderRows }: SidebarProfileGroupProps) {
  const { t } = useI18n()
  const s = t.sidebar
  // Profile lanes default open; only ids the user explicitly collapsed persist.
  const collapsed = useStore($sidebarWorkspaceCollapsedIds).includes(group.id)
  const open = !collapsed
  const [visibleCount, setVisibleCount] = useState(SIDEBAR_GROUP_PAGE)

  const visibleSessions = group.sessions.slice(0, visibleCount)
  const hiddenCount = Math.max(0, group.sessions.length - visibleSessions.length)
  const nextCount = Math.min(SIDEBAR_GROUP_PAGE, hiddenCount)

  return (
    <SidebarRowStack>
      <SidebarRowShell
        actions={
          onNewSession && (
            <button
              aria-label={s.newSessionIn(group.label)}
              className="grid size-5 shrink-0 place-items-center rounded-sm text-(--ui-text-tertiary) opacity-0 transition hover:bg-(--ui-control-hover-background) hover:text-foreground group-hover:opacity-100"
              onClick={() => {
                // Reveal the lane the new session lands in.
                if (collapsed) {
                  toggleWorkspaceNodeCollapsed(group.id)
                }

                onNewSession(group.id)
              }}
              title={s.newSessionIn(group.label)}
              type="button"
            >
              <Codicon name="add" size="0.75rem" />
            </button>
          )
        }
        className="group row-hover"
      >
        <SidebarRowCluster>
          <SidebarRowLead>
            <span
              aria-hidden="true"
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: group.color ?? 'var(--ui-text-quaternary)' }}
            />
          </SidebarRowLead>
          <SidebarRowLink
            labelClassName="group-hover:text-foreground"
            onClick={() => toggleWorkspaceNodeCollapsed(group.id)}
          >
            {group.label}
          </SidebarRowLink>
          {group.sessions.length > 0 && <SidebarCount>{group.sessions.length}</SidebarCount>}
          <DisclosureCaret className="ml-auto shrink-0 text-(--ui-text-tertiary)" open={open} />
        </SidebarRowCluster>
      </SidebarRowShell>
      {open && (
        <>
          {visibleSessions.length === 0 ? (
            <div className="min-h-7 pl-2 text-[0.75rem] leading-7 text-(--ui-text-quaternary)">{s.noSessions}</div>
          ) : (
            renderRows(visibleSessions)
          )}
          {hiddenCount > 0 && (
            <SidebarLoadMoreRow onClick={() => setVisibleCount(count => count + SIDEBAR_GROUP_PAGE)} step={nextCount} />
          )}
        </>
      )}
    </SidebarRowStack>
  )
}
