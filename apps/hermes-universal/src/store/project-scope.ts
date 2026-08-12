/**
 * WHERE A NEW CHAT STARTS — the sidebar's project scope, and the one ladder that
 * turns it into a working directory.
 *
 * This is a LEAF on purpose. It holds only the scope atom, the project tree it
 * is resolved against, and `resolveNewSessionCwd`, so the modules that actually
 * mint a fresh draft — `store/chat` (`resetChat`, `ensureSession`) — can consult
 * it directly. `store/projects` already imports `store/chat` and `store/session`,
 * so the resolver could not live there and be read from the place that needs it:
 * every caller had to remember to pass it in, and the ones that forgot (the
 * whole mobile bubble path, session delete/archive, a re-homed tile window)
 * silently opened chats detached from the project the user was standing in
 * (MJXHRM-393).
 *
 * `store/projects` re-exports everything here, so nothing else had to move.
 */

import type { SidebarProjectTree } from '@/app/chat/sidebar/projects/model'
import { persistentAtom } from '@/lib/persisted'
import { atom } from '@/store/atom'
import { cwdForNewSession } from '@/store/default-project-dir'

/** Id of the Home bucket (must match the backend tree's `NO_PROJECT_ID`).
 *
 *  Lives here rather than beside the sidebar's grouping helpers because the
 *  resolver below is the code that gives it meaning, and a store must not reach
 *  into `app/` for a value at runtime. `workspace-groups` re-exports it for the
 *  sidebar. */
export const NO_PROJECT_ID = '__no_project__'

/** Scope value meaning "not drilled into anything" — the flat, all-projects list. */
export const ALL_PROJECTS = '__all_projects__'

/** The project the sidebar is standing in: a project id, `NO_PROJECT_ID` for the
 *  Home bucket, or `ALL_PROJECTS`. Persisted, so a scope survives a restart. */
export const $projectScope = persistentAtom<string>('hermes.projectScope', ALL_PROJECTS, {
  decode: raw => raw || ALL_PROJECTS,
  encode: value => value || ALL_PROJECTS
})

/** The server-computed project tree the scope is resolved against. Written by
 *  `store/projects` (`applyPayload` / `refreshProjectTree`). */
export const $projectTree = atom<SidebarProjectTree[]>([])

/** A project's repo root: its own folder, else the first repo that has one. */
export const projectRootCwd = (project: SidebarProjectTree | undefined): string =>
  (project?.path || project?.repos.find(repo => repo.path)?.path || '').trim()

/**
 * The cwd a NEW chat should start in. Desktop's ladder, first hit wins:
 *
 *  1. The Home / "no project" bucket ⇒ `''`, and that is the ANSWER, not an
 *     absence of one: a chat started from Home must stay detached rather than
 *     silently attaching to the configured default dir and leaving Home.
 *  2. Drilled into a project ⇒ that project's repo root. NOT gated on local
 *     mode: the path comes from the gateway's own filesystem (the tree is
 *     server-computed), so it is meaningful against a remote backend too.
 *  3. Otherwise the configured default project dir, which `cwdForNewSession`
 *     gates to local connections by itself.
 *
 * Owning the whole ladder is the point. When this returned `''` for both branch
 * 1 and branch 3, every caller had to re-apply the default-dir fallback, which
 * made the two indistinguishable — and Home fell through to the default dir at
 * BOTH layers that resolve a draft's directory (`resetChat`, then `ensureSession`
 * on first send). The detached branch was dead code.
 */
export function resolveNewSessionCwd(): string {
  const scope = $projectScope.get()

  if (scope === NO_PROJECT_ID) {
    return ''
  }

  if (scope !== ALL_PROJECTS) {
    const cwd = projectRootCwd($projectTree.get().find(node => node.id === scope))

    if (cwd) {
      return cwd
    }
  }

  return cwdForNewSession()?.trim() || ''
}
