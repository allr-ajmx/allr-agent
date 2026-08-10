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
 * Desktop only. Neither mobile OS lets an app claim a system-wide chord, and the
 * plugin is not in the mobile dependency set, so the import is dynamic and the
 * whole module stands down elsewhere.
 */

import { globalKeybindActions } from '@/lib/keybinds/actions'
import { acceleratorFromCombo } from '@/lib/keybinds/combo'
import { IS_DESKTOP } from '@/lib/platform'
import { $bindings, bindingsFor } from '@/store/keybinds'

/** Accelerator → the action it currently stands for. Rebuilt on every sync. */
let registered = new Map<string, string>()

/** How a fired accelerator reaches its action. Set by the keybind hook, which is
 *  where the handler map lives — this module deliberately knows no actions. */
let dispatch: (actionId: string) => void = () => undefined

let syncing = false
let resync = false

export function setGlobalShortcutDispatch(fn: (actionId: string) => void): void {
  dispatch = fn
}

/** The accelerators that SHOULD be claimed right now, by action id. An action
 *  with no binding, or one the OS can't take, simply isn't in the map. */
function desiredAccelerators(): Map<string, string> {
  const wanted = new Map<string, string>()

  for (const action of globalKeybindActions()) {
    for (const combo of bindingsFor(action.id)) {
      const accelerator = acceleratorFromCombo(combo)

      // First writer wins, so two actions bound to one chord resolve the same
      // way the in-app dispatcher resolves them.
      if (accelerator && !wanted.has(accelerator)) {
        wanted.set(accelerator, action.id)
      }
    }
  }

  return wanted
}

/**
 * Bring the OS's registrations in line with the registry: claim what's new,
 * release what's gone, leave the rest alone.
 *
 * Serialized. Registering is async and a rebind can arrive mid-flight; two
 * overlapping syncs would race to claim the same chord and one of them would
 * fail with "already registered". A pending flag re-runs once instead.
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
    const { register, unregister } = await import('@tauri-apps/plugin-global-shortcut')
    const wanted = desiredAccelerators()
    const next = new Map<string, string>()

    for (const [accelerator, actionId] of registered) {
      if (wanted.get(accelerator) === actionId) {
        next.set(accelerator, actionId)

        continue
      }

      try {
        await unregister(accelerator)
      } catch (err) {
        console.warn('[keybinds] could not release global shortcut', accelerator, err)
      }
    }

    for (const [accelerator, actionId] of wanted) {
      if (next.has(accelerator)) {
        continue
      }

      try {
        await register(accelerator, event => {
          // The plugin reports both edges; acting on Released too would run the
          // action twice per press.
          if (event.state === 'Pressed') {
            dispatch(actionId)
          }
        })
        next.set(accelerator, actionId)
      } catch (err) {
        // Another application already owns the chord. That is a legitimate
        // outcome of a global claim, not a failure of ours — the in-app binding
        // still works, so say so once and move on.
        console.warn('[keybinds] global shortcut unavailable', accelerator, err)
      }
    }

    registered = next
  } finally {
    syncing = false

    if (resync) {
      resync = false
      void syncGlobalShortcuts()
    }
  }
}

/** Release everything this app claimed. For teardown; safe to call twice. */
export async function releaseGlobalShortcuts(): Promise<void> {
  if (!IS_DESKTOP || registered.size === 0) {
    return
  }

  const claimed = [...registered.keys()]
  registered = new Map()

  try {
    const { unregister } = await import('@tauri-apps/plugin-global-shortcut')

    for (const accelerator of claimed) {
      try {
        await unregister(accelerator)
      } catch {
        // Already released, or the window system is going away with us.
      }
    }
  } catch {
    // Plugin not present (mobile/web) — nothing was ever claimed.
  }
}

/**
 * Keep the OS registrations following the registry for as long as the app is up.
 * Returns the unsubscribe, which also releases every claimed chord — a hotkey
 * that outlives its handler is a chord silently stolen from the whole machine.
 */
export function startGlobalShortcuts(): () => void {
  void syncGlobalShortcuts()

  const stop = $bindings.subscribe(() => void syncGlobalShortcuts())

  return () => {
    stop()
    void releaseGlobalShortcuts()
  }
}
