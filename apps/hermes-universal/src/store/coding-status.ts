import { atom, computed } from 'nanostores'

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

// Live working-tree status for the active session's cwd — the data backbone of
// the composer coding rail. It's the same "cheaply re-read git truth at the
// right moments" model as the sidebar worktree probe: a single bounded
// `git status --porcelain=v2` per refresh, driven by structural edges (cwd
// change, turn settle, window focus, worktree mutation), never per-token and
// never touching the conversation/system-prompt cache.

export const $repoStatus = atom<HermesRepoStatus | null>(null)
export const $repoStatusLoading = atom(false)

// The repo's real worktrees (for the coding rail's "jump to a worktree" menu).
// Refreshed on the same edges as the status probe; empty off a repo.
export const $repoWorktrees = atom<HermesGitWorktree[]>([])
const REPO_STATUS_REFRESH_DEBOUNCE_MS = 100

export type RepoChangeKind = 'added' | 'conflicted' | 'modified'

// Absolute file path → its git change kind, for VS Code-style file-tree tinting.
// Reuses the same bounded $repoStatus probe (capped file list); git reports
// repo-root-relative paths, so we join them onto the active cwd. Deletions never
// appear — the file is gone from disk, so there's no tree row to tint.
export const $repoChangeByPath = computed([$repoStatus, $currentCwd], (status, cwd) => {
  const map = new Map<string, RepoChangeKind>()
  const root = (cwd || '').replace(/[/\\]+$/, '')

  if (!status || !root) {
    return map
  }

  for (const file of status.files) {
    const kind: RepoChangeKind = file.conflicted ? 'conflicted' : file.untracked ? 'added' : 'modified'
    map.set(`${root}/${file.path}`, kind)
  }

  return map
})

async function loadWorktrees(target: string): Promise<void> {
  const list = desktopGit()?.worktreeList

  if (!list) {
    $repoWorktrees.set([])

    return
  }

  try {
    const worktrees = await list(target)

    if (inflightCwd === target) {
      $repoWorktrees.set(worktrees)
    }
  } catch {
    if (inflightCwd === target) {
      $repoWorktrees.set([])
    }
  }
}

interface RepoStatusRefreshRequest {
  probe: (cwd: string) => Promise<HermesRepoStatus | null>
  seq: number
  target: string
}

// Coalesce overlapping probes: many triggers can fire around a turn boundary
// (busy flip + worktree token + focus), but only the latest cwd matters. Keep
// one probe in flight and retain at most one trailing request so a slow Git
// status cannot multiply into an unbounded subprocess pile-up.
let inflightCwd: null | string = null
let pendingRepoStatusRefresh: RepoStatusRefreshRequest | null = null
let repoStatusRefreshInFlight: Promise<void> | null = null
let repoStatusRefreshSeq = 0
let repoStatusRefreshTimer: ReturnType<typeof setTimeout> | null = null

const normalizeCwd = (cwd?: null | string): null | string => cwd?.trim() || null

/**
 * Re-probe the working tree for `cwd` (defaults to the active session's cwd).
 * Best-effort: a non-repo, a remote backend, or a missing probe clears the
 * status so the rail hides rather than showing stale data.
 */
async function runRepoStatusRefresh({ probe, seq, target }: RepoStatusRefreshRequest): Promise<void> {
  try {
    const status = await probe(target)

    // Drop the result if the cwd moved on while we were probing (a fast session
    // switch) — the newer probe owns the atom.
    if (seq === repoStatusRefreshSeq && inflightCwd === target) {
      $repoStatus.set(status)

      // Worktrees only matter inside a repo; clear them otherwise.
      if (status) {
        void loadWorktrees(target)
      } else {
        $repoWorktrees.set([])
      }
    }
  } catch {
    if (seq === repoStatusRefreshSeq && inflightCwd === target) {
      $repoStatus.set(null)
      $repoWorktrees.set([])
    }
  }
}

async function drainRepoStatusRefreshes(): Promise<void> {
  while (pendingRepoStatusRefresh) {
    const request = pendingRepoStatusRefresh

    pendingRepoStatusRefresh = null
    await runRepoStatusRefresh(request)
  }

  // This reset is synchronous with the final empty-queue check. A refresh
  // arriving before this continuation runs is drained above; one arriving
  // afterward sees no in-flight promise and starts a new drain.
  repoStatusRefreshInFlight = null
  $repoStatusLoading.set(false)
}

export function refreshRepoStatus(cwd?: null | string): Promise<void> {
  const target = normalizeCwd(cwd ?? $currentCwd.get())
  const probe = desktopGit()?.repoStatus
  const seq = (repoStatusRefreshSeq += 1)

  if (!target || !probe) {
    pendingRepoStatusRefresh = null
    inflightCwd = null
    $repoStatus.set(null)
    $repoWorktrees.set([])
    $repoStatusLoading.set(false)

    return repoStatusRefreshInFlight || Promise.resolve()
  }

  inflightCwd = target
  pendingRepoStatusRefresh = { probe, seq, target }
  $repoStatusLoading.set(true)

  if (!repoStatusRefreshInFlight) {
    repoStatusRefreshInFlight = drainRepoStatusRefreshes()
  }

  return repoStatusRefreshInFlight
}

function scheduleRepoStatusRefresh(cwd?: null | string): void {
  if (repoStatusRefreshTimer) {
    clearTimeout(repoStatusRefreshTimer)
  }

  repoStatusRefreshTimer = setTimeout(() => {
    repoStatusRefreshTimer = null
    void refreshRepoStatus(cwd)
  }, REPO_STATUS_REFRESH_DEBOUNCE_MS)
}

// ── Triggers ─────────────────────────────────────────────────────────────────
// Wired once at module load (mirrors projects.ts's module-scope subscriptions).
// Each is a structural edge where the working tree may have changed under us.

// The active session's cwd changed (session switch / new chat) → re-probe.
$currentCwd.subscribe(cwd => scheduleRepoStatusRefresh(cwd))

// A worktree was added/removed or a branch switched through store/projects.ts →
// re-probe, so the coding row's branch label and counts repaint immediately
// instead of waiting for the next workspace tick.
$worktreeRefreshToken.subscribe(() => scheduleRepoStatusRefresh())

// A file-mutating tool finished (event-driven, not polled) → re-probe so the
// rail's branch/+/- move exactly when the agent touches the tree.
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

/** Test-only: drop the repo-probe memo so cases don't leak into each other. */
export function _resetCodingStatusForTests(): void {
  gitRepoByPath.clear()
}
