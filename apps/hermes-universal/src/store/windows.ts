import { supportsMultipleWindows } from '@tauri-apps/api/app'
import { invoke } from '@tauri-apps/api/core'

import { IS_DESKTOP, IS_IOS } from '@/lib/platform'
import { notifyError } from '@/store/notifications'

// Ported from desktop `store/windows.ts`. Desktop opens native windows through an
// Electron preload bridge; universal invokes Rust commands (see
// `src-tauri/src/window.rs`) that build a Tauri `WebviewWindow`. A secondary
// (single-chat) window carries `?win=secondary` in its URL — placed BEFORE the
// HashRouter `#`, so it lives in `location.search` — and `?watch=1` marks a
// spectator window. `isSecondaryWindow()` scopes layout/tiles/bubbles/composer-
// popout persistence to the primary window (see its consumers in
// `pane-shell/tree/store.ts`, `session-states.ts`, `chat-bubbles.ts`, and the
// composer popout/metrics hooks).

const SECONDARY_WINDOW_FLAG = 'secondary'

let secondaryWindowCache: boolean | null = null

export function isSecondaryWindow(): boolean {
  if (secondaryWindowCache !== null) {
    return secondaryWindowCache
  }

  let result = false

  try {
    result = new URLSearchParams(window.location.search).get('win') === SECONDARY_WINDOW_FLAG
  } catch {
    result = false
  }

  secondaryWindowCache = result

  return result
}

let watchWindowCache: boolean | null = null

export function isWatchWindow(): boolean {
  if (watchWindowCache !== null) {
    return watchWindowCache
  }

  let result = false

  try {
    result = new URLSearchParams(window.location.search).get('watch') === '1'
  } catch {
    result = false
  }

  watchWindowCache = result

  return result
}

// Native multi-window is supported on desktop and on iOS via UIScene (MJX-142) —
// a session opens as its own scene (side-by-side on iPad, replacing on iPhone).
// Android (Activity embedding, MJX-141) is still gated off. iOS is gated on the
// runtime `supportsMultipleWindows()` (== UIApplication.supportsMultipleScenes):
// single-scene devices fall back to the in-app view. That value resolves async, so
// we default to allowed and only flip off if the runtime reports single-scene —
// the affordance shows immediately on iPad and never flickers there.
let iosSceneCapable = true

if (IS_IOS) {
  supportsMultipleWindows()
    .then((ok) => {
      iosSceneCapable = ok
    })
    .catch(() => {
      // Leave the default: if the query fails, still offer the affordance; the
      // Rust build degrades gracefully (attaches to the main scene) if unsupported.
    })
}

function multiWindowSupported(): boolean {
  return IS_DESKTOP || (IS_IOS && iosSceneCapable)
}

// A secondary window is already a pop-out, so it never offers to open another —
// this hides the affordance in the pop-out's title menu / composer status stack.
export function canOpenSessionWindow(): boolean {
  return multiWindowSupported() && !isSecondaryWindow()
}

export function canOpenNewWindow(): boolean {
  return multiWindowSupported() && !isSecondaryWindow()
}

async function runWindowOpen(call: () => Promise<unknown>, failMessage: string): Promise<void> {
  try {
    await call()
  } catch (err) {
    notifyError(err, failMessage)
  }
}

export async function openSessionInNewWindow(sessionId: string, opts?: { watch?: boolean }): Promise<void> {
  if (!sessionId || !canOpenSessionWindow()) {
    return
  }

  await runWindowOpen(
    () => invoke('open_session_window', { sessionId, watch: opts?.watch ?? false }),
    'Could not open chat in a new window'
  )
}

export async function openNewWindow(): Promise<void> {
  if (!canOpenNewWindow()) {
    return
  }

  await runWindowOpen(() => invoke('open_instance_window'), 'Could not open a new window')
}
