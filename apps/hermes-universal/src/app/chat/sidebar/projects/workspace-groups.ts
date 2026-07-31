import type { HermesGitWorktree } from '@/global'
import { normalize } from '@/lib/text'
import type { SessionInfo } from '@/types/hermes'

import { type SidebarSessionGroup, sessionRecency, type SidebarWorkspaceTree } from './model'

// Ported from desktop `projects/workspace-groups.ts` — the VISUAL-ONLY worktree
// enhancer that injects empty lanes from `git worktree list`.
//
// Session grouping is computed authoritatively on the backend
// (`tui_gateway/project_tree.py`, exposed via `projects.tree` /
// `projects.project_sessions`); this module never decides session membership. It
// only relabels/re-anchors lanes against git truth and adds lanes for worktrees
// that have no Hermes sessions yet.
//
// Desktop's LIVE-SESSION overlay half (`overlayRepoLanes`, `overlayLiveLanes`,
// `overlayLivePreviews`, `excludeProjectSessions`, `liveSessionProjectId`) is
// deliberately NOT ported: universal's sidebar threads no live/removed session
// sets — `registerNewSession` (store/session) upserts optimistic rows straight
// into `$sessions`, so the backend tree already carries them. Port it if and
// when a live feed appears, and note that the overlay prunes lanes it empties,
// so `entered-content` would then have to re-merge after it.

/** Path split into segments, ignoring trailing slashes and mixed separators. */
const segments = (path: string): string[] =>
  path
    .replace(/[/\\]+$/, '')
    .split(/[/\\]/)
    .filter(Boolean)

/** A path with trailing separators stripped, for stable equality checks. */
const normalizePath = (path: null | string | undefined): string => (path ?? '').replace(/[/\\]+$/, '')

/** Last path segment. */
export const baseName = (path: string): string | undefined => segments(path).pop()

// The `.worktrees` dir for a KANBAN-TASK worktree path, else null. Only matches
// task worktrees (`<repo>/.worktrees/t_<hex>`, the `t_…` id kanban_db mints) so
// the many ephemeral task worktrees collapse into one lane — while user-named
// "New worktree" dirs (`<repo>/.worktrees/<slug>`) stay as their own lanes.
const KANBAN_DIR_RE = /^(.*[/\\]\.worktrees)[/\\]t_[0-9a-f]+[/\\]?$/

export function kanbanWorktreeDir(path: string): null | string {
  return path.match(KANBAN_DIR_RE)?.[1] ?? null
}

/** Label for a main-checkout lane whose session recorded no branch. */
export const DEFAULT_BRANCH_LABEL = 'main'

/** Id of the Home bucket (must match the backend tree's `NO_PROJECT_ID`). */
export const NO_PROJECT_ID = '__no_project__'

/** The one definition of a main-checkout lane id (must match the backend tree). */
export const branchLaneId = (repoRoot: string, branch?: string): string =>
  `${repoRoot}::branch::${(branch ?? '').trim()}`

/** Default-branch names that pin to the top and read as the repo's trunk. */
const TRUNK_BRANCHES = new Set(['main', 'master', 'trunk', 'develop'])

const isTrunkLane = (group: SidebarSessionGroup): boolean =>
  Boolean(group.isMain) && TRUNK_BRANCHES.has(group.label.toLowerCase())

/** A lane's recency = its most-recently-active session (empty lanes sink). */
const laneActivity = (group: SidebarSessionGroup): number =>
  group.sessions.reduce((max, session) => Math.max(max, sessionRecency(session)), 0)

// Lane tiers (low sorts first): the repo's primary ("home") checkout pins above
// everything (it's "where you are", labeled by its live branch), then trunk,
// then ordinary branches/worktrees, then the kanban aggregate.
const laneRank = (group: SidebarSessionGroup): number =>
  group.isHome ? 0 : isTrunkLane(group) ? 1 : group.isKanban ? 3 : 2

/**
 * Sort by tier (home → trunk → branches/worktrees → kanban); within a tier, by
 * most-recent activity (empty lanes fall last), label as the tiebreak.
 */
function compareWorktreeGroups(a: SidebarSessionGroup, b: SidebarSessionGroup): number {
  const byRank = laneRank(a) - laneRank(b)

  if (byRank !== 0) {
    return byRank
  }

  const byActivity = laneActivity(b) - laneActivity(a)

  return byActivity || a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })
}

export function sortWorktreeGroups(groups: SidebarSessionGroup[]): SidebarSessionGroup[] {
  return [...groups].sort(compareWorktreeGroups)
}

/**
 * VISUAL enhancer only: inject empty lanes from a live `git worktree list` so a
 * repo shows its branches/worktrees even when they have no Hermes sessions yet.
 * The repo's real session lanes already come fully built from the backend
 * (`projects.project_sessions`); this never adds or moves session rows, and it
 * degrades to a no-op when no worktree listing is available. Lanes already
 * present (by id/path/label) are left untouched.
 */
export function mergeRepoWorktreeGroups(
  repo: Pick<SidebarWorkspaceTree, 'groups' | 'id' | 'path'>,
  discoveredWorktrees?: HermesGitWorktree[]
): SidebarSessionGroup[] {
  // Branch-primary labels: a linked worktree's identity in every git UI (VS
  // Code, JetBrains, lazygit, …) is its CHECKED-OUT BRANCH, not the directory it
  // happens to live in. The backend labels these lanes by dir/slug; relabel them
  // to the live branch from `git worktree list` so the sidebar matches the
  // composer's branch strip. Detached worktrees (no branch) keep their dir label.
  const liveBranchByPath = new Map<string, string>()
  // Inverse: branch → its ONE live worktree path. git guarantees a branch is
  // checked out in at most one worktree, so this mapping is a function and can
  // re-anchor a lane whose stored path has drifted from git truth.
  const livePathByBranch = new Map<string, string>()

  for (const worktree of discoveredWorktrees ?? []) {
    const wtPath = normalizePath(worktree.path)
    const branch = worktree.branch?.trim()

    if (wtPath && branch && !worktree.detached) {
      liveBranchByPath.set(wtPath, branch)
      livePathByBranch.set(branch.toLowerCase(), worktree.path.trim())
    }
  }

  // The primary ("home") checkout's LIVE branch. A repo dir is only ever on ONE
  // branch, so every main-checkout session lane (historical branches over the
  // same root path) collapses into a single home lane labeled by this live
  // branch, defaulting to `main`. Known only when the worktree probe ran; without
  // it the backend's recorded-branch main lanes are kept untouched.
  const mainWorktree = (discoveredWorktrees ?? []).find(worktree => worktree.isMain)
  const homeBranch =
    mainWorktree && !mainWorktree.detached ? mainWorktree.branch?.trim() || DEFAULT_BRANCH_LABEL : ''

  // Reconcile a LINKED worktree lane against git truth so its label AND path
  // describe the SAME worktree. Two repair directions:
  //  1. Path git knows → relabel to that path's live branch (git UIs identify a
  //     worktree by its checked-out branch, not the dir it lives in).
  //  2. Path git DOESN'T know but the label IS a live branch → the lane's path
  //     has gone stale; re-anchor it to that branch's real path, else "reveal"
  //     opens a different, stale checkout. The home checkout is folded
  //     separately (below), never here.
  const reconcile = (group: SidebarSessionGroup): SidebarSessionGroup => {
    if (group.isMain || group.isKanban) {
      return group
    }

    const branchForPath = liveBranchByPath.get(normalizePath(group.path))

    if (branchForPath) {
      return branchForPath !== group.label ? { ...group, label: branchForPath } : group
    }

    const livePath = livePathByBranch.get(normalize(group.label))

    if (livePath && normalizePath(livePath) !== normalizePath(group.path)) {
      return { ...group, id: livePath, path: livePath }
    }

    return group
  }

  const dedupeById = (sessions: SessionInfo[]): SessionInfo[] => {
    const byId = new Map<string, SessionInfo>()

    for (const session of sessions) {
      byId.set(session.id, byId.get(session.id) ?? session)
    }

    return [...byId.values()]
  }

  // Fold every main-checkout lane into one home lane labeled by the live branch
  // (the root dir is only ever on one branch); reconcile the linked worktrees.
  // Always shown, even with no sessions on the current branch yet. With no probe
  // (no homeBranch) the main lanes are kept untouched.
  const mainGroups = repo.groups.filter(group => group.isMain)
  const reconciled = repo.groups.filter(group => !group.isMain).map(reconcile)

  if (homeBranch) {
    reconciled.push({
      id: branchLaneId(repo.id, homeBranch),
      label: homeBranch,
      path: repo.path,
      isMain: true,
      isHome: true,
      sessions: dedupeById(mainGroups.flatMap(group => group.sessions))
    })
  } else {
    reconciled.push(...mainGroups)
  }

  // Collapse any duplicate a re-anchor produced (a stale lane re-pointed onto a
  // path a real lane already holds) — keep the richer (more sessions) lane.
  const byPath = new Map<string, SidebarSessionGroup>()
  const merged: SidebarSessionGroup[] = []

  for (const group of reconciled) {
    const key = !group.isMain && group.path ? normalizePath(group.path) : ''
    const existing = key ? byPath.get(key) : undefined

    if (existing) {
      if (group.sessions.length > existing.sessions.length) {
        merged[merged.indexOf(existing)] = group
        byPath.set(key, group)
      }

      continue
    }

    if (key) {
      byPath.set(key, group)
    }

    merged.push(group)
  }

  const seenIds = new Set(merged.map(group => group.id))
  const seenPaths = new Set(merged.map(group => group.path).filter((path): path is string => Boolean(path)))
  // Dedupe by branch label too: a branch shows once even if it's checked out in
  // a linked worktree AND already has a session lane.
  const seenLabels = new Set(merged.map(group => group.label.toLowerCase()))

  for (const worktree of discoveredWorktrees ?? []) {
    const wtPath = worktree.path?.trim()

    if (!wtPath) {
      continue
    }

    // The home checkout is already the collapsed home lane (above).
    if (worktree.isMain && homeBranch) {
      continue
    }

    // Kanban task worktrees never get their own lane — they fold into the
    // session-derived `::kanban` bucket. Listing every `git worktree list` entry
    // here is exactly what blew the sidebar up to hundreds of empty rows.
    if (!worktree.isMain && kanbanWorktreeDir(wtPath)) {
      continue
    }

    const label =
      (worktree.isMain ? worktree.branch?.trim() || DEFAULT_BRANCH_LABEL : worktree.branch?.trim()) ||
      baseName(wtPath) ||
      wtPath

    const id = worktree.isMain ? branchLaneId(repo.id, label) : wtPath

    const alreadySeen =
      seenIds.has(id) || seenLabels.has(label.toLowerCase()) || (!worktree.isMain && seenPaths.has(wtPath))

    if (alreadySeen) {
      continue
    }

    merged.push({ id, isMain: worktree.isMain, label, path: wtPath, sessions: [] })
    seenIds.add(id)
    seenPaths.add(wtPath)
    seenLabels.add(label.toLowerCase())
  }

  return sortWorktreeGroups(merged)
}
