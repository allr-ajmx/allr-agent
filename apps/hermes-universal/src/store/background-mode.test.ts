/**
 * Background mode (MJXHRM-436) — the preference half.
 *
 * The lever is Rust's; what this store owes is that the switch never claims
 * something the machine did not actually agree to. A switch reading "on" over an
 * app that quits when you close it is worse than no switch, in exactly the way
 * `keep-awake` is worse than no switch when there is no logind: the user goes
 * away expecting a stream to survive, and it does not.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke, platform } = vi.hoisted(() => ({
  invoke: vi.fn(async (_cmd: string, args: { on: boolean }) => args.on),
  // Mutable so the phone case can be asserted in the same file. `IS_DESKTOP` is
  // read through a getter, so the module under test sees the current value on
  // every call rather than the one captured at import.
  platform: { desktop: true }
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@/lib/platform', () => ({
  get IS_DESKTOP() {
    return platform.desktop
  }
}))

import {
  $backgroundMode,
  applyBackgroundMode,
  backgroundCloseTakesOver,
  initBackgroundMode,
  setBackgroundMode,
  toggleBackgroundMode
} from './background-mode'
import { $notifications, clearNotifications } from './notifications'

beforeEach(() => {
  invoke.mockReset()
  invoke.mockImplementation(async (_cmd: string, args: { on: boolean }) => args.on)
  platform.desktop = true
  $backgroundMode.set(false)
  localStorage.clear()
  clearNotifications()
})

describe('background mode store', () => {
  it('persists the preference and mirrors it to Rust', async () => {
    setBackgroundMode(true)
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('set_background_mode', { on: true }))

    expect($backgroundMode.get()).toBe(true)
    expect(localStorage.getItem('hermes.backgroundMode')).toBe('true')

    setBackgroundMode(false)
    await vi.waitFor(() => expect(invoke).toHaveBeenLastCalledWith('set_background_mode', { on: false }))
  })

  it('toggles the current value', () => {
    toggleBackgroundMode()
    expect($backgroundMode.get()).toBe(true)

    toggleBackgroundMode()
    expect($backgroundMode.get()).toBe(false)
  })

  // The mobile noop lives HERE, not in Rust: the command is registered on mobile
  // only so a stray call is a clear refusal, and the store is what makes sure no
  // stray call happens. The code path exists, nothing is invoked, nothing throws.
  it('does nothing on a phone', async () => {
    platform.desktop = false

    await expect(applyBackgroundMode(true)).resolves.toBe(true)
    await expect(applyBackgroundMode(false)).resolves.toBe(false)

    expect(invoke).not.toHaveBeenCalled()
  })

  it('reports the ask back verbatim on a phone rather than failing', async () => {
    platform.desktop = false

    setBackgroundMode(true)

    // Long enough for the dynamic `import()` inside `applyBackgroundMode` to have
    // landed if the platform guard were not there.
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(invoke).not.toHaveBeenCalled()
    expect($backgroundMode.get()).toBe(true)
    expect($notifications.get()).toHaveLength(0)
  })

  // The refusal that really happens: a bare wlroots session with no
  // StatusNotifier host gets no tray, and `set_background_mode` refuses to arm
  // rather than let the user hide a window they would have no way to bring back.
  it('flips the switch back when the machine refuses', async () => {
    invoke.mockRejectedValueOnce(new Error('no_tray'))

    setBackgroundMode(true)

    await vi.waitFor(() => expect($backgroundMode.get()).toBe(false))
    expect($notifications.get()).toHaveLength(1)
    expect($notifications.get()[0]).toMatchObject({
      kind: 'error',
      title: "Couldn't keep Hermes running in the background"
    })
  })

  // Rust answers with what is in force, not with the ask echoed back.
  it('follows the state Rust reports rather than the state requested', async () => {
    invoke.mockResolvedValueOnce(false)

    setBackgroundMode(true)

    await vi.waitFor(() => expect($backgroundMode.get()).toBe(false))
  })

  // A slow reply to an earlier toggle must not land on top of a later one.
  //
  // The sequence is fussy on purpose, because the obvious version of this test
  // CANNOT FAIL. Hold gen 1 open, let gen 2 answer with something other than what
  // it was asked, and only then let gen 1 answer — also with something other than
  // what IT was asked. Both replies therefore want to write, they want to write
  // different values, and the only thing standing between the stale one and the
  // atom is the generation check. Drop `generation === mine` from the success path
  // and gen 1's `false` lands on top of gen 2's `true`.
  //
  // The version that reads more naturally — stale reply echoes its own ask — is
  // absorbed entirely by the neighbouring `active !== on` short-circuit: nothing
  // is written with or without the counter, so the test passes either way and
  // proves the wrong guard.
  it('ignores a reply that a newer toggle has superseded', async () => {
    let releaseFirst: (value: boolean) => void = () => {}

    // gen 1: asked `true`, held open.
    invoke.mockImplementationOnce(async () => {
      return await new Promise<boolean>(resolve => {
        releaseFirst = resolve
      })
    })
    // gen 2: asked `false`, answers `true` — Rust reporting what is in force
    // rather than echoing the ask, exactly as `follows the state Rust reports`
    // covers. So the switch lands on `true`.
    invoke.mockResolvedValueOnce(true)

    setBackgroundMode(true)
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))

    setBackgroundMode(false)
    await vi.waitFor(() => expect($backgroundMode.get()).toBe(true))
    expect(invoke).toHaveBeenCalledTimes(2)

    // Now the stale ask answers, and it disagrees with its own `on` — so it would
    // write, and it would write the opposite of where the switch has since landed.
    releaseFirst(false)
    await new Promise(resolve => setTimeout(resolve, 20))

    expect($backgroundMode.get()).toBe(true)
  })

  // The other half of the generation counter, and the one the ordering test above
  // does not reach: a REFUSAL that arrives after the user has moved on must not
  // toast, and must not drag the switch back to where it was two asks ago. Two
  // toasts for one switch is how a transient failure reads as a broken app.
  it('does not toast for a refusal a newer toggle has superseded', async () => {
    let refuseFirst: (error: Error) => void = () => {}

    // gen 1: asked `true`, held open, and it will refuse.
    invoke.mockImplementationOnce(async () => {
      return await new Promise<boolean>((_resolve, reject) => {
        refuseFirst = reject
      })
    })
    // gen 2 answers `true` to an ask of `false`, so the switch lands on `true`.
    // Same reason as the success-path test above: without this the stale catch's
    // revert (`set(!on)` = `set(false)`) would write the value the atom already
    // holds, and only the toast count would be load-bearing.
    invoke.mockResolvedValueOnce(true)

    setBackgroundMode(true)
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))

    setBackgroundMode(false)
    await vi.waitFor(() => expect($backgroundMode.get()).toBe(true))
    expect(invoke).toHaveBeenCalledTimes(2)

    refuseFirst(new Error('no_tray'))
    await new Promise(resolve => setTimeout(resolve, 20))

    // Both assertions can fail on their own: unguarded, the stale refusal toasts
    // about a switch the user has already moved AND drags it back off.
    expect($notifications.get()).toHaveLength(0)
    expect($backgroundMode.get()).toBe(true)
  })

  // `BackgroundState` is process-local and starts false, so a relaunch has to
  // mirror the preference down again — otherwise the switch reads "on" over an
  // app that quits the moment you close it.
  it('re-asserts the persisted preference at startup', async () => {
    $backgroundMode.set(true)
    invoke.mockClear()

    initBackgroundMode()
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('set_background_mode', { on: true }))
  })

  it('stays quiet at startup when the preference is off', async () => {
    initBackgroundMode()

    await new Promise(resolve => setTimeout(resolve, 50))

    expect(invoke).not.toHaveBeenCalled()
    expect($notifications.get()).toHaveLength(0)
  })
})

// The predicate `installWindowCloseGuard` branches on. It takes its
// `ownsPersistedAppState` half as an argument rather than importing it, because
// `store/windows` imports THIS module and the edge only goes one way.
describe('backgroundCloseTakesOver', () => {
  it('takes over for the main window with the switch on', () => {
    $backgroundMode.set(true)

    expect(backgroundCloseTakesOver('main', true)).toBe(true)
  })

  // The stranding case, and the reason this takes a label at all. A hidden window
  // is reachable through exactly one affordance — the tray's Show Hermes — and
  // that resolves to `main`, the lowest surviving instance, or a rebuilt `main`.
  // A hidden `instance-2` would exist, hold a session, and have nothing anywhere
  // able to bring it back.
  it('never takes over for a pop-out instance', () => {
    $backgroundMode.set(true)

    expect(backgroundCloseTakesOver('instance-2', true)).toBe(false)
  })

  // A tile window or a satellite: a surface of the app, not the app.
  it('never takes over for a tile or a satellite', () => {
    $backgroundMode.set(true)

    expect(backgroundCloseTakesOver('tile-session-tile-abc', false)).toBe(false)
    expect(backgroundCloseTakesOver('sat-hud', false)).toBe(false)
    // Even a window that somehow answered `main` while not owning the app state
    // stays out — the two halves have to agree.
    expect(backgroundCloseTakesOver('main', false)).toBe(false)
  })

  it('does not take over with the switch off', () => {
    $backgroundMode.set(false)

    expect(backgroundCloseTakesOver('main', true)).toBe(false)
  })

  it('never takes over on a phone', () => {
    platform.desktop = false
    $backgroundMode.set(true)

    expect(backgroundCloseTakesOver('main', true)).toBe(false)
  })
})
