/**
 * A global hotkey is a chord taken from EVERY application on the machine, so the
 * two things that matter are that it follows the user's rebind and that it is
 * always given back.
 *
 * Since MJXHRM-437 the CLAIM lives in Rust (`src-tauri/src/shortcuts.rs`) — this
 * module only decides what should be held and receives what fired. So these cases
 * pin the two halves of that boundary: the desired set that goes down, and the
 * delivery that comes back to exactly this window.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as Platform from '@/lib/platform'
import type * as Keybinds from '@/store/keybinds'
import type * as Notifications from '@/store/notifications'

import type * as Combo from './combo'
import type * as Registrar from './global-shortcut'

/** Must match `$globalShortcutsDisclosed`'s key in `global-shortcut.ts`. */
const DISCLOSED_KEY = 'hermes.globalShortcutsDisclosed'

/** Must match `shortcuts::GLOBAL_SHORTCUT_EVENT`. */
const DELIVERY_EVENT = 'hermes://global-shortcut'

/** The label this window is pretending to be, so a targeted delivery can be
 *  checked against something other than a wildcard. */
const WINDOW_LABEL = 'instance-3'

interface SyncResult {
  granted: string[]
  refused: string[]
}

/** Rust's answer to `global_shortcuts_sync`, per case. */
let syncResult: SyncResult = { granted: [], refused: [] }
/** Rust's answer to `global_shortcut_take_pending`, per case. */
let pending: null | string = null

const invoke = vi.fn(async (command: string, _args?: unknown) => {
  if (command === 'global_shortcuts_sync') {
    return syncResult
  }

  if (command === 'global_shortcut_take_pending') {
    return pending
  }

  throw new Error(`unexpected command ${command}`)
})

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args?: unknown) => invoke(command, args)
}))

/** Every `listen` this module registered: the event, the handler, and — the part
 *  that matters — the target it asked to be filtered on. */
const listeners: { event: string; handler: (event: { payload: unknown }) => void; target: unknown }[] = []

vi.mock('@tauri-apps/api/event', () => ({
  listen: async (event: string, handler: (e: { payload: unknown }) => void, options?: { target?: unknown }) => {
    listeners.push({ event, handler, target: options?.target })

    return () => undefined
  }
}))

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({ label: WINDOW_LABEL })
}))

// The registrar stands down off desktop; these cases are about the desktop path.
vi.mock('@/lib/platform', async importOriginal => ({
  ...(await importOriginal<typeof Platform>()),
  IS_DESKTOP: true
}))

// The disclosure's "Change it" door. Stubbed so the registrar's module graph
// does not drag in the satellite-window machinery (and Tauri with it).
const openAppRoute = vi.fn()

vi.mock('@/store/windows', () => ({ openAppRoute: (route: string) => openAppRoute(route) }))

// The HUD's chord — the only global-flagged action that ships WITH a default
// (MJXHRM-213 gave it a surface worth summoning). Quick Entry is the other
// global action and ships unbound on purpose, so it contributes nothing to a
// default sync; the cases below clear this one when they want a quiet registry.
const ACTION = 'view.toggleHud'

/** The shipped default, as `acceleratorFromCombo` spells it for the OS. */
const DEFAULT_ACCELERATOR = 'CommandOrControl+Shift+H'

// The registrar serializes its syncs, so a rebind that arrives while one is in
// flight lands on the follow-up run rather than racing it. Drain both.
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

/** Every `global_shortcuts_sync` payload sent so far, newest last. */
function syncCalls(): { claims: { accelerator: string; actionId: string; combo: string }[] }[] {
  return invoke.mock.calls
    .filter(([command]) => command === 'global_shortcuts_sync')
    .map(([, args]) => args as { claims: { accelerator: string; actionId: string; combo: string }[] })
}

async function load(): Promise<{
  formatCombo: typeof Combo.formatCombo
  mod: typeof Registrar
  notifications: typeof Notifications.$notifications
  setBinding: typeof Keybinds.setBinding
}> {
  vi.resetModules()
  const mod = await import('./global-shortcut')
  const { setBinding } = await import('@/store/keybinds')
  const { $notifications } = await import('@/store/notifications')
  const { formatCombo } = await import('./combo')

  return { formatCombo, mod, notifications: $notifications, setBinding }
}

beforeEach(() => {
  // Reset, not just clear: a case that makes the OS refuse a claim must not
  // leave the next one syncing against a rejecting stub — and a failed
  // assertion skips whatever cleanup the case wrote at its end.
  invoke.mockClear()
  openAppRoute.mockClear()
  listeners.length = 0
  syncResult = { granted: [], refused: [] }
  pending = null
  // The disclosure is remembered in localStorage, which `vi.resetModules` does
  // not clear — without this the first case to run would be the only one that
  // ever sees the notice.
  localStorage.removeItem(DISCLOSED_KEY)
})

afterEach(() => {
  vi.resetModules()
})

describe('global shortcuts follow the rebindable registry', () => {
  it('sends the whole desired set to Rust', async () => {
    const { mod } = await load()

    await mod.syncGlobalShortcuts()

    // The HUD's chord is the one thing this app takes from the whole machine
    // without being asked, so it is worth a test that it is exactly that one —
    // and that every field the registrar needs is on it. `combo` is not
    // decoration: it is what the first-run disclosure names, and an accelerator
    // is the OS's spelling.
    expect(syncCalls()).toEqual([
      { claims: [{ accelerator: DEFAULT_ACCELERATOR, actionId: ACTION, combo: 'mod+shift+h' }] }
    ])
  })

  it('claims nothing once the user unbinds the action', async () => {
    const { mod, setBinding } = await load()

    setBinding(ACTION, [])
    await mod.syncGlobalShortcuts()

    // Still a sync — the empty set is how Rust learns to hand the chord back —
    // but with nothing in it.
    expect(syncCalls()).toEqual([{ claims: [] }])
  })

  it('sends the combo the user bound, and re-sends when they change it', async () => {
    const { mod, setBinding } = await load()

    setBinding(ACTION, ['mod+shift+space'])
    await mod.syncGlobalShortcuts()

    expect(syncCalls().at(-1)?.claims).toEqual([
      { accelerator: 'CommandOrControl+Shift+Space', actionId: ACTION, combo: 'mod+shift+space' }
    ])

    setBinding(ACTION, ['mod+alt+h'])
    await mod.syncGlobalShortcuts()

    expect(syncCalls().at(-1)?.claims).toEqual([
      { accelerator: 'CommandOrControl+Alt+H', actionId: ACTION, combo: 'mod+alt+h' }
    ])

    setBinding(ACTION, [])
  })

  it('re-syncs on its own when a binding changes underneath it', async () => {
    const { mod, setBinding } = await load()
    const stop = mod.startGlobalShortcuts()

    // Let the BOOT sync finish before rebinding. Without this the rebind lands
    // while that first sync is still awaiting its dynamic import, so it reads
    // the new combo on its own and the case passed with the subscription
    // deleted outright — which is the one thing it exists to prove: a chord
    // assigned in Settings has to take effect without a restart.
    await flush()
    invoke.mockClear()

    setBinding(ACTION, ['mod+shift+space'])
    await flush()

    expect(syncCalls().at(-1)?.claims).toEqual([
      { accelerator: 'CommandOrControl+Shift+Space', actionId: ACTION, combo: 'mod+shift+space' }
    ])

    stop()
    setBinding(ACTION, [])
  })

  it('says which chord another application already owns', async () => {
    const { mod, setBinding } = await load()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    syncResult = { granted: [], refused: ['mod+shift+space'] }
    setBinding(ACTION, ['mod+shift+space'])

    await expect(mod.syncGlobalShortcuts()).resolves.toBeUndefined()

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unavailable'), 'mod+shift+space')

    warn.mockRestore()
    setBinding(ACTION, [])
  })

  it('does not take the app down when the backend refuses the sync', async () => {
    const { mod } = await load()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    invoke.mockRejectedValueOnce(new Error('unsupported_platform'))

    await expect(mod.syncGlobalShortcuts()).resolves.toBeUndefined()

    // And the serialization flag is released, so a later rebind still syncs.
    invoke.mockClear()
    await mod.syncGlobalShortcuts()
    expect(syncCalls()).toHaveLength(1)

    warn.mockRestore()
  })
})

describe('delivering a chord that fired outside this window', () => {
  it('listens on THIS window’s label, not on the wildcard Tauri defaults to', async () => {
    const { mod } = await load()
    const stop = mod.startGlobalShortcuts()

    await flush()

    const delivery = listeners.filter(l => l.event === DELIVERY_EVENT)

    expect(delivery).toHaveLength(1)
    // Rust addresses ONE window with `emit_to`, and Tauri filters an `emit_to`
    // against the target each listener registered with — the default
    // `{ kind: 'Any' }` matches nothing an `emit_to` sends. A listener that did
    // not name its label would receive the chord never, silently, while the
    // backend reported a successful emit.
    expect(delivery[0]?.target).toBe(WINDOW_LABEL)

    stop()
  })

  it('runs the delivered action through the same handler map as the in-app chord', async () => {
    const { mod } = await load()
    const ran = vi.fn()

    mod.setGlobalShortcutDispatch(ran)

    const stop = mod.startGlobalShortcuts()
    await flush()

    listeners.find(l => l.event === DELIVERY_EVENT)?.handler({ payload: { actionId: ACTION } })

    expect(ran).toHaveBeenCalledWith(ACTION)

    stop()
  })

  it('drains a chord that fired before this window existed', async () => {
    const { mod } = await load()
    const ran = vi.fn()

    // The cold summon: Rust parked the action, built `main` hidden, and this is
    // the boot that has to finish the job.
    pending = ACTION
    mod.setGlobalShortcutDispatch(ran)

    const stop = mod.startGlobalShortcuts()
    await flush()

    expect(invoke).toHaveBeenCalledWith('global_shortcut_take_pending', undefined)
    expect(ran).toHaveBeenCalledWith(ACTION)

    stop()
  })

  it('dispatches nothing when no chord was parked', async () => {
    const { mod } = await load()
    const ran = vi.fn()

    mod.setGlobalShortcutDispatch(ran)

    const stop = mod.startGlobalShortcuts()
    await flush()

    expect(invoke).toHaveBeenCalledWith('global_shortcut_take_pending', undefined)
    expect(ran).not.toHaveBeenCalled()

    stop()
  })

  it('keeps the claim when a window goes away', async () => {
    const { mod } = await load()

    const stop = mod.startGlobalShortcuts()
    await flush()
    invoke.mockClear()

    // The disposer runs when a full app window tears down. Before MJXHRM-437 it
    // released every claim, which is exactly the thing background mode cannot
    // afford: the surviving windows are hidden, or there are none, and the chord
    // still has to summon the HUD.
    stop()
    await flush()

    expect(invoke).not.toHaveBeenCalled()
  })
})

describe('disclosing the OS-wide claim', () => {
  // `view.toggleHud` ships bound to mod+shift+H with `global: true`, so this
  // claim happens at BOOT — before the user has touched anything, and it takes
  // the chord away from every other application on the machine. Nothing in the
  // app said so.
  it('tells the user once, naming the chord it actually took', async () => {
    const { formatCombo, mod, notifications, setBinding } = await load()

    syncResult = { granted: ['mod+shift+h'], refused: [] }
    setBinding(ACTION, ['mod+shift+h'])
    await mod.syncGlobalShortcuts()

    const notice = notifications.get().at(-1)

    expect(notice?.title).toBe('A shortcut is now reserved system-wide')
    expect(notice?.message).toContain(formatCombo('mod+shift+h'))
    // Reading it is the whole point, so it must not expire on its own while the
    // app is still painting its first frame.
    expect(notice?.action).toBeDefined()

    notice?.action?.onClick()
    expect(openAppRoute).toHaveBeenCalledWith('/settings/shortcuts')

    setBinding(ACTION, [])
  })

  it('says nothing when the OS refused the claim', async () => {
    const { mod, notifications, setBinding } = await load()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    // Another application already owns the chord: nothing was taken, so a notice
    // saying otherwise would be a claim the user cannot verify. Rust reports it
    // as refused, and `granted` — the only thing the disclosure reads — is empty.
    syncResult = { granted: [], refused: ['mod+shift+h'] }
    setBinding(ACTION, ['mod+shift+h'])
    await mod.syncGlobalShortcuts()

    expect(notifications.get()).toHaveLength(0)
    // And the flag stays down, so the next boot — on a machine where the other
    // app is not running — still gets to say it.
    expect(localStorage.getItem(DISCLOSED_KEY)).not.toBe('true')

    warn.mockRestore()
    setBinding(ACTION, [])
  })

  it('never says it twice', async () => {
    const { mod, notifications, setBinding } = await load()

    syncResult = { granted: ['mod+shift+h'], refused: [] }
    setBinding(ACTION, ['mod+shift+h'])
    await mod.syncGlobalShortcuts()
    expect(notifications.get()).toHaveLength(1)

    // A rebind re-claims, and so does the second window of this app booting.
    // Neither is news.
    syncResult = { granted: ['mod+shift+space'], refused: [] }
    setBinding(ACTION, ['mod+shift+space'])
    await mod.syncGlobalShortcuts()
    await mod.syncGlobalShortcuts()

    expect(notifications.get()).toHaveLength(1)

    setBinding(ACTION, [])
  })

  it('stays quiet on a machine where nothing is bound globally', async () => {
    const { mod, notifications, setBinding } = await load()

    setBinding(ACTION, [])
    await mod.syncGlobalShortcuts()

    expect(syncCalls()).toEqual([{ claims: [] }])
    expect(notifications.get()).toHaveLength(0)
  })
})

describe('the action id Rust names', () => {
  /**
   * `tray.rs`'s *Open HUD* row fires `shortcuts::HUD_ACTION_ID` through the same
   * dispatch bus the chord uses. That is the one action id spelled on both sides
   * of the boundary, and nothing in either language would notice it drifting: a
   * tray row firing an id no handler has is a dead click with no error anywhere,
   * because `handlersRef.current[actionId]?.()` is optional by design.
   */
  it('is an action this registry actually has, and a global one', async () => {
    const { globalKeybindActions } = await import('@/lib/keybinds/actions')
    const source = readFileSync(join(process.cwd(), 'src-tauri/src/shortcuts.rs'), 'utf8')
    const declared = /pub const HUD_ACTION_ID: &str = "([^"]+)";/.exec(source)?.[1]

    expect(declared).toBeDefined()
    expect(globalKeybindActions().map(action => action.id)).toContain(declared)
  })
})
