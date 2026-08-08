import { getDefaultCwd } from '@/hermes'
import { atom, computed, type ReadableAtom } from '@/store/atom'
import { $focusedCwd } from '@/store/session-states'

// Ported from desktop's store/workspace-events.ts. Event-driven "the working
// tree changed" signal — the smart replacement for polling. The agent only
// mutates files by running a tool, so the message stream's `tool.complete` (esp.
// ones carrying an inline_diff) is the precise trigger. Surfaces that mirror the
// filesystem / git state — the coding rail, the review pane, the file tree —
// subscribe to this tick and refresh, so they move exactly when the agent acts.
export const $workspaceChangeTick = atom(0)

// What changed since the last consume. The file tree targets `dirs` (surgical
// subtree re-reads) and only falls back to a whole-tree rescan when `full` is
// set — an opaque mutation (a terminal command, or a path we can't resolve to
// the tree's absolute ids) whose touched paths we can't enumerate. Coarse
// subscribers (coding rail, review) ignore this and just react to the tick.
let pendingDirs = new Set<string>()
let pendingFull = false

/** Drain the accumulated change since the previous call (the tree's consumer). */
export function consumeWorkspaceChange(): { dirs: string[]; full: boolean } {
  const change = { dirs: [...pendingDirs], full: pendingFull }
  pendingDirs = new Set()
  pendingFull = false

  return change
}

// Parent dir of an ABSOLUTE path (POSIX or `C:/…`); null for a relative path we
// can't anchor to the tree — the caller treats null as "rescan to be safe".
function dirOf(path: string): null | string {
  const p = path.replace(/\\/g, '/').replace(/\/+$/, '')
  const absolute = p.startsWith('/') || /^[a-z]:\//i.test(p)
  const slash = p.lastIndexOf('/')

  return absolute && slash >= 0 ? p.slice(0, slash) : null
}

// Throttle so a burst of edits in one turn coalesces: fire on the leading edge
// for instant feedback, then at most once per window (a trailing fire catches
// the last edit of the burst).
const MIN_INTERVAL_MS = 500
let lastFired = 0
let trailing: null | ReturnType<typeof setTimeout> = null

function fire(): void {
  lastFired = Date.now()
  $workspaceChangeTick.set($workspaceChangeTick.get() + 1)
}

/** @param changedPath absolute path a tool touched; omit (or pass a relative /
 *  unknowable path) to force a full-tree rescan. */
export function notifyWorkspaceChanged(changedPath?: string): void {
  const dir = changedPath ? dirOf(changedPath) : null

  if (dir) {
    pendingDirs.add(dir)
  } else {
    pendingFull = true
  }

  const since = Date.now() - lastFired

  if (since >= MIN_INTERVAL_MS) {
    if (trailing) {
      clearTimeout(trailing)
      trailing = null
    }

    fire()
  } else if (!trailing) {
    trailing = setTimeout(() => {
      trailing = null
      fire()
    }, MIN_INTERVAL_MS - since)
  }
}

// Tool names that can touch the working tree (everything else — read_file,
// search, web — never does, so it shouldn't trigger a refresh). NB: no bare
// `file` token — it matched the read-only `read_file` / `search_files` /
// `list_files`, firing a git probe on the single most common tool. Real file
// writers carry a verb (`write_file`, `apply_patch`, …) or an inline_diff.
const MUTATING_TOOL_RE =
  /terminal|shell|exec|bash|command|write|edit|patch|replace|apply|create|delete|remove|move|rename|mkdir|format/i

/** True when a finished tool may have changed files (carries a diff, or its
 *  name implies a filesystem/terminal mutation). */
export function toolMayMutateFiles(payload: { name?: unknown; tool?: unknown; inline_diff?: unknown }): boolean {
  if (typeof payload.inline_diff === 'string' && payload.inline_diff.trim()) {
    return true
  }

  const name = String(payload.name ?? payload.tool ?? '')

  return MUTATING_TOOL_RE.test(name)
}

// Common arg keys a single-file writer/mover uses for its target. A hit lets the
// tree target that dir; a miss (terminal, multi-path, odd schema) → full rescan.
const PATH_ARG_KEYS = ['path', 'file_path', 'filename', 'file', 'target_file', 'new_path', 'dest', 'destination']

/** Best-effort absolute path a finished tool touched, from its args — or
 *  undefined (→ full rescan) for terminal/opaque/multi-path mutations. */
export function toolChangedPath(payload: { args?: unknown; arguments?: unknown }): string | undefined {
  const args = payload.args ?? payload.arguments

  if (!args || typeof args !== 'object') {
    return undefined
  }

  const record = args as Record<string, unknown>

  for (const key of PATH_ARG_KEYS) {
    const value = record[key]

    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }

  return undefined
}

// The backend workspace root (from `/api/fs/default-cwd`) — the tree root, the
// terminal's initial cwd, and the git-status/diff base. Loaded once on first use;
// refreshed on reconnect via `resetWorkspaceCwd`.
export const $workspaceCwd = atom<string>('')
export const $workspaceBranch = atom<string>('')
let cwdInflight: Promise<string> | null = null

export function ensureWorkspaceCwd(): Promise<string> {
  const existing = $workspaceCwd.get()

  if (existing) {
    return Promise.resolve(existing)
  }

  if (cwdInflight) {
    return cwdInflight
  }

  cwdInflight = getDefaultCwd()
    .then(({ branch, cwd }) => {
      $workspaceCwd.set(cwd)
      $workspaceBranch.set(branch)

      return cwd
    })
    .catch(() => '')
    .finally(() => {
      cwdInflight = null
    })

  return cwdInflight
}

// What the UI should treat as "the current directory": the FOCUSED chat's
// project directory when it has one, else the backend workspace root.
//
// Focused, not active: with several chats tiled side by side, the one you last
// clicked into is the one the file tree / review / terminal / statusbar should
// be describing. `$currentCwd` only moves when the LEFT SIDEBAR selects a
// session, so surfaces built on it stayed pinned to whatever the sidebar last
// picked no matter which tile you were working in.
//
// Chats can be detached (no cwd), and on a fresh client no chat is open at all —
// both fall back to the root so those surfaces always have somewhere to point,
// rather than going blank (desktop shows an empty hint there instead, but it
// always has a local FS to fall back on).
export const $effectiveCwd: ReadableAtom<string> = computed(
  [$focusedCwd, $workspaceCwd],
  (sessionCwd, workspaceRoot) => sessionCwd.trim() || workspaceRoot
)

export function resetWorkspaceCwd(): void {
  $workspaceCwd.set('')
  $workspaceBranch.set('')
  cwdInflight = null
}
