import type { useSensors } from '@dnd-kit/core'
import type * as React from 'react'

import { SidebarPanelLabel } from '@/app/shell/sidebar-label'
import { DisclosureCaret } from '@/components/ui/disclosure-caret'
import { cn } from '@/lib/utils'
import { sessionPinId } from '@/store/session'
import type { SessionInfo } from '@/types/hermes'

import { SidebarCount } from './chrome'
import { EnteredProjectContent } from './projects/entered-content'
import type { SidebarProjectTree } from './projects/model'
import { ProjectOverviewRow } from './projects/overview-row'
import { ReorderableList, useSortableBindings } from './reorderable-list'
import { SidebarSessionSkeletons } from './section-states'
import { SidebarSessionRow } from './session-row'
import { VirtualSessionList } from './virtual-session-list'

// Section shell + header + flat-list render (ported/adapted from desktop
// `sessions-section.tsx`). Supports plain / drag-reorderable / virtualized (≥25)
// flat lists. Grouped + project-tree rendering land in Phase 6.

export const VIRTUALIZE_THRESHOLD = 25

interface SidebarSectionHeaderProps {
  label: string
  open: boolean
  onToggle: () => void
  action?: React.ReactNode
  meta?: React.ReactNode
  icon?: React.ReactNode
  collapsible?: boolean
}

function SidebarSectionHeader({
  label,
  open,
  onToggle,
  action,
  meta,
  icon,
  collapsible = true
}: SidebarSectionHeaderProps) {
  const labelBody = (
    <>
      {icon}
      <SidebarPanelLabel>{label}</SidebarPanelLabel>
      {meta != null && <SidebarCount>{meta}</SidebarCount>}
    </>
  )

  return (
    <div className="group/section flex shrink-0 items-center justify-between gap-1 pb-1 pt-1.5">
      {collapsible ? (
        <button
          className="group/section-label flex w-fit items-center gap-1 bg-transparent text-left leading-none"
          onClick={onToggle}
          type="button"
        >
          {labelBody}
          <DisclosureCaret
            className="text-(--ui-text-tertiary) opacity-0 transition group-hover/section-label:opacity-100"
            open={open}
          />
        </button>
      ) : (
        <div className="flex w-fit items-center gap-1 leading-none">{labelBody}</div>
      )}
      {action}
    </div>
  )
}

export interface SidebarSessionsSectionProps {
  label: string
  open: boolean
  onToggle: () => void
  sessions: SessionInfo[]
  activeSessionId: null | string
  workingSessionIdSet: Set<string>
  onResumeSession: (sessionId: string) => void
  onDeleteSession: (sessionId: string) => void
  onArchiveSession: (sessionId: string) => void
  onTogglePin: (pinId: string) => void
  pinned: boolean
  emptyState: React.ReactNode
  forceEmptyState?: boolean
  rootClassName?: string
  contentClassName?: string
  headerAction?: React.ReactNode
  footer?: React.ReactNode
  labelMeta?: React.ReactNode
  labelIcon?: React.ReactNode
  collapsible?: boolean
  sortable?: boolean
  onReorderSessions?: (ids: string[]) => void
  dndSensors?: ReturnType<typeof useSensors>
  // Project overview / entered-project rendering (takes precedence over the flat
  // session list when present).
  projectOverview?: SidebarProjectTree[]
  projectContent?: SidebarProjectTree | null
  projectsLoading?: boolean
  activeProjectId?: null | string
  onEnterProject?: (id: string) => void
  onReorderProjects?: (ids: string[]) => void
  projectBackRow?: React.ReactNode
}

export function SidebarSessionsSection(props: SidebarSessionsSectionProps) {
  const {
    label,
    open,
    onToggle,
    sessions,
    activeSessionId,
    workingSessionIdSet,
    onResumeSession,
    onDeleteSession,
    onArchiveSession,
    onTogglePin,
    pinned,
    emptyState,
    forceEmptyState = false,
    rootClassName,
    contentClassName,
    headerAction,
    footer,
    labelMeta,
    labelIcon,
    collapsible = true,
    sortable = false,
    onReorderSessions,
    dndSensors,
    projectOverview,
    projectContent,
    projectsLoading = false,
    activeProjectId,
    onEnterProject,
    onReorderProjects,
    projectBackRow
  } = props

  const sectionOpen = collapsible ? open : true
  const hasProjectOverview = Boolean(projectOverview?.length)
  const hasProjectContent = Boolean(projectContent && projectContent.sessionCount > 0)

  const showEmptyState =
    forceEmptyState || (!hasProjectOverview && !hasProjectContent && !projectContent && sessions.length === 0)

  const sessionsDraggable = sortable && !!onReorderSessions

  const flatVirtualized =
    !showEmptyState && !projectOverview?.length && !projectContent && sessions.length >= VIRTUALIZE_THRESHOLD

  const renderRow = (session: SessionInfo, draggable: boolean) => {
    const rowProps = {
      isPinned: pinned,
      isSelected: session.id === activeSessionId,
      isWorking: workingSessionIdSet.has(session.id),
      onArchive: () => onArchiveSession(session.id),
      onDelete: () => onDeleteSession(session.id),
      onPin: () => onTogglePin(sessionPinId(session)),
      onResume: () => onResumeSession(session.id),
      session
    }

    return draggable ? (
      <SortableSidebarSessionRow key={session.id} {...rowProps} />
    ) : (
      <SidebarSessionRow key={session.id} {...rowProps} />
    )
  }

  // Static (non-draggable) rows for project previews + entered-project sessions.
  const renderProjectRows = (items: SessionInfo[]) => items.map(session => renderRow(session, false))

  const showProjectsSkeleton = projectsLoading && !hasProjectOverview && !hasProjectContent && !projectContent

  let inner: React.ReactNode

  if (showProjectsSkeleton) {
    inner = <SidebarSessionSkeletons />
  } else if (projectContent) {
    inner = (
      <>
        {projectBackRow}
        {hasProjectContent ? (
          <EnteredProjectContent project={projectContent} renderRows={renderProjectRows} />
        ) : (
          emptyState
        )}
      </>
    )
  } else if (projectOverview?.length) {
    const projectsDraggable = projectOverview.length > 1 && !!onReorderProjects
    const Row = projectsDraggable ? SortableProjectOverviewRow : ProjectOverviewRow

    const rows = projectOverview.map(project => (
      <Row
        activeProjectId={activeProjectId}
        key={project.id}
        onEnter={onEnterProject}
        project={project}
        renderRows={renderProjectRows}
      />
    ))

    inner =
      projectsDraggable && onReorderProjects ? (
        <ReorderableList ids={projectOverview.map(p => p.id)} onReorder={onReorderProjects} sensors={dndSensors}>
          {rows}
        </ReorderableList>
      ) : (
        rows
      )
  } else if (showEmptyState) {
    inner = emptyState
  } else if (flatVirtualized) {
    const virtual = (
      <VirtualSessionList
        activeSessionId={activeSessionId}
        className={contentClassName}
        footer={footer}
        onArchiveSession={onArchiveSession}
        onDeleteSession={onDeleteSession}
        onResumeSession={onResumeSession}
        onTogglePin={onTogglePin}
        pinned={pinned}
        sessions={sessions}
        sortable={sessionsDraggable}
        workingSessionIdSet={workingSessionIdSet}
      />
    )

    inner =
      sessionsDraggable && onReorderSessions ? (
        <ReorderableList ids={sessions.map(s => s.id)} onReorder={onReorderSessions} sensors={dndSensors}>
          {virtual}
        </ReorderableList>
      ) : (
        virtual
      )
  } else if (sessionsDraggable && onReorderSessions) {
    inner = (
      <ReorderableList ids={sessions.map(s => s.id)} onReorder={onReorderSessions} sensors={dndSensors}>
        {sessions.map(session => renderRow(session, true))}
      </ReorderableList>
    )
  } else {
    inner = sessions.map(session => renderRow(session, false))
  }

  // The virtualizer owns its own scroller — suppress the wrapper's overflow so
  // there's no double scroll container.
  const resolvedContentClassName = cn(contentClassName, flatVirtualized && 'overflow-y-visible')

  return (
    <div className={cn('relative flex w-full min-w-0 flex-col', rootClassName)}>
      <SidebarSectionHeader
        action={headerAction}
        collapsible={collapsible}
        icon={labelIcon}
        label={label}
        meta={labelMeta}
        onToggle={onToggle}
        open={sectionOpen}
      />
      {sectionOpen && (
        <div className={resolvedContentClassName}>
          {inner}
          {/* Virtualized lists own their scroller, so the footer rides inside it
              (passed to VirtualSessionList) instead of being pinned below. */}
          {!flatVirtualized && footer}
        </div>
      )}
    </div>
  )
}

type SortableRowProps = {
  session: SessionInfo
  isPinned: boolean
  isSelected: boolean
  isWorking: boolean
  onArchive: () => void
  onDelete: () => void
  onPin: () => void
  onResume: () => void
}

function SortableSidebarSessionRow(props: SortableRowProps) {
  return <SidebarSessionRow {...props} {...useSortableBindings(props.session.id)} />
}

function SortableProjectOverviewRow(props: React.ComponentProps<typeof ProjectOverviewRow>) {
  return <ProjectOverviewRow {...props} {...useSortableBindings(props.project.id)} />
}
