import { translateNow } from '@/i18n'
import { type Codec, persistentAtom } from '@/lib/persisted'
import { IS_DESKTOP } from '@/lib/platform'
import { atom } from '@/store/atom'
import { notifyError } from '@/store/notifications'

// Background mode — keep Hermes running with its window put away.
//
// A device-local preference (each computer keeps its own), UNANSWERED by
// default — the first close asks. The webview owns the value and persists it;
// Rust owns the two levers that make it real (`set_background_mode`,
// `background.rs`): the flag `RunEvent::ExitRequested` reads, and the tray the
// user needs to get back. The tray's Keep Running row can change the preference
// too, so the traffic runs both ways — see `initBackgroundMode`. Desktop-only —
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
// half as an argument rather than reaching for it, and why the close prompt
// below parks THUNKS rather than reaching for the window verbs itself.

/**
 * The preference, as three states rather than two.
 *
 * `null` — never asked. A boolean cannot say this, and the difference matters at
 * exactly one moment: the first time the user presses the window's close button.
 * Defaulting that to `false` quits an app the user may have wanted resident;
 * defaulting it to `true` hides an app they expected to quit and leaves them
 * hunting for it. So the first close ASKS (see `$backgroundClosePrompt`), and
 * the answer is what writes the value.
 *
 * `true` / `false` — chosen, and honoured silently from then on. Changeable
 * afterwards from Settings and from the tray's Keep Running row.
 */
export type BackgroundMode = boolean | null

/** Absent key = never asked. Anything else decodes to a definite answer, so a
 *  hand-edited or half-written value reads as "close on exit" rather than
 *  quietly re-opening the question. */
const backgroundModeCodec: Codec<BackgroundMode> = {
  decode: raw => raw === 'true',
  encode: value => (value === null ? null : String(value))
}

export const $backgroundMode = persistentAtom<BackgroundMode>('hermes.backgroundMode', null, backgroundModeCodec)

/**
 * What the close guard parked, or null when nothing is waiting on an answer.
 *
 * Thunks rather than a bare flag, for the same reason `store/close-confirm.ts`
 * holds a `close()`: the dialog is a React component and the verbs it needs
 * (hide this window, stop the local backend, destroy this window) live in
 * `store/windows`, which imports THIS module. Parking the actions the guard
 * already has in hand keeps that edge one-way and keeps the dialog from having
 * to know how a window closes.
 */
export interface BackgroundClosePrompt {
  /** "Close Hermes" — tear down for real. */
  close: () => Promise<void> | void
  /** "Keep in Background" — put the window away, process stays. */
  keep: () => Promise<void> | void
}

export const $backgroundClosePrompt = atom<BackgroundClosePrompt | null>(null)

/** Ask the question. One prompt at a time: a second close request while the
 *  dialog is up is the same question, and replacing the thunks under it would
 *  answer the newer close and silently drop the older one. */
export function requestBackgroundClosePrompt(prompt: BackgroundClosePrompt): void {
  if ($backgroundClosePrompt.get()) {
    return
  }

  $backgroundClosePrompt.set(prompt)
}

export function dismissBackgroundClosePrompt(): void {
  $backgroundClosePrompt.set(null)
}

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

/** Mirror `on` down and settle the atom on what came back. Never rejects — the
 *  outcome IS the return value, because "refused" is a normal answer here. */
async function reconcile(on: boolean): Promise<boolean> {
  const mine = ++generation

  try {
    const active = await applyBackgroundMode(on)

    if (generation === mine && active !== on) {
      $backgroundMode.set(active)
    }

    return active
  } catch (error) {
    // Superseded: the newer ask reports its own outcome, and two toasts for one
    // switch would only confuse.
    if (generation !== mine) {
      return $backgroundMode.get() === true
    }

    // The ask did not take, so we are where we were. A refused arm means the
    // window is still the process — and a switch left reading "on" over an app
    // that quits when you close it is the exact promise this must not make.
    $backgroundMode.set(!on)

    notifyError(error, translateNow('settings.config.backgroundModeFailed'))

    return !on
  }
}

export function setBackgroundMode(on: boolean): void {
  void commitBackgroundMode(on)
}

/**
 * Set the preference and answer with what is ACTUALLY in force afterwards.
 *
 * The awaited form of `setBackgroundMode`, for the caller that cannot fire and
 * forget: the close prompt's "Keep in Background" has to know whether the
 * machine agreed BEFORE it hides the window. Hiding on a machine that refused —
 * no system tray, so no way back — is the one outcome this feature must never
 * produce.
 */
export async function commitBackgroundMode(on: boolean): Promise<boolean> {
  $backgroundMode.set(on)

  return await reconcile(on)
}

/** Unset counts as off, so the first toggle arms. */
export function toggleBackgroundMode(): void {
  setBackgroundMode($backgroundMode.get() !== true)
}

/**
 * Announced by Rust when the tray's Keep Running row is clicked, carrying the
 * new state. Must match `BACKGROUND_MODE_CHANGED_EVENT` in
 * `src-tauri/src/tray.rs`.
 */
export const BACKGROUND_MODE_CHANGED_EVENT = 'hermes://background-mode-changed'

/**
 * Re-assert the persisted preference once at startup, and follow the tray.
 *
 * `BackgroundState` is process-local and starts unset, so a relaunch has to
 * mirror an ANSWERED preference down again or the switch reads "on" over an app
 * that quits on close. A preference nobody has given yet mirrors nothing: there
 * is no answer to assert, and staying quiet keeps a boot on a machine with no
 * tray from opening with a toast about a lever the user never pulled.
 *
 * The listener is the other direction. The tray row can change this preference
 * while the window is hidden — and Rust has already applied it by the time the
 * event arrives, so the atom is set DIRECTLY rather than through `reconcile`:
 * mirroring it back down would be an ask that answers itself, and a refusal on
 * that round trip would flip a switch the user is looking at.
 */
export function initBackgroundMode(): void {
  void listenForTrayToggle()

  if ($backgroundMode.get() === null) {
    return
  }

  void reconcile($backgroundMode.get() === true)
}

async function listenForTrayToggle(): Promise<void> {
  if (!IS_DESKTOP) {
    return
  }

  try {
    const { listen } = await import('@tauri-apps/api/event')

    await listen<boolean>(BACKGROUND_MODE_CHANGED_EVENT, event => {
      // Emitted app-wide, so guard the payload rather than the sender: any
      // window may hear it, and only a definite boolean is an answer.
      if (typeof event.payload === 'boolean') {
        $backgroundMode.set(event.payload)
      }
    })
  } catch {
    // No Tauri runtime here — there is no tray to follow either.
  }
}

/** The window `tauri.conf.json` declares. Must agree with `MAIN_WINDOW_LABEL` in
 *  `src-tauri/src/window.rs`, which refuses to hide anything else. */
const MAIN_WINDOW_LABEL = 'main'

/**
 * What background mode makes of a close request — `null` when it makes nothing
 * of it and the window closes the ordinary way.
 *
 *  * `hide` — put the window away, keep the process. The preference says so.
 *  * `ask`  — the preference is unanswered; put the question on screen and let
 *             the answer finish the close.
 *
 * A preference of `false` deliberately answers `null` rather than a third
 * action. "Close means close" is not a background-mode behaviour, it is the
 * absence of one — the window is destroyed, and the process ends with it only if
 * it was the last one. Making that branch quit the APP would take any other open
 * instance window down with it, which is a thing this preference never promised
 * to do. The one place a close DOES end everything is the prompt's "Quit
 * Hermes", where the user asked for it in those words.
 *
 * ONE function rather than a predicate per state, because the window test below
 * is the part that must not drift: a window asked a question its close does not
 * honour is worse than a window that never asks.
 *
 * **Only `main` gets any of this.** A hidden window is reachable through exactly
 * one affordance — the tray's Show Hermes — and that resolves to `main`, or to
 * the lowest surviving instance, or to a freshly built `main`
 * (`window_to_reveal`). So a hidden `instance-2` would be a window that exists,
 * holds a session, and has nothing anywhere that can bring it back. Pop-out
 * instances therefore close for real, exactly as they always have; the process
 * still survives them, because `ExitRequested` is what holds it open and the
 * tray rebuilds `main` from nothing.
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
export type BackgroundCloseAction = 'ask' | 'hide'

export function backgroundCloseAction(label: string, ownsAppState: boolean): BackgroundCloseAction | null {
  if (!IS_DESKTOP || label !== MAIN_WINDOW_LABEL || !ownsAppState) {
    return null
  }

  const mode = $backgroundMode.get()

  if (mode === null) {
    return 'ask'
  }

  return mode ? 'hide' : null
}
