import { open as openDialog } from '@tauri-apps/plugin-dialog'

import type { SidebarProjectTree } from '@/app/chat/sidebar/projects/model'
import type { HermesGitBaseBranch, HermesGitBranch } from '@/global'
import { translateNow } from '@/i18n'
import { desktopGit } from '@/lib/desktop-git'
import { persistentAtom } from '@/lib/persisted'
import { IS_DESKTOP } from '@/lib/platform'
import { atom } from '@/store/atom'
import { $sessionId } from '@/store/chat'
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
// The disk repo scan stays a backend concern: the server-computed `projects.tree`
// already supplies session-derived projects.

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

// Native folder picker (desktop Tauri only), so this returns null on mobile.
// FIXME(MJX-107): should route through `selectDesktopPaths` (`lib/desktop-fs.ts`)
// like desktop's does, which falls back to the browsable backend-FS picker
// (`app/right-pane/files/remote-picker.tsx`) where there is no native dialog.
export async function pickProjectFolder(): Promise<null | string> {
  if (!IS_DESKTOP) {
    return null
  }

  try {
    const dir = await openDialog({ directory: true, multiple: false })

    return typeof dir === 'string' ? dir : null
  } catch {
    return null
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
