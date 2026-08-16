/**
 * Session → project membership + inherited color, by path.
 *
 * A focused excerpt of the desktop sidebar's `projects/workspace-groups.ts`:
 * the pure path helpers plus `liveSessionProjectId` / `sessionProjectColor`.
 * Keep this a faithful copy so the pane-tab accent dots resolve to the SAME
 * project color the desktop sidebar would show.
 *
 * A `FIXME(MJX-50/workspace-groups)` here said the "full lane/kanban/worktree
 * grouping engine is not yet on universal" and asked for this file to be folded
 * back once it landed. Both halves are stale:
 *
 *  - universal HAS `app/chat/sidebar/projects/workspace-groups.ts`, and it is
 *    not a pending port. Session grouping is computed authoritatively on the
 *    BACKEND (`tui_gateway/project_tree.py`, via `projects.tree`), so that
 *    module is only the visual worktree enhancer layered over the backend's
 *    answer. There is no engine left to port — the divergence is deliberate;
 *  - the fold it asked for is done for the one piece that was genuinely
 *    duplicated: `kanbanWorktreeDir` (and its regex) stood byte-identical in
 *    both files and now has a single definition, HERE, because `lib/` may not
 *    import from `app/` and this is therefore the side that can be shared.
 *
 * (`MJX-50` was a Linear id. That tracker is retired and its numbers did not
 * carry over to Plane, so the reference named nothing by the time it was read.)
 */

import type { ProjectInfo, SessionInfo } from '@/types/hermes'

/** Path split into segments, ignoring trailing slashes and mixed separators. */
const segments = (path: string): string[] =>
  path
    .replace(/[/\\]+$/, '')
    .split(/[/\\]/)
    .filter(Boolean)

// Windows spellings: drive-letter (`C:\…`), UNC (`\\srv`, `//srv`), or any
// backslash-rooted path (`\wsl.localhost\…`). A single leading `/` stays POSIX.
// Mirrors the backend `_is_windows_path` so the live overlay places rows into
// the same project the backend tree would.
const isWindowsPath = (path: string): boolean =>
  /^[A-Za-z]:[/\\]/.test(path) || path.startsWith('\\') || path.startsWith('//')

/**
 * Segments for identity comparison: Windows paths fold case (and separators, via
 * {@link segments}) so `C:\Work` and `c:/work` are one lane; POSIX stays
 * case-sensitive. Comparison-only — emitted ids/labels keep their spelling.
 */
const comparisonSegments = (path: string): string[] => {
  const segs = segments(path)

  return isWindowsPath(path) ? segs.map(seg => seg.toLowerCase()) : segs
}

// The `.worktrees` dir for a KANBAN-TASK worktree path, else null. Only matches
// task worktrees (`<repo>/.worktrees/t_<hex>`, the `t_…` id kanban_db mints) so
// the many ephemeral task worktrees collapse into one lane — while user-named
// "New worktree" dirs (`<repo>/.worktrees/<slug>`) stay as their own lanes.
const KANBAN_DIR_RE = /^(.*[/\\]\.worktrees)[/\\]t_[0-9a-f]+[/\\]?$/

export function kanbanWorktreeDir(path: string): null | string {
  return path.match(KANBAN_DIR_RE)?.[1] ?? null
}

/** True when `target` equals `folder` or is nested under it (segment-wise). */
function isPathUnder(folder: string, target: string): boolean {
  const f = comparisonSegments(folder)
  const t = comparisonSegments(target)

  if (!f.length || f.length > t.length) {
    return false
  }

  return f.every((seg, i) => seg === t[i])
}

/**
 * The project a live session belongs to (overview membership) — explicit project
 * by longest-prefix folder, else the repo root (the auto-project id). An IN-TREE
 * linked worktree (`<repoRoot>/.worktrees/<slug>`) belongs to the SAME project as
 * its repo root. Returns null only for sessions we genuinely can't place from the
 * row alone: cwd-less, kanban-task worktrees, or a worktree outside the repo root.
 */
export function liveSessionProjectId(session: SessionInfo, explicitProjects: ProjectInfo[]): null | string {
  const cwd = (session.cwd || '').trim()
  // A session may carry only a git_repo_root and no cwd — older/imported rows,
  // or ones captured before cwd tracking. The backend still groups those by repo
  // root, so anchor on it here too; otherwise the sidebar files the row under a
  // project but the color derivation drops it (the "grouped but grey" bug).
  const repoRoot = (session.git_repo_root || '').trim() || cwd
  const anchor = cwd || repoRoot

  if (!anchor || kanbanWorktreeDir(anchor)) {
    return null
  }

  // With a cwd present it must sit under the repo root (a sibling worktree
  // outside the root can't be placed from the row alone); a root-only session
  // skips this — the root IS the anchor.
  if (cwd && !isPathUnder(repoRoot, cwd)) {
    return null
  }

  let projectId = ''
  let bestLen = -1

  for (const project of explicitProjects) {
    if (project.archived) {
      continue
    }

    for (const folder of project.folders) {
      if (isPathUnder(folder.path, cwd) || isPathUnder(folder.path, repoRoot)) {
        const len = segments(folder.path).length

        if (len > bestLen) {
          bestLen = len
          projectId = project.id
        }
      }
    }
  }

  return projectId || repoRoot
}

/**
 * The explicit project that owns a bare DIRECTORY — the one whose folder is the
 * longest prefix of `cwd`. The path half of {@link liveSessionProjectId}, minus
 * the repo-root fallback: a status bar showing "which project am I in" wants a
 * real project row (it has the name, color and icon to render) or nothing, not
 * a synthetic auto-project id it can't look anything up on.
 */
export function projectForCwd(cwd: string, projects: ProjectInfo[]): null | ProjectInfo {
  const target = (cwd || '').trim()

  if (!target) {
    return null
  }

  let best: null | ProjectInfo = null
  let bestLen = -1

  for (const project of projects) {
    if (project.archived) {
      continue
    }

    for (const folder of project.folders) {
      if (isPathUnder(folder.path, target)) {
        const len = segments(folder.path).length

        if (len > bestLen) {
          bestLen = len
          best = project
        }
      }
    }
  }

  return best
}

/**
 * The color a session inherits from its owning project — the explicit project
 * whose folder is the longest prefix of the session's cwd/repo-root, when that
 * project carries a user-set color. Auto-promoted repo projects have no color
 * unless the user set one, so a session only tints when it belongs to a colored
 * project (inheritance is opt-in by coloring the project). Reuses
 * {@link liveSessionProjectId} so the color follows the SAME membership the
 * sidebar groups by; returns null for rootless rows and uncolored projects.
 */
export function sessionProjectColor(session: SessionInfo, projects: ProjectInfo[]): null | string {
  const projectId = liveSessionProjectId(session, projects)

  if (!projectId) {
    return null
  }

  return projects.find(project => project.id === projectId)?.color ?? null
}
