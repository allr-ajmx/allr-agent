/**
 * OS-level hotkeys, driven by the same rebindable registry as everything else
 * (MJXHRM-55).
 *
 * An in-app keybind only fires when Hermes has focus. A summonable surface — the
 * HUD, whatever comes after it — has to answer while the user is in another
 * application entirely, which means claiming the chord from the operating system.
 * That claim is exclusive and global, so it is the one kind of shortcut a user
 * MUST be able to change: it takes the chord away from every other app on the
 * machine. Hence no hardcoded accelerator anywhere — an action opts in with
 * `global: true` in `lib/keybinds/actions.ts`, and whatever `$bindings` says its
 * combo is right now is what gets registered.
 *
 * **The claim itself lives in Rust** (`src-tauri/src/shortcuts.rs`, MJXHRM-437).
 * This module decides WHAT should be held and hands the whole set over; the
 * backend is the registrar. That split is what makes the chord survive background
 * mode: the plugin's registry is per PROCESS while a webview's handler channel
 * belongs to its WINDOW, so a claim made from here died with whichever window
 * happened to win the race for it — and background mode's normal state is one
 * hidden window, or none at all. It also puts the claim somewhere no webview
 * scheduler can throttle, and makes a summon with zero windows possible: Rust
 * parks the action and builds a host for it.
 *
 * Desktop only. Neither mobile OS lets an app claim a system-wide chord, and the
 * commands answer `unsupported_platform` there, so the whole module stands down
 * on `IS_DESKTOP`.
 */

import type * as TauriCoreModule from '@tauri-apps/api/core'

import { translateNow } from '@/i18n'
import { globalKeybindActions } from '@/lib/keybinds/actions'
import { acceleratorFromCombo, formatCombo } from '@/lib/keybinds/combo'
import { Codecs, persistentAtom } from '@/lib/persisted'
import { IS_DESKTOP } from '@/lib/platform'
import { $bindings, bindingsFor } from '@/store/keybinds'
import { notify } from '@/store/notifications'
import { openAppRoute } from '@/store/windows'

type TauriCore = typeof TauriCoreModule

/** How a fired accelerator reaches its action. Set by the keybind hook, which is
 *  where the handler map lives — this module deliberately knows no actions. */
let dispatch: (actionId: string) => void = () => undefined

let syncing = false
let resync = false

/**
 * The IPC entrypoint, imported once.
 *
 * Dynamic because this module is loaded on mobile and on the web too, where
 * `@tauri-apps/api` has nothing to talk to — and shared because `boot` starts a
 * sync and a pending-drain in the same tick, and two of them racing the same
 * module load is a needless round trip on the one path whose whole point is that
 * it answers immediately.
 */
let core_: null | Promise<TauriCore> = null

function core(): Promise<TauriCore> {
  core_ ??= import('@tauri-apps/api/core')

  return core_
}

export function setGlobalShortcutDispatch(fn: (actionId: string) => void): void {
  dispatch = fn
}

/**
 * Rust's delivery of a chord that fired, addressed at ONE window
 * (`shortcuts::GLOBAL_SHORTCUT_EVENT`).
 */
const GLOBAL_SHORTCUT_EVENT = 'hermes://global-shortcut'

/** One accelerator to hold, as `global_shortcuts_sync` takes it. */
interface ShortcutClaim {
  accelerator: string
  actionId: string
  combo: string
}

/** What the sync achieved, in COMBOS — an accelerator is the OS's spelling. */
interface ShortcutSync {
  /** Combos the OS granted in this pass. Not what was asked for: a chord another
   *  application owns was never taken, and one this process already held is not
   *  news. This is what the first-run disclosure is allowed to name. */
  granted: string[]
  /** Combos the OS refused, so the console can say which and why nothing happened. */
  refused: string[]
}

/** What one accelerator stands for: the action it fires, and the combo the user
 *  actually typed — an accelerator is the OS's spelling and unfit to show. */
interface WantedClaim {
  actionId: string
  combo: string
}

/** The accelerators that SHOULD be claimed right now. An action with no binding,
 *  or one the OS can't take, simply isn't in the map. */
function desiredAccelerators(): Map<string, WantedClaim> {
  const wanted = new Map<string, WantedClaim>()

  for (const action of globalKeybindActions()) {
    for (const combo of bindingsFor(action.id)) {
      const accelerator = acceleratorFromCombo(combo)

      // First writer wins, so two actions bound to one chord resolve the same
      // way the in-app dispatcher resolves them — and the same way
      // `diff_claims` resolves them on the other side of the boundary.
      if (accelerator && !wanted.has(accelerator)) {
        wanted.set(accelerator, { actionId: action.id, combo })
      }
    }
  }

  return wanted
}

/**
 * Whether the user has been told that Hermes takes a chord away from the rest of
 * the machine.
 *
 * Device-local (`lib/persisted`, like the Quick Entry switch and keep-awake),
 * because the claim is a property of THIS computer's window system, not of the
 * profile: the same account on a phone claims nothing.
 */
export const $globalShortcutsDisclosed = persistentAtom<boolean>('hermes.globalShortcutsDisclosed', false, Codecs.bool)

/** Where the notice sends the user to take the chord back. */
const SHORTCUTS_ROUTE = '/settings/shortcuts'

/**
 * Say, once ever, which chords Hermes just took from the operating system.
 *
 * `view.toggleHud` ships bound to `mod+shift+h` with `global: true`, so this
 * claim happens at BOOT, before the user has done anything — the one capability
 * in the app that reaches outside its own window and takes something away from
 * every other application on the machine. It is the kind of thing a user has to
 * be able to find out about without reading the source.
 *
 * Fired on a claim the OS actually GRANTED, not on the attempt: a chord another
 * app already owns was never taken, and saying otherwise would be a lie the user
 * cannot check. It carries no auto-dismiss for the same reason a consent notice
 * does not — a first-run toast that expires in five seconds while the app is
 * still painting has told nobody anything.
 */
function discloseGlobalClaim(combos: string[]): void {
  if (combos.length === 0 || $globalShortcutsDisclosed.get()) {
    return
  }

  $globalShortcutsDisclosed.set(true)

  notify({
    action: {
      label: translateNow('keybinds.globalClaimAction'),
      onClick: () => openAppRoute(SHORTCUTS_ROUTE)
    },
    durationMs: 0,
    kind: 'info',
    message: translateNow('keybinds.globalClaimMessage', combos.map(formatCombo).join(', ')),
    title: translateNow('keybinds.globalClaimTitle')
  })
}

/**
 * Hand Rust the whole set of accelerators that should be held right now.
 *
 * The backend reconciles — releases what is gone, claims what is new, leaves an
 * unchanged claim alone — so this sends the desired state rather than a delta,
 * and nothing on this side remembers what is registered. That is deliberate:
 * every full app window runs this at boot, and a per-window memory of "what I
 * claimed" is exactly what made the claim die with a window.
 *
 * Serialized. A rebind can arrive while a sync is in flight, and two overlapping
 * syncs would hand the registrar two different desired states in an order
 * neither of them chose. A pending flag re-runs once instead.
 */
export async function syncGlobalShortcuts(): Promise<void> {
  if (!IS_DESKTOP) {
    return
  }

  if (syncing) {
    resync = true

    return
  }

  syncing = true

  try {
    const { invoke } = await core()

    const claims: ShortcutClaim[] = [...desiredAccelerators()].map(([accelerator, wanted]) => ({
      accelerator,
      actionId: wanted.actionId,
      combo: wanted.combo
    }))

    const { granted, refused } = await invoke<ShortcutSync>('global_shortcuts_sync', { claims })

    if (refused.length > 0) {
      // Another application already owns the chord. That is a legitimate outcome
      // of a global claim, not a failure of ours — the in-app binding still
      // works, so say it once and move on.
      console.warn('[keybinds] global shortcut unavailable', refused.join(', '))
    }

    discloseGlobalClaim(granted)
  } catch (err) {
    // No Tauri runtime, or the command refused. Nothing is claimed, so nothing
    // is stolen — but stay quiet about a success that did not happen.
    console.warn('[keybinds] could not sync global shortcuts', err)
  } finally {
    syncing = false

    if (resync) {
      resync = false
      void syncGlobalShortcuts()
    }
  }
}

/**
 * Take the chord that fired before this window existed.
 *
 * A cold summon: the process was resident with everything hidden, or the last
 * window had just gone. Rust parks the action in a one-slot register and builds
 * `main` hidden; this is the other half. Read-and-clear on the backend, so a
 * second window booting behind this one finds nothing and the chord cannot be
 * replayed on a later launch.
 *
 * Awaited rather than fire-and-forget so a failure is reported instead of
 * becoming an unhandled rejection — and so the tests can prove the drain happened
 * at all.
 */
async function drainPendingShortcut(): Promise<void> {
  if (!IS_DESKTOP) {
    return
  }

  try {
    const { invoke } = await core()
    const actionId = await invoke<null | string>('global_shortcut_take_pending')

    if (actionId) {
      dispatch(actionId)
    }
  } catch (err) {
    console.warn('[keybinds] could not drain a pending global shortcut', err)
  }
}

/**
 * Listen for the chord Rust decided THIS window should answer.
 *
 * Targeted at our own label, and that is load-bearing rather than tidy. Tauri
 * filters an `emit_to` against the target each listener registered with, and the
 * JS default (`{ kind: 'Any' }`) matches nothing an `emit_to` sends — a plain
 * `listen(EVENT, handler)` here would receive the chord never, silently, with the
 * backend reporting a successful emit. Naming the label is what puts this window
 * in `AppManager::emit_to`'s filter.
 *
 * The other direction matters too: Rust picks ONE window on purpose. A broadcast
 * would have every full app window run `toggleHud`, summoning the HUD and
 * dismissing it again in a single keypress.
 */
async function listenForDelivery(): Promise<null | (() => void)> {
  if (!IS_DESKTOP) {
    return null
  }

  try {
    const [{ listen }, { getCurrentWebviewWindow }] = await Promise.all([
      import('@tauri-apps/api/event'),
      import('@tauri-apps/api/webviewWindow')
    ])

    return await listen<{ actionId: string }>(GLOBAL_SHORTCUT_EVENT, event => dispatch(event.payload.actionId), {
      target: getCurrentWebviewWindow().label
    })
  } catch {
    // No window system here — nothing claimed the chord, so nothing will deliver.
    return null
  }
}

/**
 * Keep the OS registrations following the registry for as long as the app is up.
 *
 * The returned disposer no longer releases anything, and that inversion is the
 * point of MJXHRM-437. A claim that died with its window was the bug: the chord
 * has to keep working while every window is hidden, and while none exists at all.
 * The claim is given back at the one deliberate exit — `quit_app` / tray ▸ Quit,
 * both of which call `shortcuts::release_all` before the loop stops — and by the
 * OS when the process ends.
 */
export function startGlobalShortcuts(): () => void {
  void syncGlobalShortcuts()
  void drainPendingShortcut()

  const stop = $bindings.subscribe(() => void syncGlobalShortcuts())

  let stopListening: null | (() => void) = null
  let stopped = false

  void listenForDelivery().then(off => {
    if (stopped) {
      off?.()

      return
    }

    stopListening = off
  })

  return () => {
    stopped = true
    stop()
    stopListening?.()
  }
}
