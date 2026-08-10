import { IS_TAURI } from '@/lib/platform'

// Reveal a filesystem path in the OS file manager (Finder/Explorer/Files) via
// the native `reveal_in_file_manager` command, reporting whether the OS took it.
// False off Tauri (plain-web dev / vitest) and on mobile, where there is no file
// manager to reveal into. Callers should only surface this on desktop with a
// local backend — the path must exist on THIS machine's disk (a remote backend's
// cwd doesn't).
export async function tryRevealPathInFileManager(path: string): Promise<boolean> {
  if (!IS_TAURI) {
    return false
  }

  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('reveal_in_file_manager', { path })

    return true
  } catch {
    return false
  }
}

// Fire-and-forget twin for UI callers (menu items, buttons) that have nothing to
// say about a failure. Same command, result dropped.
export async function revealPathInFileManager(path: string): Promise<void> {
  await tryRevealPathInFileManager(path)
}
