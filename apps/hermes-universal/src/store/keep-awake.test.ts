import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn(async () => undefined) }))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@/lib/platform', () => ({ IS_DESKTOP: true }))

import { $keepAwake, initKeepAwake, setKeepAwake, toggleKeepAwake } from './keep-awake'

beforeEach(() => {
  invoke.mockClear()
  $keepAwake.set(false)
  invoke.mockClear()
  localStorage.clear()
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

  it('never surfaces a failing native call', async () => {
    invoke.mockRejectedValueOnce(new Error('unsupported_platform'))

    expect(() => setKeepAwake(true)).not.toThrow()
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled())
    expect($keepAwake.get()).toBe(true)
  })
})
