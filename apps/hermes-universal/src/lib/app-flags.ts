import { invoke } from '@tauri-apps/api/core'

import { loadString, saveString } from '@/lib/persist'
import { IS_TAURI } from '@/lib/platform'

// Durable, non-secret app flags — the JS half of src-tauri/src/app_state.rs.
//
// These describe THIS INSTALL, not the user's account, and they gate first-run
// UI. That is why they are not `persistentAtom`/localStorage like the rest of
// our UI prefs: web storage belongs to the frontend and is cleared by a webview
// data reset or a user clearing site data, which would resurrect a first-run
// screen the user has already dismissed. Rust owns the value; see the module
// note in app_state.rs for why not the keyring either.
//
// The localStorage branch below is NOT a mirror of the native store — it is the
// whole implementation when there is no Tauri runtime at all (plain-browser
// `vite dev`, vitest/jsdom). In a packaged app it never runs, so the native
// store has no web-storage dependency to clear.

/** Every flag the native store may hold. Adding one is a string here plus a
 *  branch wherever it is read — Rust stores an arbitrary key→bool map. */
export type AppFlag = 'connectWelcomed'

const MIRROR_PREFIX = 'hermes.app-flag.'

/**
 * Read a flag, defaulting to `false`.
 *
 * Never rejects. An unavailable store must not stop a screen from rendering,
 * and "we could not tell" and "not yet" lead to the same UI — at worst a
 * first-run screen appears once more than it should.
 */
export async function getAppFlag(key: AppFlag): Promise<boolean> {
  if (!IS_TAURI) {
    return loadString(`${MIRROR_PREFIX}${key}`) === 'true'
  }

  try {
    return await invoke<boolean>('get_app_flag', { key })
  } catch {
    return false
  }
}

/**
 * Persist a flag.
 *
 * Rejects if the native write fails, so a caller that needs to know can await
 * it — but callers gating a UI transition should fire-and-forget instead, since
 * a slow or failing disk write is not a reason to stall the user.
 */
export async function setAppFlag(key: AppFlag, value: boolean): Promise<void> {
  if (!IS_TAURI) {
    saveString(`${MIRROR_PREFIX}${key}`, value ? 'true' : 'false')

    return
  }

  await invoke<void>('set_app_flag', { key, value })
}
