import type { SidebarProjectTree } from '@/app/chat/sidebar/projects/model'
import type { HermesGitBaseBranch, HermesGitBranch } from '@/global'
import { getHermesConfig } from '@/hermes'
import { translateNow } from '@/i18n'
import { copyTextToClipboard, desktopDefaultCwd, selectDesktopPaths } from '@/lib/desktop-fs'
import { desktopGit } from '@/lib/desktop-git'
import { persistentAtom } from '@/lib/persisted'
import { revealPathInFileManager } from '@/lib/reveal-path'
import { atom } from '@/store/atom'
import { $sessionId } from '@/store/chat'
import { $connection } from '@/store/connection'
import { requestGateway } from '@/store/gateway'
import { setSidebarAgentsGrouped } from '@/store/layout'
import { notify, notifyError } from '@/store/notifications'
import { newSession } from '@/store/session'
import type { ProjectInfo, ProjectsPayload } from '@/types/hermes'

// First-class per-profile Projects, served by the gateway `projects.*` JSON-RPC
// methods (backed by projects.db). Ported/adapted from desktop `store/projects.ts`.
// The git-worktree half (start-work, base branches, worktree add/remove) lives
// at the bottom of this file and runs entirely through `lib/desktop-git.ts`,
// which bridges the gateway's `/api/git/*` REST surface — no local git needed.
// Repository discovery (the disk crawl behind repo-first projects) sits just
// above it and runs in Rust against the local filesystem; the server-computed
// `projects.tree` supplies session-derived projects either way.

export const $projects = atom<ProjectInfo[]>([])
export const $activeProjectId = atom<null | string>(null)
export const $projectTree = atom<SidebarProjectTree[]>([])
export const $projectTreeLoading = atom(false)
// False when the backend predates the projects.* surface; null until first probe.
export const $projectsRpcAvailable = atom<boolean | null>(null)

function isMissingRpcMethod(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()

  return msg.includes('method not found') || msg.includes('-32601') || msg.includes('unknown method')
}

function markRpcSuccess(): void {
  $projectsRpcAvailable.set(true)
}

function markRpcFailure(err: unknown): void {
  if (isMissingRpcMethod(err)) {
    $projectsRpcAvailable.set(false)
  }
}

function staleBackendError(): Error {
  return new Error(translateNow('sidebar.projects.staleBackend'))
}

function applyPayload(payload: ProjectsPayload): void {
  $projects.set(payload.projects ?? [])
  $activeProjectId.set(payload.active_id ?? null)
}

export async function refreshProjects(): Promise<void> {
  try {
    applyPayload(await requestGateway<ProjectsPayload>('projects.list'))
    markRpcSuccess()
  } catch (err) {
    markRpcFailure(err)
  }
}

interface ProjectTreePayload {
  projects: SidebarProjectTree[]
  active_id: null | string
  scoped_session_ids?: string[]
}

export async function refreshProjectTree(): Promise<void> {
  $projectTreeLoading.set(true)

  try {
    const res = await requestGateway<ProjectTreePayload>('projects.tree', { preview_limit: 3 })
    $projectTree.set(res.projects ?? [])
    $activeProjectId.set(res.active_id ?? null)
    markRpcSuccess()
  } catch (err) {
    markRpcFailure(err)
  } finally {
    $projectTreeLoading.set(false)
  }
}

export async function fetchProjectSessions(projectId: string): Promise<SidebarProjectTree | null> {
  try {
    const res = await requestGateway<{ project: SidebarProjectTree | null }>('projects.project_sessions', {
      project_id: projectId
    })

    return res.project ?? null
  } catch {
    return null
  }
}

// ── Project scope (the "you're inside a project" view) ──────────────────────
export const ALL_PROJECTS = '__all_projects__'

export const $projectScope = persistentAtom<string>('hermes.projectScope', ALL_PROJECTS, {
  decode: raw => raw || ALL_PROJECTS,
  encode: value => value || ALL_PROJECTS
})

export function enterProject(id: string): void {
  $projectScope.set(id)

  if (id.startsWith('p_')) {
    void setActiveProject(id).catch(() => undefined)
  }
}

export function exitProjectScope(): void {
  $projectScope.set(ALL_PROJECTS)
}

// ── Optimistic cache layer ──────────────────────────────────────────────────
interface ProjectsSnapshot {
  projects: ProjectInfo[]
  tree: SidebarProjectTree[]
  active: null | string
}

const snapshot = (): ProjectsSnapshot => ({
  projects: $projects.get(),
  tree: $projectTree.get(),
  active: $activeProjectId.get()
})

const restore = ({ projects, tree, active }: ProjectsSnapshot): void => {
  $projects.set(projects)
  $projectTree.set(tree)
  $activeProjectId.set(active)
}

async function persistOrRollback(snap: ProjectsSnapshot, write: () => Promise<void>): Promise<void> {
  try {
    await write()
  } catch (err) {
    restore(snap)
    throw err
  }
}

const reconcile = (): void => {
  void refreshProjects()
  void refreshProjectTree()
}

function projectInfoToTreeNode(project: ProjectInfo): SidebarProjectTree {
  return {
    color: project.color ?? null,
    icon: project.icon ?? null,
    id: project.id,
    isAuto: false,
    label: project.name || project.id,
    path: project.primary_path ?? project.folders?.[0]?.path ?? null,
    previewSessions: [],
    repos: [],
    sessionCount: 0
  }
}

export interface CreateProjectInput {
  name: string
  folders?: string[]
  primaryPath?: string
  description?: string
  icon?: string
  color?: string
  use?: boolean
  idea?: string
}

// `seed` = the current idea text (a picked template or typed direction). When
// present the model expands/sharpens it (keeping the theme); when empty it
// invents a fresh idea. The per-call nonce defeats the backend's prompt/result
// caching (which otherwise returns the SAME idea every time).
export async function generateProjectIdea(name: string, seed = ''): Promise<string> {
  try {
    const nonce = Math.random().toString(36).slice(2, 10)
    const direction = seed.trim()

    const focus = [
      name.trim() ? `Project name: ${name.trim()}.` : '',
      direction
        ? `Build on this direction — keep its theme, make it concrete and richer:\n${direction}`
        : 'Surprise me with an unexpected project.'
    ]
      .filter(Boolean)
      .join('\n')

    const res = await requestGateway<{ text: string }>('llm.oneshot', {
      instructions:
        'You generate a single, concrete project idea as a short IDEA.md body: a one-line summary, ' +
        'then 3-5 bullet goals. No preamble, no code fences, under 120 words.' +
        (direction
          ? ' Expand and sharpen the given direction — keep its topic, do not switch themes.'
          : ' Make each idea distinct — avoid overused examples (weather apps, to-do lists).'),
      input: `${focus} (variation seed: ${nonce})`,
      temperature: 1.0,
      // Inherit the live session's model (parity with desktop). Without this the
      // backend routes to the auxiliary "title_generation" model, which is often
      // small/unconfigured → terse or failed generation.
      session_id: $sessionId.get() || undefined
    })

    return (res.text || '').trim()
  } catch (err) {
    // Surface the reason (e.g. "gateway not connected" / no model) instead of a
    // silent no-op, so the sparkle spinning-then-nothing isn't a mystery.
    notifyError(err, translateNow('sidebar.projects.ideaFailed'))

    return ''
  }
}

export async function createProject(input: CreateProjectInput): Promise<ProjectInfo | null> {
  if ($projectsRpcAvailable.get() === false) {
    throw staleBackendError()
  }

  let res: { project: ProjectInfo | null }

  try {
    res = await requestGateway<{ project: ProjectInfo | null }>('projects.create', {
      name: input.name,
      folders: input.folders ?? [],
      primary_path: input.primaryPath,
      description: input.description,
      icon: input.icon,
      color: input.color,
      use: input.use ?? false
    })
  } catch (err) {
    if (isMissingRpcMethod(err)) {
      $projectsRpcAvailable.set(false)
      throw staleBackendError()
    }

    throw err
  }

  markRpcSuccess()
  const created = res.project

  if (created) {
    if (!$projects.get().some(p => p.id === created.id)) {
      $projects.set([...$projects.get(), created])
    }

    if (!$projectTree.get().some(node => node.id === created.id)) {
      $projectTree.set([projectInfoToTreeNode(created), ...$projectTree.get()])
    }

    if (input.use) {
      $activeProjectId.set(created.id)
    }

    setSidebarAgentsGrouped(true)
  }

  reconcile()

  return created
}

export async function renameProject(id: string, name: string): Promise<void> {
  await updateProject(id, { name })
}

export async function updateProject(
  id: string,
  patch: { name?: string; color?: null | string; icon?: null | string }
): Promise<void> {
  const snap = snapshot()

  $projectTree.set(
    snap.tree.map(node =>
      node.id === id
        ? {
            ...node,
            ...(patch.name !== undefined && { label: patch.name }),
            ...(patch.color !== undefined && { color: patch.color }),
            ...(patch.icon !== undefined && { icon: patch.icon })
          }
        : node
    )
  )
  $projects.set(snap.projects.map(p => (p.id === id ? { ...p, ...patch } : p)))

  // Backend treats null/undefined as "leave unchanged"; "" clears.
  await persistOrRollback(snap, () =>
    requestGateway('projects.update', {
      id,
      ...patch,
      ...(patch.color === null && { color: '' }),
      ...(patch.icon === null && { icon: '' })
    })
  )
}

/**
 * Set a project's color and/or icon.
 *
 * An INHERITED project (`isAuto`) is a git repo root the backend promoted into
 * the tree with no `projects.db` row behind it — there is no id to PATCH. So
 * theming one MATERIALIZES it into a real project, carrying whichever of
 * color/icon was already set so setting one doesn't wipe the other.
 *
 * Ported from desktop `store/projects.ts#setProjectAppearance`. Returns whether
 * a project was materialized, so callers can react to the tree gaining a row.
 */
export async function setProjectAppearance(
  project: Pick<SidebarProjectTree, 'color' | 'icon' | 'id' | 'isAuto' | 'label' | 'path'>,
  patch: { color?: null | string; icon?: null | string }
): Promise<boolean> {
  if (!project.isAuto) {
    await updateProject(project.id, patch)

    return false
  }

  // An auto node with no path has nothing to anchor a real project to.
  if (!project.path) {
    return false
  }

  await createProject({
    name: project.label,
    folders: [project.path],
    primaryPath: project.path,
    color: (patch.color ?? project.color) || undefined,
    icon: (patch.icon ?? project.icon) || undefined
  })

  return true
}

export async function addProjectFolder(
  id: string,
  path: string,
  opts: { label?: string; isPrimary?: boolean } = {}
): Promise<void> {
  const snap = snapshot()
  await persistOrRollback(snap, () =>
    requestGateway('projects.add_folder', { id, path, label: opts.label, is_primary: opts.isPrimary ?? false })
  )
  reconcile()
}

export async function deleteProject(id: string): Promise<void> {
  const snap = snapshot()
  const wasScoped = $projectScope.get() === id

  $projects.set(snap.projects.filter(p => p.id !== id))
  $projectTree.set(snap.tree.filter(node => node.id !== id))

  if (snap.active === id) {
    $activeProjectId.set(null)
  }

  if (wasScoped) {
    exitProjectScope()
    newSession()
  }

  await persistOrRollback(snap, async () => {
    applyPayload(await requestGateway<ProjectsPayload>('projects.delete', { id }))
  })
  void refreshProjectTree()
}

export async function setActiveProject(id: null | string): Promise<void> {
  const res = await requestGateway<{ active_id: null | string }>('projects.set_active', { id })
  $activeProjectId.set(res.active_id ?? null)
}

// ── Project management dialog ───────────────────────────────────────────────
export interface ProjectDialogState {
  mode: 'add-folder' | 'create' | 'rename'
  projectId?: string
  name?: string
}

export const $projectDialog = atom<null | ProjectDialogState>(null)

export function openProjectCreate(): void {
  if ($projectsRpcAvailable.get() === false) {
    notify({ kind: 'warning', message: translateNow('sidebar.projects.staleBackend') })

    return
  }

  $projectDialog.set({ mode: 'create' })
}

export function openProjectRename(project: { id: string; name: string }): void {
  $projectDialog.set({ mode: 'rename', name: project.name, projectId: project.id })
}

export function openProjectAddFolder(project: { id: string; name: string }): void {
  $projectDialog.set({ mode: 'add-folder', name: project.name, projectId: project.id })
}

export function closeProjectDialog(): void {
  $projectDialog.set(null)
}

// Pick a project folder via the remote-aware picker: a Tauri desktop opens the
// native dialog, everything else browses the BACKEND filesystem (seeded at its
// default cwd) where sessions actually run. Returns the absolute path, or null
// if cancelled. Desktop parity — mobile/web used to get a flat `null` here, with
// only the manual path input as a way in.
export async function pickProjectFolder(): Promise<null | string> {
  const [dir] = await selectDesktopPaths({
    defaultPath: (await desktopDefaultCwd().catch(() => null))?.cwd,
    directories: true,
    multiple: false
  })

  return dir || null
}

// Reveal a project/worktree path in the OS file manager (git-GUI standard).
// Desktop routes this through its Electron bridge; universal uses the Tauri
// `reveal_in_file_manager` command, which no-ops off Tauri. Note the path only
// resolves on THIS machine — a remote gateway's worktree lives on its host, so
// this quietly does nothing there rather than pretending to succeed.
export async function revealPath(path: null | string): Promise<void> {
  if (path) {
    await revealPathInFileManager(path)
  }
}

// Copy a path to the clipboard (git-GUI standard). Always meaningful, remote or
// not — the string is what the user wants to paste into a terminal.
export async function copyPath(path: null | string): Promise<void> {
  if (path) {
    await copyTextToClipboard(path)
  }
}

// ── Repository discovery (the disk crawl) ───────────────────────────────────
// Ported from desktop `store/projects.ts`. "Repo-first" projects: crawl the
// configured roots for git repositories and hand them to the backend, which
// caches them (`projects.record_repos`) and merges them with session-derived
// repos, so a repo shows up in Projects before it has ever hosted a session.
//
// The crawl runs against the Tauri host's disk (`lib/desktop-git.ts` →
// `store/repo-scan.ts` → Rust), so it only speaks for the gateway when the
// backend was spawned locally; elsewhere `scanRepos` returns `[]` and the
// backend keeps serving session-derived repos alone (FIXME(MJX-207)).
//
// Desktop keys the throttle state per gateway (it can hold several); universal
// has exactly one connection at a time, so module-level state plus a reset on
// connection change is the same guarantee.

export interface RepoDiscoveryPolicy {
  enabled: boolean
  roots: string[]
  exclude_paths: string[]
}

/** True while a crawl is in flight — the sidebar shows a spinner on it. */
export const $reposScanning = atom(false)

export function repoDiscoveryPolicyFromConfig(config: unknown): RepoDiscoveryPolicy {
  const desktopValue = config && typeof config === 'object' ? (config as { desktop?: unknown }).desktop : undefined

  const desktop =
    desktopValue && typeof desktopValue === 'object'
      ? (desktopValue as {
          repo_scan_enabled?: unknown
          repo_scan_exclude_paths?: unknown
          repo_scan_roots?: unknown
        })
      : {}

  return {
    // Absent config means discovery is ON — only an explicit `false` disables it.
    enabled: desktop.repo_scan_enabled !== false,
    exclude_paths: Array.isArray(desktop.repo_scan_exclude_paths)
      ? desktop.repo_scan_exclude_paths.filter((value): value is string => typeof value === 'string')
      : [],
    roots: Array.isArray(desktop.repo_scan_roots)
      ? desktop.repo_scan_roots.filter((value): value is string => typeof value === 'string')
      : []
  }
}

export function repoDiscoveryPolicySignature(policy: RepoDiscoveryPolicy): string {
  return JSON.stringify(policy)
}

let scanGeneration = 0
let completedSignature: string | undefined
let runningSignature: string | undefined

// A different gateway/profile has a different disk and a different cache, so the
// "already scanned this policy" memo must not carry across a reconnect.
$connection.subscribe(() => {
  scanGeneration += 1
  completedSignature = undefined
  runningSignature = undefined
  $reposScanning.set(false)
})

/**
 * Crawl the configured roots and record what we find, unless the same policy
 * already ran (pass `force` after the user edits the policy, or on refocus).
 *
 * A disabled policy still posts an empty list: that is what makes the backend
 * drop its cached repos, so turning discovery off actually removes them.
 */
export async function scanAndRecordRepos(force = false): Promise<void> {
  const scan = desktopGit()?.scanRepos

  if (!scan) {
    return
  }

  const generation = ++scanGeneration
  const stale = () => scanGeneration !== generation

  try {
    const policy = repoDiscoveryPolicyFromConfig(await getHermesConfig())
    const signature = repoDiscoveryPolicySignature(policy)

    if (!force && (completedSignature === signature || runningSignature === signature)) {
      return
    }

    runningSignature = signature

    let repos: { root: string; label: string }[] = []

    if (policy.enabled) {
      $reposScanning.set(true)
      repos = await scan(policy.roots, { enabled: true, excludePaths: policy.exclude_paths })

      if (stale()) {
        return
      }
    }

    await requestGateway('projects.record_repos', { discovery_policy: policy, repos })

    if (stale()) {
      return
    }

    completedSignature = signature
    await refreshProjectTree()
  } catch {
    // Let the next attempt retry from scratch rather than memoizing a failure.
    completedSignature = undefined
  } finally {
    runningSignature = undefined

    if (!stale()) {
      $reposScanning.set(false)
    }
  }
}

// ── Git-driven worktrees ("Start work") ─────────────────────────────────────
// Ported from desktop `store/projects.ts`. Every op is a thin wrapper over the
// `desktopGit()` bridge; the interesting part is the refresh token + the two
// request atoms that let the composer hand work off to the chat controller.

// Bumped after a `git worktree add`/`remove` so worktree-list probes refetch and
// the new/removed lane shows at once, instead of waiting for the next scope
// change. `store/coding-status.ts` subscribes to it.
export const $worktreeRefreshToken = atom(0)
const bumpWorktrees = () => $worktreeRefreshToken.set($worktreeRefreshToken.get() + 1)

// Re-run the `git worktree list` probe without the heavy projects.tree scan.
// Add/remove initiated here already bumps the token inline; this is for
// OUT-OF-BAND changes the UI can't see — the agent running `git worktree
// add/remove` in the terminal during a turn, or an external shell mutating the
// repo while the window was away. The probe is per-repo and bounded, so a
// settled turn / window refocus can re-sync the lanes cheaply.
export function refreshWorktrees(): void {
  bumpWorktrees()
}

// Spin up a fresh worktree the lightest way (`git worktree add -b`) under the
// repo, returning where Hermes should start working. Git is the source of
// truth; the caller starts a session in the returned path.
export async function startWorkInRepo(
  repoPath: string,
  options?: { name?: string; branch?: string; base?: string; existingBranch?: string }
): Promise<null | { path: string; branch: string }> {
  const git = desktopGit()

  if (!git || !repoPath) {
    return null
  }

  const result = await git.worktreeAdd(repoPath, options)
  bumpWorktrees()

  return { branch: result.branch, path: result.path }
}

// Local branches for the composer's "convert a branch into a worktree" picker.
// Empty when the backend can't probe (no bridge / not a repo).
export async function listRepoBranches(repoPath: string): Promise<HermesGitBranch[]> {
  const git = desktopGit()

  if (!git?.branchList || !repoPath) {
    return []
  }

  return git.branchList(repoPath)
}

// Local + remote-tracking branches for the base-branch picker in the
// new-worktree dialog. The remote default (origin/HEAD) is flagged so the UI can
// preselect it.
export async function listBaseBranches(repoPath: string): Promise<HermesGitBaseBranch[]> {
  const git = desktopGit()

  if (!git?.baseBranchList || !repoPath) {
    return []
  }

  return git.baseBranchList(repoPath)
}

export async function switchBranchInRepo(repoPath: string, branch: string): Promise<void> {
  const git = desktopGit()

  if (!git || !repoPath || !branch.trim()) {
    return
  }

  await git.branchSwitch(repoPath, branch)
  bumpWorktrees()
}

export async function removeWorktreePath(
  repoPath: string,
  worktreePath: string,
  options?: { force?: boolean }
): Promise<void> {
  const git = desktopGit()

  if (!git) {
    return
  }

  await git.worktreeRemove(repoPath, worktreePath, options)
  bumpWorktrees()
}

// A composer-driven "branch off into a new worktree" hand-off. The composer owns
// the typed draft; the chat controller owns session lifecycle. The composer
// creates the worktree (startWorkInRepo), then fires this so the controller opens
// a fresh session in that worktree and prefills the draft that kicked off the
// task. A monotonic token lets a rapid second request re-fire the controller's
// effect even if the path repeats.
export interface StartWorkSessionRequest {
  draft?: string
  path: string
  token: number
}

export const $startWorkSessionRequest = atom<StartWorkSessionRequest | null>(null)

// Keyboard-driven "spin up a new worktree" intent. The composer's coding row
// owns the name dialog (it has the active repo + branch context), so a global
// hotkey just bumps this token; the row opens its branch-off dialog in response.
// A monotonic token re-fires even on repeat presses. No-ops off a repo (the row
// isn't mounted), which is the right "nothing to branch" outcome.
export const $newWorktreeRequest = atom(0)

export function requestNewWorktree(): void {
  $newWorktreeRequest.set($newWorktreeRequest.get() + 1)
}

let startWorkToken = 0

export function requestStartWorkSession(path: string, draft?: string): void {
  const target = path.trim()

  if (!target) {
    return
  }

  startWorkToken += 1
  $startWorkSessionRequest.set({ draft: draft?.trim() || undefined, path: target, token: startWorkToken })
}
