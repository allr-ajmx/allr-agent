/**
 * A global hotkey is a chord taken from EVERY application on the machine, so the
 * two things that matter are that it follows the user's rebind and that it is
 * always given back.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as Platform from '@/lib/platform'
import type * as Keybinds from '@/store/keybinds'

import type * as Registrar from './global-shortcut'

type ShortcutEvent = { state: string }

const register = vi.fn(async (_accelerator: string, _handler: (event: ShortcutEvent) => void) => undefined)
const unregister = vi.fn(async (_accelerator: string) => undefined)

vi.mock('@tauri-apps/plugin-global-shortcut', () => ({
  register: (accelerator: string, handler: (event: ShortcutEvent) => void) => register(accelerator, handler),
  unregister: (accelerator: string) => unregister(accelerator)
}))

// The registrar stands down off desktop; these cases are about the desktop path.
vi.mock('@/lib/platform', async importOriginal => ({
  ...(await importOriginal<typeof Platform>()),
  IS_DESKTOP: true
}))

// The one global-flagged action the app ships. It ships UNBOUND, which is what
// makes it a clean subject: nothing is claimed until these cases bind it.
const ACTION = 'view.toggleHud'

// The registrar serializes its syncs, so a rebind that arrives while one is in
// flight lands on the follow-up run rather than racing it. Drain both.
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

async function load(): Promise<{ mod: typeof Registrar; setBinding: typeof Keybinds.setBinding }> {
  vi.resetModules()
  const mod = await import('./global-shortcut')
  const { setBinding } = await import('@/store/keybinds')

  return { mod, setBinding }
}

beforeEach(() => {
  register.mockClear()
  unregister.mockClear()
})

afterEach(() => {
  vi.resetModules()
})

describe('global shortcuts follow the rebindable registry', () => {
  it('claims nothing for an action shipped unbound', async () => {
    const { mod } = await load()

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
