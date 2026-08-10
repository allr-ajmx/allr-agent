import { atom, computed, type ReadableAtom } from 'nanostores'

import type { HermesGitWorktree, HermesRepoStatus } from '@/global'
import { desktopGit } from '@/lib/desktop-git'

import { $busy, $currentCwd } from './chat'
import {
  $projectScope,
  $projectTree,
  $worktreeDialog,
  $worktreeRefreshToken,
  ALL_PROJECTS,
  projectRootCwd
} from './projects'
import { $effectiveCwd, $workspaceChangeTick } from './workspace-events'

// Live working-tree status for every git surface on screen — the data backbone
// of the composer coding rail. Keyed PER CWD: the composer mounts once per tile
// and each tile can sit in a different worktree, so a single global status
// painted the primary repo's branch and ± onto every rail (the "tile shows
// main's diff" bug). It's the same "cheaply re-read git truth at the right
// moments" model as the sidebar worktree probe: a single bounded
// `git status --porcelain=v2` per on-screen worktree per refresh, driven by
// structural edges (cwd change, turn settle, window focus, worktree mutation),
// never per-token and never touching the conversation/system-prompt cache.

const REPO_STATUS_REFRESH_DEBOUNCE_MS = 100

const EMPTY_WORKTREES: HermesGitWorktree[] = []

const normalizeCwd = (cwd?: null | string): null | string => cwd?.trim() || null

// Status + worktrees per normalized cwd. Entries outlive their surface (the map
// stays bounded by the worktrees touched this run) so re-opening a tile paints
// its last-known status instantly while the fresh probe runs.
export const $repoStatusByCwd = atom<Record<string, HermesRepoStatus | null>>({})
export const $repoWorktreesByCwd = atom<Record<string, HermesGitWorktree[]>>({})

export const $repoStatusLoading = atom(false)

// The PRIMARY view — the sidebar's selected cwd sliced out of the per-cwd truth.
// Only surfaces that are genuine singletons (the command palette's jump-to-a-
// worktree list) read this; anything that can live in ANOTHER worktree reads the
// per-cwd accessors below.
export const $repoStatus: ReadableAtom<HermesRepoStatus | null> = computed(
  [$repoStatusByCwd, $currentCwd],
  (byCwd, cwd) => byCwd[normalizeCwd(cwd) ?? ''] ?? null
)

// The repo's real worktrees (for the coding rail's "jump to a worktree" menu).
// Refreshed on the same edges as the status probe; empty off a repo.
export const $repoWorktrees: ReadableAtom<HermesGitWorktree[]> = computed(
  [$repoWorktreesByCwd, $currentCwd],
  (byCwd, cwd) => byCwd[normalizeCwd(cwd) ?? ''] ?? EMPTY_WORKTREES
)

// Reference-stable per-cwd slices, so any number of rails can each subscribe to
// their own worktree's status without re-deriving an atom per render.
const statusAtomByCwd = new Map<string, ReadableAtom<HermesRepoStatus | null>>()
const worktreesAtomByCwd = new Map<string, ReadableAtom<HermesGitWorktree[]>>()
const $noRepoStatus = atom<HermesRepoStatus | null>(null)
const $noWorktrees = atom<HermesGitWorktree[]>(EMPTY_WORKTREES)

/** Reactive status for one repo cwd (a tile's worktree). Stable per cwd. */
export function repoStatusForCwd(cwd?: null | string): ReadableAtom<HermesRepoStatus | null> {
  const key = normalizeCwd(cwd)

  if (!key) {
    return $noRepoStatus
  }

  let $slice = statusAtomByCwd.get(key)

  if (!$slice) {
    $slice = computed($repoStatusByCwd, byCwd => byCwd[key] ?? null)
    statusAtomByCwd.set(key, $slice)
  }

  return $slice
}

/** Reactive worktree list for one repo cwd. Stable per cwd. */
export function repoWorktreesForCwd(cwd?: null | string): ReadableAtom<HermesGitWorktree[]> {
  const key = normalizeCwd(cwd)

  if (!key) {
    return $noWorktrees
  }

  let $slice = worktreesAtomByCwd.get(key)

  if (!$slice) {
    $slice = computed($repoWorktreesByCwd, byCwd => byCwd[key] ?? EMPTY_WORKTREES)
    worktreesAtomByCwd.set(key, $slice)
  }

  return $slice
}

export type RepoChangeKind = 'added' | 'conflicted' | 'modified'

// Absolute file path → its git change kind, for VS Code-style file-tree tinting.
// Reuses the same bounded status probe (capped file list); git reports repo-root-
// relative paths, so we join them onto the cwd. Keyed to $effectiveCwd, not the
// sidebar's cwd: the file tree is a singleton decorating the review pane, and
// that pane already follows the FOCUSED chat. Deletions never appear — the file
// is gone from disk, so there's no tree row to tint.
export const $repoChangeByPath = computed([$repoStatusByCwd, $effectiveCwd], (byCwd, cwd) => {
  const map = new Map<string, RepoChangeKind>()
  const key = normalizeCwd(cwd)
  const status = key ? (byCwd[key] ?? null) : null
  const root = (key || '').replace(/[/\\]+$/, '')

  if (!status || !root) {
    return map
  }

  for (const file of status.files) {
    const kind: RepoChangeKind = file.conflicted ? 'conflicted' : file.untracked ? 'added' : 'modified'
    map.set(`${root}/${file.path}`, kind)
  }

  return map
})

// Cwds whose rails are on screen right now (refcounted — two tiles in one
// worktree register it twice). Every unscoped refresh re-probes each registered
// cwd plus the sidebar's, so a tile's rail moves when ITS agent touches the
// tree, not only when the primary's does.
const registeredCwds = new Map<string, number>()

/**
 * Keep `cwd` in the refresh set while its rail is mounted. Returns a release
 * (undefined for a blank cwd), kicking off an immediate probe on register.
 */
export function registerRepoStatusCwd(cwd?: null | string): (() => void) | undefined {
  const key = normalizeCwd(cwd)

  if (!key) {
    return undefined
  }

  registeredCwds.set(key, (registeredCwds.get(key) ?? 0) + 1)
  scheduleRepoStatusRefresh(key)

  let released = false

  return () => {
    if (released) {
      return
    }

    released = true
    const count = registeredCwds.get(key) ?? 0

    if (count <= 1) {
      registeredCwds.delete(key)
    } else {
      registeredCwds.set(key, count - 1)
    }
  }
}

function setRepoStatusEntry(target: string, status: HermesRepoStatus | null): void {
  const byCwd = $repoStatusByCwd.get()

  // Skip the no-op null→null write so a repeated failed probe doesn't churn
  // every rail's computed slice.
  if (target in byCwd && byCwd[target] === status) {
    return
  }

  $repoStatusByCwd.set({ ...byCwd, [target]: status })
}

function setRepoWorktreesEntry(target: string, worktrees: HermesGitWorktree[]): void {
  const byCwd = $repoWorktreesByCwd.get()

  if (target in byCwd && byCwd[target] === worktrees) {
    return
  }

  $repoWorktreesByCwd.set({ ...byCwd, [target]: worktrees })
}

interface RepoStatusRefreshRequest {
  probe: (cwd: string) => Promise<HermesRepoStatus | null>
  seq: number
  target: string
}

// Coalesce overlapping probes: many triggers can fire around a turn boundary
// (busy flip + worktree token + focus), and several worktrees can need a
// re-probe at once. Keep ONE probe in flight and at most one trailing request
// per cwd so a slow `git status` cannot multiply into an unbounded subprocess
// pile-up.
const seqByCwd = new Map<string, number>()
const pendingByCwd = new Map<string, RepoStatusRefreshRequest>()
const scheduledCwds = new Set<string>()
let repoStatusRefreshInFlight: Promise<void> | null = null
let repoStatusRefreshTimer: ReturnType<typeof setTimeout> | null = null
let scheduledAllTargets = false

// A result only lands while it is still the newest request for ITS cwd. The
// debounce below deliberately delays the next probe; without this live check an
// old probe can land in that gap and briefly make a rail look like it is on a
// stale branch.
const isCurrentSeq = (target: string, seq: number): boolean => seqByCwd.get(target) === seq

async function loadWorktrees(target: string, seq: number): Promise<void> {
  const list = desktopGit()?.worktreeList

  if (!list) {
    setRepoWorktreesEntry(target, EMPTY_WORKTREES)

    return
  }

  try {
    const worktrees = await list(target)

    if (isCurrentSeq(target, seq)) {
      setRepoWorktreesEntry(target, worktrees)
    }
  } catch {
    if (isCurrentSeq(target, seq)) {
      setRepoWorktreesEntry(target, EMPTY_WORKTREES)
    }
  }
}

/**
 * Re-probe the working tree for one cwd. Best-effort: a non-repo, a remote
 * backend, or a missing probe clears that cwd's entry so its rail hides rather
 * than showing stale data.
 */
async function runRepoStatusRefresh({ probe, seq, target }: RepoStatusRefreshRequest): Promise<void> {
  try {
    const status = await probe(target)

    // Drop the result if a newer refresh for this cwd started while we were
    // probing — the newer probe owns the entry.
    if (!isCurrentSeq(target, seq)) {
      return
    }

    setRepoStatusEntry(target, status)

    // Worktrees only matter inside a repo; clear them otherwise.
    if (status) {
      void loadWorktrees(target, seq)
    } else {
      setRepoWorktreesEntry(target, EMPTY_WORKTREES)
    }
  } catch {
    if (isCurrentSeq(target, seq)) {
      setRepoStatusEntry(target, null)
      setRepoWorktreesEntry(target, EMPTY_WORKTREES)
    }
  }
}

async function drainRepoStatusRefreshes(): Promise<void> {
  while (pendingByCwd.size > 0) {
    const [target, request] = pendingByCwd.entries().next().value as [string, RepoStatusRefreshRequest]

    pendingByCwd.delete(target)
    await runRepoStatusRefresh(request)
  }

  // This reset is synchronous with the final empty-queue check. A refresh
  // arriving before this continuation runs is drained above; one arriving
  // afterward sees no in-flight promise and starts a new drain.
  repoStatusRefreshInFlight = null
  $repoStatusLoading.set(false)
}

/**
 * Re-probe the working tree for `cwd` (defaults to the sidebar's cwd). Only
 * that one cwd's entry moves — every other on-screen worktree keeps its own
 * cached truth.
 */
export function refreshRepoStatus(cwd?: null | string): Promise<void> {
  const target = normalizeCwd(cwd ?? $currentCwd.get())
  const probe = desktopGit()?.repoStatus

  if (!probe) {
    // No git bridge at all: there is no local git truth — wipe every entry so
    // no rail shows stale status, and invalidate any in-flight probe results.
    pendingByCwd.clear()
    seqByCwd.clear()
    $repoStatusByCwd.set({})
    $repoWorktreesByCwd.set({})
    $repoStatusLoading.set(false)

    return repoStatusRefreshInFlight || Promise.resolve()
  }

  if (!target) {
    // No cwd (a detached fresh chat). The computed views already read empty for
    // a blank cwd, and other worktrees' entries stay valid.
    return repoStatusRefreshInFlight || Promise.resolve()
  }

  const seq = (seqByCwd.get(target) ?? 0) + 1

  seqByCwd.set(target, seq)
  pendingByCwd.set(target, { probe, seq, target })
  $repoStatusLoading.set(true)

  if (!repoStatusRefreshInFlight) {
    repoStatusRefreshInFlight = drainRepoStatusRefreshes()
  }

  return repoStatusRefreshInFlight
}

/** Registered (on-screen) worktrees + the sidebar's cwd. */
function refreshTargets(): Set<string> {
  const targets = new Set(registeredCwds.keys())
  const primary = normalizeCwd($currentCwd.get())

  if (primary) {
    targets.add(primary)
  }

  return targets
}

/** Re-probe every on-screen worktree (and the primary). Awaits the drain. */
export async function refreshAllRepoStatuses(): Promise<void> {
  const targets = refreshTargets()

  if (targets.size === 0) {
    return
  }

  // Queue every target, then await the single in-flight drain once.
  let last: Promise<void> = Promise.resolve()

  for (const target of targets) {
    last = refreshRepoStatus(target)
  }

  await last
}

// `cwd` scopes the refresh to one worktree; omit it to re-probe every on-screen
// worktree (turn settle, window focus — the tree may have changed under any of
// them).
function scheduleRepoStatusRefresh(cwd?: null | string): void {
  if (cwd === undefined) {
    scheduledAllTargets = true
  } else {
    const key = normalizeCwd(cwd)

    if (key) {
      scheduledCwds.add(key)
    }
  }

  if (repoStatusRefreshTimer) {
    clearTimeout(repoStatusRefreshTimer)
  }

  repoStatusRefreshTimer = setTimeout(() => {
    repoStatusRefreshTimer = null
    const targets = new Set(scheduledCwds)

    if (scheduledAllTargets) {
      for (const target of refreshTargets()) {
        targets.add(target)
      }
    }

    scheduledCwds.clear()
    scheduledAllTargets = false

    for (const target of targets) {
      void refreshRepoStatus(target)
    }
  }, REPO_STATUS_REFRESH_DEBOUNCE_MS)
}

// ── Triggers ─────────────────────────────────────────────────────────────────
// Wired once at module load (mirrors projects.ts's module-scope subscriptions).
// Each is a structural edge where a working tree may have changed under us.

// The sidebar's cwd changed (session switch / new chat) → re-probe that repo.
$currentCwd.subscribe(cwd => scheduleRepoStatusRefresh(cwd))

// A worktree was added/removed or a branch switched through store/projects.ts →
// re-probe, so the coding rows' branch labels and counts repaint immediately
// instead of waiting for the next workspace tick.
$worktreeRefreshToken.subscribe(() => scheduleRepoStatusRefresh())

// A file-mutating tool finished (event-driven, not polled) → re-probe so the
// rails' branch/+/- move exactly when an agent touches a tree. Unscoped on
// purpose: the tool may belong to a background tile's session, so every
// on-screen worktree re-probes, not just the primary.
$workspaceChangeTick.subscribe(() => scheduleRepoStatusRefresh())

// A turn settling is the backstop for changes no tool diff announced (e.g. a
// raw `git` in the terminal): one final refresh when the agent goes idle.
let prevBusy = $busy.get()

$busy.subscribe(busy => {
  if (prevBusy && !busy) {
    scheduleRepoStatusRefresh()
  }

  prevBusy = busy
})

// External changes while the window was away (an outside terminal) — refresh on
// refocus, the git-GUI standard.
if (typeof window !== 'undefined') {
  window.addEventListener('focus', () => scheduleRepoStatusRefresh())
}

// ── New-worktree target resolution ───────────────────────────────────────────
// This code lives here and not in projects.ts. To pick the target it must read
// both the project state and the git truth, and coding-status already depends
// on projects — a dependency the other way is a cycle.

// `git status` answers "is this a repo?" for free, so remember the verdict per
// path. Bounded by the folders a user actually points at in one run.
const gitRepoByPath = new Map<string, boolean>()

/**
 * Is this path a git repo? A path sitting in a project row is not evidence that
 * git can branch from it, so any candidate picked out of FOLDERS is validated
 * here. False when there's no git bridge at all (nothing to probe).
 */
export async function isGitRepoPath(cwd: string): Promise<boolean> {
  const key = normalizeCwd(cwd)
  const probe = desktopGit()?.repoStatus

  if (!key || !probe) {
    return false
  }

  const cached = gitRepoByPath.get(key)

  if (cached !== undefined) {
    return cached
  }

  let isRepo = false

  try {
    isRepo = (await probe(key)) !== null
  } catch {
    isRepo = false
  }

  gitRepoByPath.set(key, isRepo)

  return isRepo
}

// The repo a new worktree is cut from: the cwd of the FOCUSED surface, or the
// root of the project the user entered. Both are things the user points at —
// there is no "use some other project's repo" step, because that would branch
// somewhere the user never selected. '' means no repo is in reach; that's a
// no-op rather than an error, since a worktree only exists inside a repo.
export async function resolveWorktreeRepoPath(): Promise<string> {
  const scope = $projectScope.get()
  const scopedProject = scope === ALL_PROJECTS ? undefined : $projectTree.get().find(node => node.id === scope)

  const candidates = [$effectiveCwd.get(), projectRootCwd(scopedProject)]

  for (const candidate of candidates) {
    const path = (candidate ?? '').trim()

    if (path && (await isGitRepoPath(path))) {
      return path
    }
  }

  return ''
}

/** Publish the "new worktree" intent. The ONE mounted WorktreeDialog renders it. */
export async function openWorktreeDialog(options?: { base?: string; repoPath?: string }): Promise<void> {
  const repoPath = options?.repoPath?.trim() || (await resolveWorktreeRepoPath())

  if (repoPath) {
    $worktreeDialog.set({ base: options?.base, repoPath })
  }
}

/** Test-only: drop the probe memo + in-flight / pending / registered state so
 *  cases don't leak into each other. */
export function _resetCodingStatusForTests(): void {
  if (repoStatusRefreshTimer) {
    clearTimeout(repoStatusRefreshTimer)
    repoStatusRefreshTimer = null
  }

  gitRepoByPath.clear()
  scheduledCwds.clear()
  scheduledAllTargets = false
  pendingByCwd.clear()
  seqByCwd.clear()
  registeredCwds.clear()
  repoStatusRefreshInFlight = null
  $repoStatusByCwd.set({})
  $repoWorktreesByCwd.set({})
  $repoStatusLoading.set(false)
}
