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

import { translateNow } from '@/i18n'
import { globalKeybindActions } from '@/lib/keybinds/actions'
import { acceleratorFromCombo, formatCombo } from '@/lib/keybinds/combo'
import { Codecs, persistentAtom } from '@/lib/persisted'
import { IS_DESKTOP } from '@/lib/platform'
import { $bindings, bindingsFor } from '@/store/keybinds'
import { notify } from '@/store/notifications'
import { openAppRoute } from '@/store/windows'

/** Accelerator → the action it currently stands for. Rebuilt on every sync. */
let registered = new Map<string, string>()

/** How a fired accelerator reaches its action. Set by the keybind hook, which is
 *  where the handler map lives — this module deliberately knows no actions. */
let dispatch: (actionId: string) => void = () => undefined

let syncing = false
let resync = false

/**
 * Claim the next sync's accelerators from scratch, releasing whoever holds them
 * first. See [`reclaimGlobalShortcuts`].
 */
let forceReclaim = false

export function setGlobalShortcutDispatch(fn: (actionId: string) => void): void {
  dispatch = fn
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
      // way the in-app dispatcher resolves them.
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

  // Consumed here rather than at the call site: a reclaim requested while
  // another sync was in flight returned early above, and this is the run that
  // has to honour it.
  const force = forceReclaim
  forceReclaim = false

  try {
    const { register, unregister } = await import('@tauri-apps/plugin-global-shortcut')
    const wanted = desiredAccelerators()
    const next = new Map<string, string>()
    /** Combos the OS granted in THIS pass — what the first-run notice reports. */
    const claimed: string[] = []

    for (const [accelerator, actionId] of registered) {
      if (!force && wanted.get(accelerator)?.actionId === actionId) {
        next.set(accelerator, actionId)

        continue
      }

      try {
        await unregister(accelerator)
      } catch (err) {
        console.warn('[keybinds] could not release global shortcut', accelerator, err)
      }
    }

    for (const [accelerator, claim] of wanted) {
      if (next.has(accelerator)) {
        continue
      }

      // A reclaim assumes the chord is held by a claim this window did not make
      // and cannot see — the plugin's registry is per PROCESS, not per window.
      // Release it blind before claiming; an accelerator nobody holds simply
      // rejects here, which is the no-op we want.
      if (force) {
        try {
          await unregister(accelerator)
        } catch {
          // Nobody held it. Claiming it below is the whole point.
        }
      }

      try {
        await register(accelerator, event => {
          // The plugin reports both edges; acting on Released too would run the
          // action twice per press.
          if (event.state === 'Pressed') {
            dispatch(claim.actionId)
          }
        })
        next.set(accelerator, claim.actionId)
        claimed.push(claim.combo)
      } catch (err) {
        // Another application already owns the chord. That is a legitimate
        // outcome of a global claim, not a failure of ours — the in-app binding
        // still works, so say so once and move on.
        console.warn('[keybinds] global shortcut unavailable', accelerator, err)
      }
    }

    registered = next
    discloseGlobalClaim(claimed)
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
 * Take the claims back after another window of this app went away.
 *
 * The plugin's registry is per PROCESS while the handler channel that answers a
 * chord belongs to the WINDOW that registered it. Every full app window runs
 * this module and asks for the same accelerators at boot; the first is granted
 * and the rest are refused with "already registered" (see `global-hotkey`'s
 * `Error::AlreadyRegistered` on all three desktop backends), so exactly one
 * window is the owner. Close that window natively — a compositor, a title-bar X,
 * anything but a JS teardown — and `releaseGlobalShortcuts` never runs: the
 * accelerator stays claimed from every application on the machine and delivers
 * into a channel that died with the window. Every global action, Quick Entry and
 * the HUD included, is then silently unreachable until the app restarts, even
 * though a window is still open.
 *
 * So the survivors re-claim: release blind, then register onto a live channel.
 * If several survive they all try at once, and that is fine — each does
 * release-then-claim, so the end state is one owner either way.
 */
export async function reclaimGlobalShortcuts(): Promise<void> {
  if (!IS_DESKTOP) {
    return
  }

  forceReclaim = true
  await syncGlobalShortcuts()
}

/** Emitted by Rust when a full app window is destroyed (`src-tauri/src/window.rs`).
 *  Native-side because the window it concerns cannot report its own death. */
const APP_WINDOW_CLOSED_EVENT = 'hermes://app-window-closed'

async function watchClosedAppWindows(): Promise<null | (() => void)> {
  if (!IS_DESKTOP) {
    return null
  }

  try {
    const { listen } = await import('@tauri-apps/api/event')

    return await listen<string>(APP_WINDOW_CLOSED_EVENT, () => void reclaimGlobalShortcuts())
  } catch {
    // No window system here — no second window to lose the claims to.
    return null
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

  let stopWatching: null | (() => void) = null
  let stopped = false

  void watchClosedAppWindows().then(off => {
    if (stopped) {
      off?.()

      return
    }

    stopWatching = off
  })

  return () => {
    stopped = true
    stop()
    stopWatching?.()
    void releaseGlobalShortcuts()
  }
}
