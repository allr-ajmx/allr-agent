import { translateNow } from '@/i18n'
import { Codecs, persistentAtom } from '@/lib/persisted'
import { IS_DESKTOP } from '@/lib/platform'
import { notifyError } from '@/store/notifications'

// Background mode — keep Hermes running with its window put away.
//
// A device-local preference (each computer keeps its own), off by default. The
// webview owns the value and persists it; Rust owns the two levers that make it
// real (`set_background_mode`, `background.rs`): the flag `RunEvent::
// ExitRequested` reads, and the tray the user needs to get back. Desktop-only —
// a phone has one surface, nothing to hide behind and no tray to summon from, so
// this is a no-op there and the Settings row is not rendered at all.
//
// Same shape as `keep-awake.ts`, deliberately, and for the same reason: the atom
// tracks what is ACTUALLY in force, not what was asked for. Arming is a request
// the machine can refuse — a bare wlroots session with no StatusNotifier host
// gets no tray, and hiding the window there would leave a live process with no
// window, no icon and no menu to reach it with. A refusal therefore flips the
// preference back off and says so, and close goes back to meaning quit.
//
// IMPORTS ARE LOAD-BEARING. This module must never import `@/store/windows`:
// `windows.ts` imports THIS one for `backgroundCloseTakesOver`, so the edge only
// goes one way. That is also why the predicate takes its `ownsPersistedAppState`
// half as an argument rather than reaching for it.
export const $backgroundMode = persistentAtom<boolean>('hermes.backgroundMode', false, Codecs.bool)

/**
 * Mirror the preference down to Rust; resolves with what is in force afterwards.
 *
 * Off desktop there is no lever and no controls, so the ask is reported back
 * verbatim rather than being treated as a failure — the code path exists,
 * nothing is invoked, nothing throws (the `applyKeepAwake` idiom). Everything
 * else — a missing Tauri runtime, a machine with no tray — throws, because the
 * caller has to be able to tell "resident" from "quietly not resident".
 */
export async function applyBackgroundMode(on: boolean): Promise<boolean> {
  if (!IS_DESKTOP) {
    return on
  }

  const { invoke } = await import('@tauri-apps/api/core')

  return await invoke<boolean>('set_background_mode', { on })
}

// Only the newest ask may correct the atom. Without this a slow reply to an
// earlier toggle would land after a later one and undo it.
let generation = 0

function reconcile(on: boolean): void {
  const mine = ++generation

  void applyBackgroundMode(on)
    .then(active => {
      if (generation === mine && active !== on) {
        $backgroundMode.set(active)
      }
    })
    .catch((error: unknown) => {
      // Superseded: the newer ask reports its own outcome, and two toasts for one
      // switch would only confuse.
      if (generation !== mine) {
        return
      }

      // The ask did not take, so we are where we were. A refused arm means the
      // window is still the process — and a switch left reading "on" over an app
      // that quits when you close it is the exact promise this must not make.
      $backgroundMode.set(!on)

      notifyError(error, translateNow('settings.config.backgroundModeFailed'))
    })
}

export function setBackgroundMode(on: boolean): void {
  $backgroundMode.set(on)
  reconcile(on)
}

export function toggleBackgroundMode(): void {
  setBackgroundMode(!$backgroundMode.get())
}

/**
 * Re-assert the persisted preference once at startup.
 *
 * `BackgroundState` is process-local and starts false, so a relaunch has to
 * mirror the preference down again or the switch reads "on" over an app that
 * quits on close. Nothing to do when it is off — that is already Rust's state —
 * and skipping it keeps a boot on a machine with no tray from opening with a
 * toast about a lever the user never pulled.
 */
export function initBackgroundMode(): void {
  if (!$backgroundMode.get()) {
    return
  }

  reconcile(true)
}

/** The window `tauri.conf.json` declares. Must agree with `MAIN_WINDOW_LABEL` in
 *  `src-tauri/src/window.rs`, which refuses to hide anything else. */
const MAIN_WINDOW_LABEL = 'main'

/**
 * Whether a close request on `label` means "hide" rather than "close".
 *
 * **Only `main`.** A hidden window is reachable through exactly one affordance —
 * the tray's Show Hermes — and that resolves to `main`, or to the lowest
 * surviving instance, or to a freshly built `main` (`window_to_reveal`). So a
 * hidden `instance-2` would be a window that exists, holds a session, and has
 * nothing anywhere that can bring it back. Pop-out instances therefore close for
 * real, exactly as they do today; the process still survives them, because
 * `ExitRequested` is what holds it open and the tray rebuilds `main` from
 * nothing.
 *
 * `main` is also the window that has to survive rather than be rebuilt: hiding
 * keeps the webview, so a reveal comes back to the same turn still streaming.
 * Destroying and re-creating it would reap its sockets (`reap_window_sockets`)
 * and re-hydrate the transcript, which is the failure the epic calls out by name.
 *
 * `ownsAppState` is `ownsPersistedAppState()`, passed in rather than imported —
 * see the module note on the import direction. Redundant with the label check by
 * construction and kept anyway: it is the predicate the rest of the app already
 * uses for "is this window the app", and the two agreeing is cheaper than
 * finding out they stopped.
 */
export function backgroundCloseTakesOver(label: string, ownsAppState: boolean): boolean {
  return IS_DESKTOP && label === MAIN_WINDOW_LABEL && ownsAppState && $backgroundMode.get()
}
