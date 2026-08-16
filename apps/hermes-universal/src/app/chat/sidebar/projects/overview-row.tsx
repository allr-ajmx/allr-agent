import type * as React from 'react'
import { useState } from 'react'

import { Codicon } from '@/components/ui/codicon'
import { DisclosureCaret } from '@/components/ui/disclosure-caret'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import { $removedSessionIds, withoutTombstoned } from '@/store/session'
import type { SessionInfo } from '@/types/hermes'

import {
  SidebarCount,
  SidebarRowCluster,
  SidebarRowLead,
  SidebarRowLink,
  SidebarRowNest,
  SidebarRowShell
} from '../chrome'

import { latestProjectSessions, PROJECT_PREVIEW_COUNT, type SidebarProjectTree } from './model'
import { ProjectIcon } from './project-icon'
import { ProjectContextMenu, ProjectMenu } from './project-menu'

interface ProjectOverviewRowProps extends React.ComponentProps<'div'> {
  project: SidebarProjectTree
  activeProjectId?: null | string
  onEnter?: (id: string) => void
  renderRows: (sessions: SessionInfo[]) => React.ReactNode
  dragging?: boolean
  dragHandleProps?: React.HTMLAttributes<HTMLElement>
}

// A project row in the overview: icon/color dot + name + session count, a
// hover-revealed caret that expands its recent-session previews, and the project
// overflow menu. Clicking the label enters the project.
export function ProjectOverviewRow({
  project,
  activeProjectId,
  onEnter,
  renderRows,
  className,
  ref,
  ...rest
}: ProjectOverviewRowProps) {
  const [expanded, setExpanded] = useState(false)
  // Tombstoned rows are dropped here the way `entered-content` and
  // `workspace-group` already drop them (MJXHRM-414). The project tree is a
  // backend snapshot, so a session deleted a moment ago is still in it until the
  // next fetch — and this preview list was the one surface that never applied
  // the filter, so a deleted chat kept appearing under its project.
  //
  // The `useStore` is the subscription that makes the filter LIVE: without it
  // the row would keep its stale previews until something else re-rendered it.
  useStore($removedSessionIds)
  const previews = withoutTombstoned(latestProjectSessions(project, PROJECT_PREVIEW_COUNT))
  const isActive = Boolean(activeProjectId && project.id === activeProjectId && !project.isAuto)

  return (
    <div className={className} ref={ref} {...rest}>
      {/* Right-click the row for the same actions as its kebab. The wrapper sits
          inside this div (not around it) so the drag handle props above keep
          their own element. */}
      <ProjectContextMenu project={project}>
        <SidebarRowShell actions={<ProjectMenu project={project} />} className="group row-hover">
          <SidebarRowCluster>
            <SidebarRowLead>
              <ProjectIcon project={project} />
            </SidebarRowLead>
            <SidebarRowLink
              labelClassName={cn('group-hover:text-foreground', isActive && 'text-foreground')}
              onClick={() => onEnter?.(project.id)}
            >
              {project.label}
            </SidebarRowLink>
            {project.sessionCount > 0 && <SidebarCount>{project.sessionCount}</SidebarCount>}
            {previews.length > 0 && (
              <button
                // Not a decorative caret: the row's label navigates into the
                // project, so this button is the only way to peek at its
                // sessions in place.
                className="ms-auto grid size-4 shrink-0 place-items-center rounded-sm text-(--ui-text-tertiary) opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 coarse:opacity-100"
                onClick={() => setExpanded(v => !v)}
                type="button"
              >
                <DisclosureCaret open={expanded} />
              </button>
            )}
          </SidebarRowCluster>
        </SidebarRowShell>
      </ProjectContextMenu>
      {expanded && previews.length > 0 && <SidebarRowNest>{renderRows(previews)}</SidebarRowNest>}
    </div>
  )
}

export function ProjectBackRow({ label, onExit }: { label: string; onExit: () => void }) {
  const { t } = useI18n()

  return (
    <Tip label={t.sidebar.projects.back}>
      <button
        className="flex min-h-[1.625rem] w-full items-center gap-1.5 rounded-md ps-2 text-start text-[0.8125rem] text-(--ui-text-tertiary) opacity-70 transition hover:bg-(--ui-control-hover-background) hover:text-foreground hover:opacity-100"
        onClick={onExit}
        type="button"
      >
        <Codicon name="arrow-left" size="0.875rem" />
        <span className="min-w-0 truncate">{label}</span>
      </button>
    </Tip>
  )
}
