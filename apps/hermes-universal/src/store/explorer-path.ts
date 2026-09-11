/**
 * ONE action for "the user chose this folder in the explorer", and one source
 * of truth behind it.
 *
 * There used to be two. `$fileTreeRootOverride` was a view-only root that beat
 * `$effectiveCwd` outright, so Home re-rooted the tree while the session kept
 * working elsewhere, and — because an active override could not be seen
 * through — a real cwd change arriving later could not move the tree back. Both
 * directions were broken by the same atom, so the atom is gone.
 *
 * What is left is the cwd itself. Explorer → cwd is `session.cwd.set`; cwd →
 * explorer already worked and still needs no code (`session.info` → the session
 * slice → `$focusedCwd` → `$effectiveCwd` → the tree). Nothing here sets a tree
 * root, and nothing should: the tree's root IS the cwd now.
 *
 * The branching lives in `store/explorer-path-decision` (rule 35); this module
 * is the atoms, the RPC and the notifications.
 */

import { translateNow } from '@/i18n'
import { setSessionCwd } from '@/lib/gateway-rpc'
import { atom } from '@/store/atom'
import { setDefaultProjectDir } from '@/store/default-project-dir'
import { explorerPathFailure, planExplorerPath } from '@/store/explorer-path-decision'
import { notify } from '@/store/notifications'
import { $focusedSessionState } from '@/store/session-states'
import { setWorkspaceCwd } from '@/store/workspace-events'

/**
 * The pending "move this chat, or only new ones?" question.
 *
 * An atom rather than local state in each row, and rendered ONCE near the app
 * root (`app/explorer-path-dialog.tsx`), because the askers are a titlebar
 * button, a tree row's context menu and a search hit's kebab — three surfaces
 * that mount and unmount independently, one of which (the context menu) is
 * portalled away the instant it is selected. A dialog owned by the asker would
 * be unmounted before it could be answered.
 */
export interface ExplorerPathPrompt {
  /** Also adopt the folder as a project once the user has chosen — the "Set as
   *  Project Folder" row, whose project half is `store/projects` and whose
   *  session half is this. Cancelling cancels both. */
  adoptProject: boolean
  /** Absolute gateway path. */
  path: string
  /** Rule 17: the RUNTIME id, captured when the question was asked, so the
   *  answer moves the session the user was actually looking at. */
  runtimeSessionId: string
}

export const $explorerPathPrompt = atom<ExplorerPathPrompt | null>(null)

export interface SetExplorerPathOptions {
  /** Adopt `path` as a project too (see {@link ExplorerPathPrompt.adoptProject}). */
  adoptProject?: boolean
}

/**
 * Root the explorer at `path` — by moving whatever owns the cwd, never by
 * moving the view.
 *
 * Three outcomes, decided by `planExplorerPath`:
 *  - mid-turn → a notification saying why, and nothing changes. Both RPCs would
 *    refuse (`4009`), and re-rooting the view anyway is the bug being fixed.
 *  - a live idle session → ask (`$explorerPathPrompt`).
 *  - nothing live to move → set the workspace root and the default project dir
 *    straight away. There is no question to ask: no session's work is at stake.
 */
export function setExplorerPath(path: string, options: SetExplorerPathOptions = {}): void {
  const adoptProject = options.adoptProject === true
  const plan = planExplorerPath(path, $focusedSessionState.get())

  if (plan.kind === 'ignore') {
    return
  }

  if (plan.kind === 'blocked') {
    notifyBusy()

    return
  }

  if (plan.kind === 'detached') {
    applyToWorkspace(plan.path)

    if (adoptProject) {
      void adoptFolderAsProject(plan.path)
    }

    return
  }

  $explorerPathPrompt.set({ adoptProject, path: plan.path, runtimeSessionId: plan.runtimeSessionId })
}

/** Dismiss the question, changing nothing — including the project half. */
export function cancelExplorerPathPrompt(): void {
  $explorerPathPrompt.set(null)
}

/**
 * "Move this chat": re-anchor the live session.
 *
 * Deliberately does NOT touch the tree, `$workspaceCwd` or
 * `$defaultProjectDir`. The gateway answers with `session.info`, the reducer
 * folds the new cwd into the slice, and the tree follows from `$focusedCwd` —
 * painting it here as well would put the explorer back in the business of
 * having its own opinion about where it is rooted.
 */
export async function confirmExplorerPathMoveSession(): Promise<void> {
  const prompt = $explorerPathPrompt.get()

  if (!prompt) {
    return
  }

  $explorerPathPrompt.set(null)

  try {
    await setSessionCwd({ cwd: prompt.path, sessionId: prompt.runtimeSessionId })
  } catch (error) {
    // The turn can start between the idle check and this call, so `4009` is a
    // race rather than a mistake — and the honest thing to say is the same
    // sentence the pre-check says, not the wire's `session busy`.
    if (explorerPathFailure(error) === 'busy') {
      notifyBusy()
    } else {
      notify({
        detail: error instanceof Error ? error.message : String(error),
        kind: 'error',
        message: translateNow('explorerPath.moveFailed')
      })
    }

    return
  }

  if (prompt.adoptProject) {
    await adoptFolderAsProject(prompt.path)
  }
}

/**
 * "New chats only": leave the session where it is and change where the NEXT one
 * starts.
 *
 * `$defaultProjectDir` is what `cwdForNewSession()` reads when a session is
 * minted, so this is the whole of it — and the tree correctly does not move,
 * because nothing's cwd did.
 */
export async function confirmExplorerPathDefaultOnly(): Promise<void> {
  const prompt = $explorerPathPrompt.get()

  if (!prompt) {
    return
  }

  $explorerPathPrompt.set(null)
  setDefaultProjectDir(prompt.path)

  if (prompt.adoptProject) {
    await adoptFolderAsProject(prompt.path)
  }
}

/** No live session: the workspace root IS `$effectiveCwd`, so setting it moves
 *  the tree, and the default project dir makes the move outlive this chat. */
function applyToWorkspace(path: string): void {
  setWorkspaceCwd(path)
  setDefaultProjectDir(path)
}

function notifyBusy(): void {
  notify({ kind: 'warning', message: translateNow('explorerPath.busy') })
}

/**
 * The project half of "Set as Project Folder".
 *
 * Dynamically imported, for the reason `app/right-pane/file-actions.tsx` gives
 * for the same call: `store/projects` drags in `store/chat`, `store/session`
 * and the gateway client, and this module is reached from a tree row's menu.
 */
async function adoptFolderAsProject(path: string): Promise<void> {
  try {
    const { openFolderAsProject } = await import('@/store/projects')

    await openFolderAsProject(path)
  } catch (error) {
    notify({
      detail: error instanceof Error ? error.message : String(error),
      kind: 'error',
      message: translateNow('errors.genericFailure')
    })
  }
}
