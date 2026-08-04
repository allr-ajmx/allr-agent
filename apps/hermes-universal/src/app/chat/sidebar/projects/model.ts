import { useStore } from '@nanostores/react'
import { useEffect, useMemo, useState } from 'react'

import type { HermesGitWorktree } from '@/global'
import { desktopGit } from '@/lib/desktop-git'
import { mapPool } from '@/lib/pool'
import { $sidebarWorkspaceNodeOpen, toggleWorkspaceNodeCollapsed } from '@/store/layout'
import { $worktreeRefreshToken } from '@/store/projects'
import type { SessionInfo } from '@/types/hermes'

// The render contract for the Projects overview + entered-project views. The
// backend (`projects.tree` / `projects.project_sessions`) computes membership
// authoritatively, so these are pure display types — ported from desktop
// `projects/workspace-groups.ts` + `projects/model.ts`. The visual-only
// git-worktree lane enhancer that consumes them lives in `./workspace-groups`.

export const PROJECT_PREVIEW_COUNT = 3

/** Rows shown per lane before the "show more" affordance. */
export const SIDEBAR_GROUP_PAGE = 5

export interface SidebarSessionGroup {
  id: string
  label: string
  path: null | string
  sessions: SessionInfo[]
  color?: null | string
  /** True when this group is a repo's main checkout (vs a linked worktree). */
  isMain?: boolean
  // True for the repo's primary ("home") checkout lane — the single lane that
  // collapses all main-checkout sessions, labeled by the worktree's LIVE branch
  // (defaulting to `main`). Renders a home glyph and pins to the top.
  isHome?: boolean
  // True for the synthetic lane that collapses all of a repo's kanban task
  // worktrees (`<repo>/.worktrees/t_*`) into one row, so a heavy board doesn't
  // spray hundreds of throwaway branch lanes across the sidebar.
  isKanban?: boolean
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

// Max concurrent `git worktree list` probes when a project spans many repos.
const WORKTREE_PROBE_CONCURRENCY = 4

const pathListKey = (paths: string[]): string =>
  paths
    .map(path => path.trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))
    .join('\n')

// Project drill-in lanes are git-driven: source them from `git worktree list` so
// linked worktrees still appear even when their sessions aren't in the recents
// payload currently loaded in memory.
export function useRepoWorktreeMap(
  repoPaths: string[],
  enabled: boolean
): [Record<string, HermesGitWorktree[]>, boolean] {
  const [map, setMap] = useState<Record<string, HermesGitWorktree[]>>({})
  const [loading, setLoading] = useState(false)
  const key = useMemo(() => pathListKey(repoPaths), [repoPaths])
  // Refetch when a worktree is added/removed so a new lane shows immediately.
  const refreshToken = useStore($worktreeRefreshToken)

  useEffect(() => {
    const git = desktopGit()

    if (!enabled || !repoPaths.length || !git?.worktreeList) {
      setMap({})
      setLoading(false)

      return
    }

    let cancelled = false

    setLoading(true)
    // Bounded so a many-repo project doesn't fire a request per repo at once.
    void mapPool(repoPaths, WORKTREE_PROBE_CONCURRENCY, async repoPath => {
      try {
        return [repoPath, await git.worktreeList(repoPath)] as const
      } catch {
        return [repoPath, []] as const
      }
    })
      .then(entries => void (cancelled || setMap(Object.fromEntries(entries))))
      .finally(() => void (cancelled || setLoading(false)))

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands in for repoPaths (identity-unstable array)
  }, [enabled, key, refreshToken])

  return [map, loading]
}

// Persisted open/collapse for a repo/worktree node. Lets a project's folder
// layout auto-restore when you enter it, and survive reloads. State is the
// RESOLVED boolean per node (see `$sidebarWorkspaceNodeOpen`), so a lane whose
// `defaultOpen` flips — empty lanes default collapsed, then default open once
// they hold a session — keeps whatever the user explicitly chose. An absent id
// follows `defaultOpen`, so empty lanes still start collapsed until opened.
export function useWorkspaceNodeOpen(id: string, defaultOpen = true): [boolean, () => void] {
  const state = useStore($sidebarWorkspaceNodeOpen)

  return [state[id] ?? defaultOpen, () => toggleWorkspaceNodeCollapsed(id, defaultOpen)]
}
