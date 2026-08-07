import type {
  HermesGitBaseBranch,
  HermesGitBranch,
  HermesGitWorktree,
  HermesRepoStatus,
  HermesReviewList,
  HermesReviewScope,
  HermesReviewShipInfo
} from '@/global'
import { api } from '@/lib/api'
import { localRepoScanSupported, scanLocalGitRepos } from '@/store/repo-scan'

// Ported from apps/desktop/src/lib/desktop-git.ts — specifically its `remoteGit`
// branch. Desktop runs git through Electron when it owns the filesystem, and
// mirrors the same surface over the dashboard REST API (`/api/git/*`) whenever
// the gateway is remote, so the coding rail / worktree lanes / review pane act
// on the BACKEND repo where sessions actually run.
//
// Universal is *always* that remote case: there is no local FS bridge, the
// gateway owns the repo. So the Electron branch is dropped and `desktopGit()`
// returns the REST implementation unconditionally. `desktopApi` becomes the
// universal `api()` helper (which routes through the Rust http_request command
// and attaches the session token + `?profile=`).

export interface GitBridge {
  worktreeList: (repoPath: string) => Promise<HermesGitWorktree[]>
  worktreeAdd: (
    repoPath: string,
    options?: { name?: string; branch?: string; base?: string; existingBranch?: string }
  ) => Promise<{ path: string; branch: string; repoRoot: string }>
  worktreeRemove: (
    repoPath: string,
    worktreePath: string,
    options?: { force?: boolean }
  ) => Promise<{ removed: string }>
  branchSwitch: (repoPath: string, branch: string) => Promise<{ branch: string }>
  branchList: (repoPath: string) => Promise<HermesGitBranch[]>
  baseBranchList: (repoPath: string) => Promise<HermesGitBaseBranch[]>
  repoStatus: (repoPath: string) => Promise<HermesRepoStatus | null>
  fileDiff: (repoPath: string, filePath: string) => Promise<string>
  review: {
    list: (repoPath: string, scope: HermesReviewScope, baseRef?: null | string) => Promise<HermesReviewList>
    diff: (
      repoPath: string,
      filePath: string,
      scope: HermesReviewScope,
      baseRef?: null | string,
      staged?: boolean
    ) => Promise<string>
    stage: (repoPath: string, filePath?: null | string) => Promise<{ ok: boolean }>
    unstage: (repoPath: string, filePath?: null | string) => Promise<{ ok: boolean }>
    revert: (repoPath: string, filePath?: null | string) => Promise<{ ok: boolean }>
    revParse: (repoPath: string, ref?: null | string) => Promise<null | string>
    commit: (repoPath: string, message: string, push: boolean) => Promise<{ ok: boolean }>
    commitContext: (repoPath: string) => Promise<{ diff: string; recent: string }>
    push: (repoPath: string) => Promise<{ ok: boolean }>
    shipInfo: (repoPath: string) => Promise<HermesReviewShipInfo>
    createPr: (repoPath: string) => Promise<{ url: string }>
  }
  scanRepos: (
    roots: string[],
    options?: { maxDepth?: number; enabled?: boolean; excludePaths?: string[] }
  ) => Promise<{ root: string; label: string }[]>
}

function gitGet<T>(route: string, params: Record<string, boolean | null | string | undefined>): Promise<T> {
  const query = new URLSearchParams()

  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) {
      query.set(key, String(value))
    }
  }

  return api<T>({ path: `/api/git/${route}?${query.toString()}` })
}

function gitPost<T>(route: string, body: Record<string, unknown>): Promise<T> {
  return api<T>({ body, method: 'POST', path: `/api/git/${route}` })
}

const remoteGit: GitBridge = {
  worktreeList: async repoPath =>
    (await gitGet<{ worktrees: HermesGitWorktree[] }>('worktrees', { path: repoPath })).worktrees,

  worktreeAdd: (repoPath, options) => gitPost('worktree/add', { path: repoPath, ...options }),

  worktreeRemove: (repoPath, worktreePath, options) =>
    gitPost('worktree/remove', { force: options?.force ?? false, path: repoPath, worktreePath }),

  branchSwitch: (repoPath, branch) => gitPost('branch/switch', { branch, path: repoPath }),

  branchList: async repoPath =>
    (await gitGet<{ branches: HermesGitBranch[] }>('branches', { path: repoPath })).branches,

  baseBranchList: async repoPath =>
    (await gitGet<{ branches: HermesGitBaseBranch[] }>('base-branches', { path: repoPath })).branches,

  repoStatus: repoPath => gitGet<HermesRepoStatus | null>('status', { path: repoPath }),

  fileDiff: async (repoPath, filePath) =>
    (await gitGet<{ diff: string }>('file-diff', { file: filePath, path: repoPath })).diff,

  review: {
    list: (repoPath, scope, baseRef) =>
      gitGet<HermesReviewList>('review/list', { base: baseRef, path: repoPath, scope }),

    diff: async (repoPath, filePath, scope, baseRef, staged) =>
      (await gitGet<{ diff: string }>('review/diff', { base: baseRef, file: filePath, path: repoPath, scope, staged }))
        .diff,

    stage: (repoPath, filePath) => gitPost('review/stage', { file: filePath ?? null, path: repoPath }),

    unstage: (repoPath, filePath) => gitPost('review/unstage', { file: filePath ?? null, path: repoPath }),

    revert: (repoPath, filePath) => gitPost('review/revert', { file: filePath ?? null, path: repoPath }),

    revParse: async (repoPath, ref) =>
      (await gitGet<{ sha: null | string }>('review/rev-parse', { path: repoPath, ref })).sha,

    commit: (repoPath, message, push) => gitPost('review/commit', { message, path: repoPath, push }),

    commitContext: repoPath => gitGet('review/commit-context', { path: repoPath }),

    push: repoPath => gitPost('review/push', { path: repoPath }),

    shipInfo: repoPath => gitGet<HermesReviewShipInfo>('review/ship-info', { path: repoPath }),

    createPr: repoPath => gitPost('review/create-pr', { path: repoPath })
  },

  // Repo discovery is a local-disk crawl, not a git command, so it has no
  // `/api/git/*` counterpart: it runs in Rust against THIS machine's filesystem
  // (store/repo-scan.ts → src-tauri/src/repo_scan.rs). That is only the gateway's
  // filesystem when the backend was spawned locally; on a remote/cloud gateway
  // (and on mobile, which has no crawlable disk) we return nothing rather than
  // recording repos that don't exist over there. The backend still merges
  // session-derived repos, so discovery degrades instead of breaking.
  // FIXME(MJX-207): a gateway-side `/api/git/scan-repos` would cover those cases.
  scanRepos: async (roots, options) => (localRepoScanSupported() ? await scanLocalGitRepos(roots, options ?? {}) : [])
}

export function desktopGit(): GitBridge | undefined {
  return remoteGit
}
