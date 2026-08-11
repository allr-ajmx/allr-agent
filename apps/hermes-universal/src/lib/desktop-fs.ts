import { open as openDialog } from '@tauri-apps/plugin-dialog'

import { writeClipboardText } from '@/components/ui/copy-button'
import { getDefaultCwd, getFileDiff, getGitRoot, readDir, readFileDataUrl, readFileText, writeFileText } from '@/hermes'
import { translateNow } from '@/i18n'
import { IS_DESKTOP } from '@/lib/platform'
import { $connection } from '@/store/connection'
import { type Connection, connectionCacheKey } from '@/store/gateway-config'
import type { ReadDirResult, ReadFileTextResult } from '@/types/hermes'

// Ported from apps/desktop/src/lib/desktop-fs.ts — its REMOTE branch only.
// Desktop reads the filesystem through Electron when it owns the disk and falls
// back to the dashboard REST API (`/api/fs/*`) whenever the gateway is remote.
// Universal is always the remote case: the gateway owns the workspace, so every
// read/write here is REST and `isDesktopFsRemoteMode()` is unconditionally true.
//
// The three local-only Electron operations (reveal in the OS file manager,
// rename in place, move to trash) have no REST equivalent. They throw a clear
// error rather than silently no-op'ing; callers already gate them on
// `isDesktopFsRemoteMode()`, which is exactly how desktop hides them on a
// remote gateway.

// Mirrors desktop's HermesSelectPathsOptions (global.d.ts).
export interface SelectPathsOptions {
  title?: string
  defaultPath?: string
  directories?: boolean
  multiple?: boolean
  filters?: Array<{ name: string; extensions: string[] }>
}

export interface DesktopFsRemotePicker {
  selectPaths: (options?: SelectPathsOptions) => Promise<string[]>
}

let remotePicker: DesktopFsRemotePicker | null = null

export function setDesktopFsRemotePicker(next: DesktopFsRemotePicker | null) {
  remotePicker = next
}

/** Cache key so per-connection FS caches don't leak across gateways.
 *
 *  Delegates to {@link connectionCacheKey}, which keys ssh connections on their
 *  ownership id rather than the baseUrl — an ssh baseUrl carries a fresh
 *  ephemeral port on every re-tunnel, so keying on it would discard the whole
 *  file tree on each reconnect to the very same backend. */
export function desktopFsCacheKey() {
  return connectionCacheKey($connection.get())
}

export function isDesktopFsRemoteMode() {
  return true
}

export function desktopFsProfile(): string | undefined {
  return $connection.get()?.profile || undefined
}

function unavailable(): never {
  throw new Error(translateNow('rightSidebar.remoteUnsupported'))
}

export async function readDesktopDir(path: string): Promise<ReadDirResult> {
  return readDir(path)
}

export async function readDesktopFileText(path: string): Promise<ReadFileTextResult> {
  return readFileText(path)
}

export async function writeDesktopFileText(path: string, content: string): Promise<{ path: string }> {
  const result = await writeFileText(path, content)

  return { path: result.path ?? path }
}

export async function readDesktopFileDataUrl(path: string): Promise<string> {
  const result = await readFileDataUrl(path)

  return result.dataUrl || ''
}

export async function desktopGitRoot(path: string): Promise<string | null> {
  return (await getGitRoot(path)).root
}

export async function desktopDefaultCwd(): Promise<{ branch: string; cwd: string } | null> {
  const result = await getDefaultCwd()

  return result ? { branch: result.branch ?? '', cwd: result.cwd ?? '' } : null
}

/** Reveal a path in the OS file manager — local only, so unavailable here. */
export async function revealDesktopPath(_path: string): Promise<void> {
  unavailable()
}

/** Rename a file/folder in place — local only, so unavailable here. */
export async function renameDesktopPath(_path: string, _newName: string): Promise<string> {
  unavailable()
}

/** Move a file/folder to the OS trash — local only, so unavailable here. */
export async function trashDesktopPath(_path: string): Promise<void> {
  unavailable()
}

export async function copyTextToClipboard(text: string): Promise<void> {
  await writeClipboardText(text)
}

// Working-tree-vs-HEAD diff for one file. Empty when unchanged / not a repo.
export async function desktopFileDiff(repoRoot: string, filePath: string): Promise<string> {
  return (await getFileDiff(repoRoot, filePath)).diff || ''
}

/**
 * True when this window's OS filesystem IS the gateway's — a Tauri desktop
 * talking to a backend it spawned itself (`mode: 'local'`).
 *
 * `ssh` is deliberately excluded even though it authenticates like local: the
 * tunnel terminates on ANOTHER host's filesystem. So are `remote`/`cloud`, and
 * so is a connection with no mode at all (treated as remote everywhere else
 * too — see `modeIsRemoteLike` in store/gateway-config.ts).
 *
 * `connection` is a parameter so a React caller can hand over the value it
 * already subscribes to (`useStore($connection)`) and re-render when the
 * gateway switches, instead of re-deriving `mode === 'local'` on the side — a
 * second copy of this rule is exactly how the two drift apart.
 */
export function gatewayOwnsLocalFs(connection: Connection | null = $connection.get()): boolean {
  return IS_DESKTOP && connection?.mode === 'local'
}

/**
 * Pick paths, remote-aware. A directory pick uses the native OS dialog only
 * when {@link gatewayOwnsLocalFs}; everything else browses the BACKEND
 * filesystem through the registered remote picker, since that's where sessions
 * actually run — and where every path the app then hands the gateway (a project
 * folder, its IDEA.md, a worktree root) is resolved.
 *
 * Handing a locally-picked path to a gateway on another machine is worse than a
 * dead path: `/home/me/work` very often exists on both, so the backend silently
 * reads and writes the WRONG directory.
 *
 * Empty when nothing is registered and there is no native dialog (plain web,
 * vitest), which callers treat the same as "cancelled".
 */
export async function selectDesktopPaths(options?: SelectPathsOptions): Promise<string[]> {
  if (options?.directories && gatewayOwnsLocalFs()) {
    try {
      const dir = await openDialog({ defaultPath: options.defaultPath, directory: true, multiple: false })

      return typeof dir === 'string' ? [dir] : []
    } catch {
      return []
    }
  }

  return remotePicker ? remotePicker.selectPaths({ ...options, multiple: false }) : []
}

/**
 * Pick paths on the BACKEND filesystem, unconditionally — no native-dialog
 * shortcut. For callers where the user chose "remote" explicitly (composer
 * attach menu), so a directory pick must not fall into `selectDesktopPaths`'s
 * local OS dialog branch. Empty when no picker is registered.
 */
export async function selectRemotePaths(options?: SelectPathsOptions): Promise<string[]> {
  return remotePicker ? remotePicker.selectPaths({ ...options, multiple: false }) : []
}
