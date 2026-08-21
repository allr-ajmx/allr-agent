// App foreground/background, as one signal instead of a dozen.
//
// Neither phone gives this app any background execution — there is no
// `UIBackgroundModes` in `Info.ios.plist`, no `onResume` override in
// `MainActivity.kt`, and `INTERNET` is the only permission the Android manifest
// asks for. So the gateway socket ALWAYS dies while the app is away, and the
// process itself is killed sooner or later. A fast, silent restore on the way
// back is the only strategy available; keeping the connection alive is not on
// the table.
//
// Nothing turned "the app came back" into an event before this. The Rust side
// sees `RunEvent::WindowEvent{Focused(false)}` (src-tauri/src/lib.rs) but never
// forwards it, and the webview half was ~12 files each registering their own
// `visibilitychange` listener for their own feature. This module is deliberately
// NOT a migration of those — it exists so connection recovery has one place to
// hang off, and so the ordering between "we are going away" and "we are back" is
// decided once.
//
// `visibilitychange` is the signal that actually fires on both platforms. The
// `pagehide` companion is for the teardown half only: on mobile a task-switch or
// a quit does not reliably fire it (see store/panes.ts, which learned the same
// thing), so it is a supplement to the hidden transition rather than a
// replacement for it.

type Listener = () => void

const foregroundListeners = new Set<Listener>()
const backgroundListeners = new Set<Listener>()

let installed = false
// Tracks the last edge we DELIVERED, so a duplicate signal — `visibilitychange`
// to hidden followed by `pagehide`, which is the common mobile sequence — fires
// the background listeners once rather than twice.
let foregrounded = true

function deliver(listeners: Set<Listener>): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch {
      // One listener's failure must not strand the others. Nothing here is
      // recoverable from this side, and a lifecycle edge is not a place to
      // surface an error to the user.
    }
  }
}

function toForeground(): void {
  if (foregrounded) {
    return
  }

  foregrounded = true
  deliver(foregroundListeners)
}

function toBackground(): void {
  if (!foregrounded) {
    return
  }

  foregrounded = false
  deliver(backgroundListeners)
}

/** Run `fn` when the app comes back to the front. Returns a teardown. */
export function onForeground(fn: Listener): () => void {
  foregroundListeners.add(fn)

  return () => foregroundListeners.delete(fn)
}

/** Run `fn` when the app goes away. Returns a teardown.
 *
 *  Keep the work SYNCHRONOUS and short: the process can be suspended immediately
 *  after this returns, and anything awaited may simply never run. */
export function onBackground(fn: Listener): () => void {
  backgroundListeners.add(fn)

  return () => backgroundListeners.delete(fn)
}

/**
 * Install the document listeners. Idempotent, so a StrictMode double-mount or a
 * second caller cannot end up with two sets.
 */
export function initAppLifecycle(): void {
  if (installed || typeof document === 'undefined') {
    return
  }

  installed = true
  foregrounded = document.visibilityState === 'visible'

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      toForeground()
    } else {
      toBackground()
    }
  })

  // Teardown only — see the header. A `pagehide` that follows the hidden
  // transition is collapsed by the edge guard above.
  window.addEventListener('pagehide', toBackground)
}

/** Test seam: drop every listener and let `initAppLifecycle` install again. */
export function resetAppLifecycleForTest(): void {
  foregroundListeners.clear()
  backgroundListeners.clear()
  installed = false
  foregrounded = true
}
