import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn(async (_cmd: string, args: { on: boolean }) => args.on) }))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@/lib/platform', () => ({ IS_DESKTOP: true }))

import { $keepAwake, initKeepAwake, setKeepAwake, toggleKeepAwake } from './keep-awake'
import { $notifications, clearNotifications } from './notifications'

beforeEach(() => {
  invoke.mockReset()
  invoke.mockImplementation(async (_cmd: string, args: { on: boolean }) => args.on)
  $keepAwake.set(false)
  localStorage.clear()
  clearNotifications()
})

describe('keep-awake store', () => {
  it('persists the preference and mirrors it to the native inhibitor', async () => {
    setKeepAwake(true)
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('set_keep_awake', { on: true }))

    expect($keepAwake.get()).toBe(true)
    expect(localStorage.getItem('hermes.keepAwake')).toBe('true')

    setKeepAwake(false)
    await vi.waitFor(() => expect(invoke).toHaveBeenLastCalledWith('set_keep_awake', { on: false }))
  })

  it('toggles the current value', () => {
    toggleKeepAwake()
    expect($keepAwake.get()).toBe(true)

    toggleKeepAwake()
    expect($keepAwake.get()).toBe(false)
  })

  // Without this the preference reads "on" after a restart while the machine is
  // free to sleep — nothing else re-arms the inhibitor.
  it('re-asserts the persisted preference at startup', async () => {
    $keepAwake.set(true)
    invoke.mockClear()

    initKeepAwake()
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('set_keep_awake', { on: true }))
  })

  // A fresh process holds nothing, so an off preference has nothing to assert —
  // and a boot on a machine that cannot inhibit at all must not open with a toast
  // about a lever the user never pulled.
  it('stays quiet at startup when the preference is off', async () => {
    initKeepAwake()

    // Long enough for the dynamic `import()` in `applyKeepAwake` to land — a bare
    // microtask tick would pass even if the call were still on its way.
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(invoke).not.toHaveBeenCalled()
    expect($notifications.get()).toHaveLength(0)
  })

  // The whole promise of this switch is that an overnight run survives the night.
  // There is no logind under WSL or on a non-systemd distro, so the ask really is
  // refused in the wild — and a switch left reading "on" over a machine free to
  // sleep is worse than no switch at all.
  it('turns the preference back off when the OS refuses the inhibitor', async () => {
    invoke.mockRejectedValueOnce(new Error('no logind'))

    setKeepAwake(true)

    await vi.waitFor(() => expect($keepAwake.get()).toBe(false))
    expect($notifications.get()[0]).toMatchObject({ kind: 'error', title: "Couldn't keep this computer awake" })
  })

  // Rust answers with what it actually holds, not with the ask echoed back.
  it('follows the state Rust reports rather than the state requested', async () => {
    invoke.mockResolvedValueOnce(false)

    setKeepAwake(true)

    await vi.waitFor(() => expect($keepAwake.get()).toBe(false))
  })

  // A refused release leaves the machine still held, so the preference has to go
  // back to "on" — flipping the switch off would hide a machine that is still
  // being kept awake.
  it('puts the preference back on when releasing fails', async () => {
    $keepAwake.set(true)
    invoke.mockRejectedValueOnce(new Error('state gone'))

    setKeepAwake(false)

    await vi.waitFor(() => expect($notifications.get()).toHaveLength(1))
    expect($keepAwake.get()).toBe(true)
  })

  // A slow reply to an earlier toggle must not land on top of a later one.
  it('ignores a reply that a newer toggle has superseded', async () => {
    let releaseFirst: (value: boolean) => void = () => {}

    invoke.mockImplementationOnce(async () => {
      return await new Promise<boolean>(resolve => {
        releaseFirst = resolve
      })
    })

    setKeepAwake(true)
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))

    setKeepAwake(false)
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2))

    // Only now does the first ask answer — with the opposite of where the switch
    // has since landed.
    releaseFirst(true)
    await Promise.resolve()
    await Promise.resolve()

    expect($keepAwake.get()).toBe(false)
  })
})
