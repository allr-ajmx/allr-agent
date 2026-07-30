import { open as openDialog } from '@tauri-apps/plugin-dialog'

import type { SidebarProjectTree } from '@/app/chat/sidebar/projects/model'
import { translateNow } from '@/i18n'
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
// Git-worktree operations (start-work, base-branch, worktree add/remove, disk
// repo scan) are not implemented here yet — FIXME(MJX-107). This needs no local
// git: `lib/desktop-git.ts` already exposes the whole bridge over the gateway's
// `/api/git/*` REST surface, and `worktreeAdd`/`worktreeRemove`/`baseBranchList`/
// `scanRepos` are exported and uncalled. Only the store + UI layer is missing.
// Meanwhile the server-computed `projects.tree` supplies session-derived projects.

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
