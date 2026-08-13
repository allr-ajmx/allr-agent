/**
 * A global hotkey is a chord taken from EVERY application on the machine, so the
 * two things that matter are that it follows the user's rebind and that it is
 * always given back.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as Platform from '@/lib/platform'
import type * as Keybinds from '@/store/keybinds'
import type * as Notifications from '@/store/notifications'

import type * as Combo from './combo'
import type * as Registrar from './global-shortcut'

/** Must match `$globalShortcutsDisclosed`'s key in `global-shortcut.ts`. */
const DISCLOSED_KEY = 'hermes.globalShortcutsDisclosed'

type ShortcutEvent = { state: string }

const register = vi.fn(async (_accelerator: string, _handler: (event: ShortcutEvent) => void) => undefined)
const unregister = vi.fn(async (_accelerator: string) => undefined)

vi.mock('@tauri-apps/plugin-global-shortcut', () => ({
  register: (accelerator: string, handler: (event: ShortcutEvent) => void) => register(accelerator, handler),
  unregister: (accelerator: string) => unregister(accelerator)
}))

/** Rust's "a full app window was destroyed" broadcast, played by hand. */
const windowClosedListeners: (() => void)[] = []

vi.mock('@tauri-apps/api/event', () => ({
  listen: async (event: string, handler: () => void) => {
    if (event === 'hermes://app-window-closed') {
      windowClosedListeners.push(handler)
    }

    return () => undefined
  }
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

// The registrar serializes its syncs, so a rebind that arrives while one is in
// flight lands on the follow-up run rather than racing it. Drain both.
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 0))
  }
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
  // leave the next one registering against a rejecting stub — and a failed
  // assertion skips whatever cleanup the case wrote at its end.
  register.mockReset()
  unregister.mockReset()
  openAppRoute.mockClear()
  windowClosedListeners.length = 0
  // The disclosure is remembered in localStorage, which `vi.resetModules` does
  // not clear — without this the first case to run would be the only one that
  // ever sees the notice.
  localStorage.removeItem(DISCLOSED_KEY)
})

afterEach(() => {
  vi.resetModules()
})

describe('global shortcuts follow the rebindable registry', () => {
  it('claims the shipped default at boot', async () => {
    const { mod } = await load()

    await mod.syncGlobalShortcuts()

    // The HUD's chord is the one thing this app takes from the whole machine
    // without being asked, so it is worth a test that it is exactly that one.
    expect(register).toHaveBeenCalledTimes(1)
    expect(register).toHaveBeenCalledWith('CommandOrControl+Shift+H', expect.any(Function))
  })

  it('claims nothing once the user unbinds the action', async () => {
    const { mod, setBinding } = await load()

    setBinding(ACTION, [])
    await mod.syncGlobalShortcuts()

    expect(register).not.toHaveBeenCalled()
  })

  it('claims the combo the user bound, and re-claims when they change it', async () => {
    const { mod, setBinding } = await load()

    setBinding(ACTION, ['mod+shift+space'])
    await mod.syncGlobalShortcuts()

    expect(register).toHaveBeenCalledWith('CommandOrControl+Shift+Space', expect.any(Function))

    setBinding(ACTION, ['mod+alt+h'])
    await mod.syncGlobalShortcuts()

    // The old chord goes back to the machine before the new one is taken.
    expect(unregister).toHaveBeenCalledWith('CommandOrControl+Shift+Space')
    expect(register).toHaveBeenCalledWith('CommandOrControl+Alt+H', expect.any(Function))

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
    register.mockClear()

    setBinding(ACTION, ['mod+shift+space'])
    await flush()

    expect(register).toHaveBeenCalledWith('CommandOrControl+Shift+Space', expect.any(Function))

    stop()
    setBinding(ACTION, [])
  })

  it('runs the action on press only — the plugin reports both edges', async () => {
    const { mod, setBinding } = await load()
    const ran = vi.fn()

    mod.setGlobalShortcutDispatch(ran)
    setBinding(ACTION, ['mod+shift+space'])
    await mod.syncGlobalShortcuts()

    const handler = register.mock.calls[0][1]

    handler({ state: 'Released' })
    expect(ran).not.toHaveBeenCalled()

    handler({ state: 'Pressed' })
    expect(ran).toHaveBeenCalledWith(ACTION)

    setBinding(ACTION, [])
  })

  it('gives every claimed chord back when it is released', async () => {
    const { mod, setBinding } = await load()

    setBinding(ACTION, ['mod+shift+space'])
    await mod.syncGlobalShortcuts()

    await mod.releaseGlobalShortcuts()

    expect(unregister).toHaveBeenCalledWith('CommandOrControl+Shift+Space')

    setBinding(ACTION, [])
  })

  it('takes the chord back when the window that owned it goes away', async () => {
    const { mod, setBinding } = await load()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    // Explicit, because an earlier case may have left the action unbound in
    // persisted storage — which `vi.resetModules` does not clear.
    setBinding(ACTION, ['mod+shift+h'])

    // Another window of THIS app claimed it first — the plugin's registry is per
    // process, so this window is refused exactly as it would be by a foreign
    // app, and ends up holding nothing.
    register.mockRejectedValue(new Error('HotKey already registered'))

    const stop = mod.startGlobalShortcuts()
    await flush()

    expect(register).toHaveBeenCalled()
    register.mockImplementation(async () => undefined)
    register.mockClear()
    unregister.mockClear()

    // That window is closed natively. Its handler channel died with it, so the
    // chord is registered, taken from the whole machine, and answers nobody.
    expect(windowClosedListeners).toHaveLength(1)
    windowClosedListeners[0]?.()
    await flush()

    // Released blind, then re-claimed onto a channel that is alive.
    expect(unregister).toHaveBeenCalledWith('CommandOrControl+Shift+H')
    expect(register).toHaveBeenCalledWith('CommandOrControl+Shift+H', expect.any(Function))

    stop()
    warn.mockRestore()
    setBinding(ACTION, [])
  })

  it('reclaims onto a live handler, so the chord runs the action again', async () => {
    const { mod, setBinding } = await load()
    const ran = vi.fn()

    mod.setGlobalShortcutDispatch(ran)
    setBinding(ACTION, ['mod+shift+h'])
    register.mockRejectedValue(new Error('HotKey already registered'))

    const stop = mod.startGlobalShortcuts()
    await flush()

    register.mockImplementation(async () => undefined)
    register.mockClear()
    await mod.reclaimGlobalShortcuts()

    expect(register).toHaveBeenCalledWith('CommandOrControl+Shift+H', expect.any(Function))

    const handler = register.mock.calls.at(-1)?.[1]
    handler?.({ state: 'Pressed' })

    expect(ran).toHaveBeenCalledWith(ACTION)

    stop()
    setBinding(ACTION, [])
  })

  it('survives a chord another application already owns', async () => {
    const { mod, setBinding } = await load()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    register.mockRejectedValueOnce(new Error('HotKey already registered'))
    setBinding(ACTION, ['mod+shift+space'])

    await expect(mod.syncGlobalShortcuts()).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()

    warn.mockRestore()
    setBinding(ACTION, [])
  })
})

describe('disclosing the OS-wide claim', () => {
  // `view.toggleHud` ships bound to mod+shift+H with `global: true`, so this
  // claim happens at BOOT — before the user has touched anything, and it takes
  // the chord away from every other application on the machine. Nothing in the
  // app said so.
  it('tells the user once, naming the chord it actually took', async () => {
    const { formatCombo, mod, notifications, setBinding } = await load()

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
    // saying otherwise would be a claim the user cannot verify.
    register.mockRejectedValue(new Error('HotKey already registered'))
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

    setBinding(ACTION, ['mod+shift+h'])
    await mod.syncGlobalShortcuts()
    expect(notifications.get()).toHaveLength(1)

    // A rebind re-claims, and so does a reclaim after a peer window dies. Neither
    // is news.
    setBinding(ACTION, ['mod+shift+space'])
    await mod.syncGlobalShortcuts()
    await mod.reclaimGlobalShortcuts()

    expect(notifications.get()).toHaveLength(1)

    setBinding(ACTION, [])
  })

  it('stays quiet on a machine where nothing is bound globally', async () => {
    const { mod, notifications, setBinding } = await load()

    setBinding(ACTION, [])
    await mod.syncGlobalShortcuts()

    expect(register).not.toHaveBeenCalled()
    expect(notifications.get()).toHaveLength(0)
  })
})
