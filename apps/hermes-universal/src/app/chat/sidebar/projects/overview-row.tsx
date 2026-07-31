import type * as React from 'react'
import { useState } from 'react'

import { Codicon } from '@/components/ui/codicon'
import { DisclosureCaret } from '@/components/ui/disclosure-caret'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
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
import { ProjectMenu } from './project-menu'

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
  const previews = latestProjectSessions(project, PROJECT_PREVIEW_COUNT)
  const isActive = Boolean(activeProjectId && project.id === activeProjectId && !project.isAuto)

  return (
    <div className={className} ref={ref} {...rest}>
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
              className="ml-auto grid size-4 shrink-0 place-items-center rounded-sm text-(--ui-text-tertiary) opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
              onClick={() => setExpanded(v => !v)}
              type="button"
            >
              <DisclosureCaret open={expanded} />
            </button>
          )}
        </SidebarRowCluster>
      </SidebarRowShell>
      {expanded && previews.length > 0 && <SidebarRowNest>{renderRows(previews)}</SidebarRowNest>}
    </div>
  )
}

export function ProjectBackRow({ label, onExit }: { label: string; onExit: () => void }) {
  const { t } = useI18n()

  return (
    <Tip label={t.sidebar.projects.back}>
      <button
        className="flex min-h-[1.625rem] w-full items-center gap-1.5 rounded-md pl-2 text-left text-[0.8125rem] text-(--ui-text-tertiary) opacity-70 transition hover:bg-(--ui-control-hover-background) hover:text-foreground hover:opacity-100"
        onClick={onExit}
        type="button"
      >
        <Codicon name="arrow-left" size="0.875rem" />
        <span className="min-w-0 truncate">{label}</span>
      </button>
    </Tip>
  )
}
