import { invoke } from '@tauri-apps/api/core'

import { IS_DESKTOP } from '@/lib/platform'
import { $connection } from '@/store/connection'

// Local git-repository discovery (MJX-70). The crawl itself lives in Rust
// (src-tauri/src/repo_scan.rs), a port of desktop's Electron-side
// `git-repo-scan.ts`; these are the typed JS calls.
//
// It walks THIS machine's disk, so it is only meaningful when the gateway was
// spawned locally — a remote/cloud gateway owns a different filesystem, and
// mobile has no crawlable one (the Rust command returns `unsupported_platform`
// there). Those cases take the gateway-side crawl instead
// (`GET /api/git/scan-repos` → `hermes_cli/web_repo_scan.py`); `lib/desktop-git.ts`
// picks between the two on `localRepoScanSupported()`.

export interface ScannedRepo {
  root: string
  label: string
}

export interface RepoScanOptions {
  maxDepth?: number
  enabled?: boolean
  excludePaths?: string[]
}

/** Whether the local crawl can speak for the gateway's filesystem. */
export function localRepoScanSupported(): boolean {
  return IS_DESKTOP && $connection.get()?.mode === 'local'
}

/** Crawl `roots` for git repositories on this machine's disk. */
export function scanLocalGitRepos(roots: string[], options: RepoScanOptions = {}): Promise<ScannedRepo[]> {
  return invoke<ScannedRepo[]>('repo_scan_git_repos', {
    enabled: options.enabled ?? null,
    excludePaths: options.excludePaths ?? null,
    maxDepth: options.maxDepth ?? null,
    roots
  })
}
