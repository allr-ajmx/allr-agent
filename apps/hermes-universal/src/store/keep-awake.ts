import { Codecs, persistentAtom } from '@/lib/persisted'
import { IS_DESKTOP } from '@/lib/platform'

// Keep-awake — stop the machine sleeping through a long, unattended run.
//
// A device-local preference (each computer keeps its own), off by default. The
// webview owns the value and persists it; Rust holds the one native inhibitor
// (`set_keep_awake`, keep_awake.rs) and re-arms it from `initKeepAwake()` at
// boot. Desktop-only: phones sleep on their own terms, so this is a no-op there
// and the UI hides the controls.
export const $keepAwake = persistentAtom<boolean>('hermes.keepAwake', false, Codecs.bool)

export async function applyKeepAwake(on: boolean): Promise<void> {
  if (!IS_DESKTOP) {
    return
  }

  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('set_keep_awake', { on })
  } catch {
    // No Rust command / platform can't inhibit sleep. The preference still reads
    // back, and nothing the user is doing depends on this succeeding.
  }
}

export function setKeepAwake(on: boolean): void {
  $keepAwake.set(on)
  void applyKeepAwake(on)
}

export function toggleKeepAwake(): void {
  setKeepAwake(!$keepAwake.get())
}

/** Re-assert the persisted preference once at startup. */
export function initKeepAwake(): void {
  void applyKeepAwake($keepAwake.get())
}
