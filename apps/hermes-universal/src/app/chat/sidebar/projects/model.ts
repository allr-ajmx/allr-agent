import type { SessionInfo } from '@/types/hermes'

// The render contract for the Projects overview + entered-project views. The
// backend (`projects.tree` / `projects.project_sessions`) computes membership
// authoritatively, so these are pure display types — ported (lean) from desktop
// `projects/workspace-groups.ts` + `projects/model.ts`. The git-worktree lane
// overlays are not ported yet (FIXME(MJX-107)) — the backend tree's lanes are
// rendered as-is. Desktop's overlay is a purely visual enhancer fed by a worktree
// listing, which `lib/desktop-git.ts` already provides over `/api/git/*`.

export const PROJECT_PREVIEW_COUNT = 3

export interface SidebarSessionGroup {
  id: string
  label: string
  path: null | string
  sessions: SessionInfo[]
  color?: null | string
  isMain?: boolean
  isHome?: boolean
  totalCount?: number
}

export interface SidebarWorkspaceTree {
  id: string
  label: string
  path: null | string
  groups: SidebarSessionGroup[]
  sessionCount: number
}

export interface SidebarProjectTree {
  id: string
  label: string
  path: null | string
  color?: null | string
  icon?: null | string
  archived?: boolean
  isAuto?: boolean
  isNoProject?: boolean
  repos: SidebarWorkspaceTree[]
  sessionCount: number
  lastActive?: number
  previewSessions?: SessionInfo[]
}

export const sessionRecency = (session: SessionInfo): number => session.last_active || session.started_at || 0

const projectSessions = (project: SidebarProjectTree): SessionInfo[] =>
  project.repos.flatMap(repo => repo.groups.flatMap(group => group.sessions))

export const projectTreeCwd = (project: SidebarProjectTree): null | string =>
  project.path || project.repos.find(repo => repo.path)?.path || null

const projectActivityTime = (project: SidebarProjectTree): number =>
  Math.max(
    project.lastActive ?? 0,
    projectSessions(project).reduce((m, s) => Math.max(m, sessionRecency(s)), 0)
  )

// The project's most-recent sessions for the overview preview: hydrated lanes
// when entered, else the backend-supplied previews.
export const latestProjectSessions = (project: SidebarProjectTree, limit: number): SessionInfo[] => {
  const loaded = projectSessions(project)
  const source = loaded.length ? loaded : (project.previewSessions ?? [])

  return [...source].sort((a, b) => sessionRecency(b) - sessionRecency(a)).slice(0, limit)
}

// Every session in an entered project, newest-first (flattened across repos/lanes).
export const flattenProjectSessions = (project: SidebarProjectTree): SessionInfo[] =>
  [...projectSessions(project)].sort((a, b) => sessionRecency(b) - sessionRecency(a))

// Overview order: the synthetic "No project" bucket last; the active explicit
// project first; explicit before auto; then by recency.
export function sortProjectsForOverview(
  projects: SidebarProjectTree[],
  activeProjectId: null | string
): SidebarProjectTree[] {
  return [...projects].sort((a, b) => {
    if (Boolean(a.isNoProject) !== Boolean(b.isNoProject)) {
      return a.isNoProject ? 1 : -1
    }

    const aActive = Boolean(activeProjectId && a.id === activeProjectId && !a.isAuto)
    const bActive = Boolean(activeProjectId && b.id === activeProjectId && !b.isAuto)

    if (aActive !== bActive) {
      return aActive ? -1 : 1
    }

    if (Boolean(a.isAuto) !== Boolean(b.isAuto)) {
      return a.isAuto ? 1 : -1
    }

    return projectActivityTime(b) - projectActivityTime(a)
  })
}
