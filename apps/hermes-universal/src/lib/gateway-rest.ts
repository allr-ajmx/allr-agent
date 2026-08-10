/**
 * Typed clients for the REST routes that arrived with the 2026-08-09 backend
 * sync (MJXHRM-230) — the profile portable-bundle trio and the two
 * pull-request resolvers.
 *
 * Same reason as lib/gateway-rpc.ts: the wiring is written once so the feature
 * tickets (SE-N profile backup/restore, SE-L pull requests) consume a call
 * instead of each re-deriving a body shape. Every helper goes through
 * `lib/api.ts`, so it runs over the Rust http_request command with the session
 * token and `?profile=` already attached.
 *
 * Transport only: no atoms, no UI.
 */

import { api } from '@/lib/api'

// Profile archive work is filesystem + tar on the backend, which on a large
// profile is well past the default request budget.
const ARCHIVE_TIMEOUT_MS = 60_000

// --- profile portable bundles ----------------------------------------------

/**
 * The desktop appearance/interface overlay a profile archive can carry
 * (`desktop.json` at the profile root). Deliberately loose: it is authored by
 * whichever app exported the bundle, so every field is optional and unknown
 * ones must survive a round-trip.
 */
export interface ProfileDesktopOverlay {
  /** Layout tree (hermes.desktop.layoutTree.v2 shape). */
  layoutTree?: unknown
  /** Active layout preset id. */
  layoutPreset?: string
  /** Light/dark/system preference. */
  mode?: string
  /** Rail color override for this profile. */
  profileColor?: null | string
  /** Skin name (built-in or bundled user theme). */
  skin?: string
  /** Full user-theme definitions the skin may reference. */
  themes?: Record<string, unknown>
  /** Overlay schema version (1). */
  version?: number
}

export interface ProfileImportResult {
  /** The bundled appearance overlay, when the archive carried one — returned
   *  here so the caller can apply theme/layout without a second round-trip. */
  desktop: null | ProfileDesktopOverlay
  name: string
  ok: boolean
  path: string
}

/** Import a profile `.tar.gz` as a new profile. `archive` is a path on the
 *  BACKEND's filesystem, not an upload. */
export function importProfileArchive(archive: string, name?: null | string): Promise<ProfileImportResult> {
  return api<ProfileImportResult>({
    path: '/api/profiles/import',
    method: 'POST',
    body: { archive, name: name || null },
    timeoutMs: ARCHIVE_TIMEOUT_MS
  })
}

export interface ProfileExportResult {
  /** Absolute path of the written archive on the backend. */
  archive: string
  ok: boolean
}

/**
 * Export a profile to a shareable `.tar.gz` on the backend's filesystem.
 *
 * `extraFiles` stages extra root-level files into the archive alongside the
 * profile's own artifacts — that is how the appearance overlay travels
 * (`{ 'desktop.json': JSON.stringify(overlay) }`). A blank `output` lets the
 * backend name the file under `HERMES_HOME/profile-exports`.
 */
export function exportProfileArchive(
  name: string,
  opts: { extraFiles?: Record<string, string>; output?: string } = {}
): Promise<ProfileExportResult> {
  return api<ProfileExportResult>({
    path: `/api/profiles/${encodeURIComponent(name)}/export`,
    method: 'POST',
    body: { extra_files: opts.extraFiles ?? {}, output: opts.output ?? '' },
    timeoutMs: ARCHIVE_TIMEOUT_MS
  })
}

export interface ProfileDesktopOverlayResult {
  desktop: null | ProfileDesktopOverlay
  exists: boolean
}

/** Read the appearance overlay bundled with an already-imported profile.
 *  `exists: false` is the normal answer for a profile that never carried one. */
export function getProfileDesktopOverlay(name: string): Promise<ProfileDesktopOverlayResult> {
  return api<ProfileDesktopOverlayResult>({
    path: `/api/profiles/${encodeURIComponent(name)}/desktop-overlay`
  })
}

// --- pull requests ---------------------------------------------------------

export interface BranchPullRequest {
  branch: string
  draft: boolean
  number: number
  /** Lowercased by the backend (`open` / `closed` / `merged`). */
  state: string
  title: string
  url: string
}

export interface RepoPullRequests {
  /** False whenever `gh` is missing, unauthenticated, or the query failed — in
   *  which case `prs` is empty and means "unknown", not "none". */
  ghReady: boolean
  prs: BranchPullRequest[]
}

/** Resolve the pull requests for a repo's branches (and/or explicit numbers)
 *  through `gh`. Both lists are deduped and capped backend-side; passing
 *  neither answers `{ ghReady: false, prs: [] }`. */
export function listRepoPullRequests(
  repoPath: string,
  branches: string[],
  numbers?: number[]
): Promise<RepoPullRequests> {
  return api<RepoPullRequests>({
    path: '/api/git/review/pr-list',
    method: 'POST',
    body: { branches, numbers: numbers ?? [], path: repoPath }
  })
}

export interface SessionPullRequestScan {
  /** Keyed by session id; only sessions where a PR was found appear. */
  pull_requests: Record<string, { number: number; url: string }>
  /** Every id that was looked at — so a caller can remember a miss and never
   *  ask again, rather than re-scanning every profile's state.db each refresh. */
  scanned: string[]
}

/** Recover the PR each of these sessions opened from its own transcript — for
 *  sessions whose recorded branch can't answer (they started on trunk and did
 *  the work in a worktree). Read-only; ids are deduped and capped at 2000. */
export function scanSessionPullRequests(ids: string[]): Promise<SessionPullRequestScan> {
  return api<SessionPullRequestScan>({
    path: '/api/profiles/sessions/pull-requests',
    method: 'POST',
    body: { ids }
  })
}
