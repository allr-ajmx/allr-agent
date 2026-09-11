import { getDefaultCwd } from '@/hermes'
import { atom, computed, type ReadableAtom } from '@/store/atom'
import { $activeGatewayProfile } from '@/store/profile'
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
/**
 * The GATEWAY's home directory, from the same `/api/fs/default-cwd` call.
 *
 * The gateway's, not this device's: that is where sessions run, so it is the
 * only "home" the file tree and `cwdForNewSession()` can mean. It is an
 * ADDITIVE field — a frozen older backend omits it and this stays empty, which
 * is what hides the Home button instead of pointing it at nothing.
 */
export const $workspaceHome = atom<string>('')
let cwdInflight: Promise<string> | null = null
/**
 * Bumped by every `resetWorkspaceCwd`, and checked by the fetch before it
 * writes. Without it a reload races its own predecessor: the request that was
 * already in the air when the profile changed still resolves, and lands the
 * PREVIOUS profile's cwd on top of the new one — and its `finally` would clear
 * the successor's `cwdInflight` while that request is still open, so the next
 * caller starts a third. Losing the answer to a question we no longer want is
 * the correct outcome; scope is what makes it wrong, not lateness.
 */
let cwdGeneration = 0

export function ensureWorkspaceCwd(): Promise<string> {
  const existing = $workspaceCwd.get()

  if (existing) {
    return Promise.resolve(existing)
  }

  if (cwdInflight) {
    return cwdInflight
  }

  const generation = cwdGeneration

  cwdInflight = getDefaultCwd()
    .then(({ branch, cwd, home }) => {
      if (generation !== cwdGeneration) {
        return ''
      }

      $workspaceCwd.set(cwd)
      $workspaceBranch.set(branch)
      $workspaceHome.set(home ?? '')

      return cwd
    })
    .catch(() => '')
    .finally(() => {
      if (generation === cwdGeneration) {
        cwdInflight = null
      }
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

/**
 * Point the workspace root somewhere else, by hand.
 *
 * The fallback half of the explorer's folder pick (`store/explorer-path`): with
 * no live session to move, `$effectiveCwd` IS `$workspaceCwd`, so this is the
 * one place the tree's root can be chosen without inventing a second source of
 * truth beside the session's cwd.
 *
 * The branch goes with it. `/api/fs/default-cwd` reports the two together
 * because a branch only means anything for the directory it was read in, and a
 * stale one is worse than none — nothing consumes `$workspaceBranch` today, and
 * the next thing that does should not inherit a lie. A blank path is a no-op
 * rather than a blanking: rooting the tree at `''` is what the empty-state
 * hint is for, not something a click should be able to cause.
 */
export function setWorkspaceCwd(path: string): void {
  const next = path.trim()

  if (!next || next === $workspaceCwd.get()) {
    return
  }

  $workspaceCwd.set(next)
  $workspaceBranch.set('')
}

export function resetWorkspaceCwd(): void {
  $workspaceCwd.set('')
  $workspaceBranch.set('')
  $workspaceHome.set('')
  cwdInflight = null
  cwdGeneration += 1
}

/**
 * Throw the cached root away and ask for it again.
 *
 * `ensureWorkspaceCwd` alone cannot do this: it is a memo, so it returns the
 * value it already has. Forgetting first is the whole point — and an in-flight
 * fetch is dropped with it, because the answer it is about to deliver belongs
 * to the scope we just left.
 */
export function reloadWorkspaceCwd(): Promise<string> {
  resetWorkspaceCwd()

  return ensureWorkspaceCwd()
}

// ---------------------------------------------------------------------------
// The profile sync
//
// `/api/fs/default-cwd` is profile-scoped: it resolves, INSIDE the active
// profile's scope, that profile's active project's primary folder → its
// `terminal.cwd` → the gateway default, and reports that profile's `home`
// alongside. So `$workspaceCwd` / `$workspaceBranch` / `$workspaceHome` are
// per-profile values, and a profile switch leaves all three describing a
// workspace the app is no longer talking to — the file tree, the statusbar cwd
// segment, the terminal's initial directory and the review base all keep
// pointing at the previous profile's folder.
//
// It lives HERE, in the module that owns those three atoms, rather than in the
// file tree that is the most visible consumer: the staleness is global, and the
// tree is only one of four surfaces reading it. It is also why this is not a
// `useOnProfileSwitch` in a component — a right pane that is collapsed, or a
// mobile drawer that is closed, is unmounted, and a reload that only happens
// while somebody is watching is not a reload. Two mounted copies would fire two
// concurrent `getDefaultCwd` calls, too.
//
// Armed by an explicit call from `main.tsx`, never at module scope: this module
// is imported by the statusbar, the contrib controller and the file tree, and a
// module-scope listener attaches once per surface that merely mentions an atom.
// ---------------------------------------------------------------------------

let profileUnsubscribe: null | (() => void) = null

export function initWorkspaceProfileSync(): void {
  if (profileUnsubscribe) {
    return
  }

  // `listen`, not `subscribe`: subscribe fires immediately with the current
  // value, which would throw away a root that had just been fetched (and, at
  // boot, fire a second `getDefaultCwd` on top of the first).
  profileUnsubscribe = $activeGatewayProfile.listen(() => {
    void reloadWorkspaceCwd()
  })
}

export function stopWorkspaceProfileSync(): void {
  profileUnsubscribe?.()
  profileUnsubscribe = null
}

/** Test seam: is the sync armed? */
export function __workspaceProfileSyncActive(): boolean {
  return profileUnsubscribe !== null
}
