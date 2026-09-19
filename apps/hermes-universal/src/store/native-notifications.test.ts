import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: vi.fn(async () => true),
  requestPermission: vi.fn(async () => 'granted'),
  sendNotification: vi.fn()
}))

import { sendNotification } from '@tauri-apps/plugin-notification'

import {
  $nativeNotifyPrefs,
  dispatchNativeNotification,
  dispatchPluginNativeNotification,
  setNativeNotifyEnabled,
  setNativeNotifyKind
} from './native-notifications'

const send = vi.mocked(sendNotification)
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

// isBackgrounded() = document.hidden || !hasFocus(). Drive it via hasFocus.
function setBackgrounded(bg: boolean) {
  document.hasFocus = () => !bg
}

describe('native-notifications dispatch', () => {
  beforeEach(() => {
    send.mockClear()
    localStorage.clear()
    $nativeNotifyPrefs.set({
      enabled: true,
      kinds: {
        approval: true,
        backgroundDone: true,
        credits: true,
        input: true,
        plugin: true,
        turnDone: true,
        turnError: true
      }
    })
  })
  afterEach(() => setBackgrounded(false))

  it('fires when the app is backgrounded', async () => {
    setBackgrounded(true)
    dispatchNativeNotification({ kind: 'turnDone', title: 'done', body: 'ready', sessionId: 's1' })
    await flush()
    expect(send).toHaveBeenCalledWith({ title: 'done', body: 'ready' })
  })

  it('does not fire while the app is foregrounded', async () => {
    setBackgrounded(false)
    dispatchNativeNotification({ kind: 'turnDone', title: 'done', sessionId: 's2' })
    await flush()
    expect(send).not.toHaveBeenCalled()
  })

  it('respects the global enabled toggle', async () => {
    setBackgrounded(true)
    setNativeNotifyEnabled(false)
    dispatchNativeNotification({ kind: 'turnError', title: 'boom', sessionId: 's3' })
    await flush()
    expect(send).not.toHaveBeenCalled()
  })

  it('respects a per-kind toggle', async () => {
    setBackgrounded(true)
    setNativeNotifyKind('approval', false)
    dispatchNativeNotification({ kind: 'approval', title: 'approve', sessionId: 's4' })
    await flush()
    expect(send).not.toHaveBeenCalled()
  })

  it('throttles a repeated kind+session inside the window', async () => {
    setBackgrounded(true)
    dispatchNativeNotification({ kind: 'turnDone', title: 'a', sessionId: 's5' })
    dispatchNativeNotification({ kind: 'turnDone', title: 'b', sessionId: 's5' })
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
  })
})

describe('the plugin notification door', () => {
  beforeEach(() => {
    send.mockClear()
    localStorage.clear()
    $nativeNotifyPrefs.set({
      enabled: true,
      kinds: {
        approval: true,
        backgroundDone: true,
        credits: true,
        input: true,
        plugin: true,
        turnDone: true,
        turnError: true
      }
    })
  })
  afterEach(() => setBackgrounded(false))

  it('fires under the plugin kind while the app is backgrounded', async () => {
    setBackgrounded(true)
    dispatchPluginNativeNotification('kanban', { title: 'Board moved', body: 'to Done', silent: true })
    await flush()
    expect(send).toHaveBeenCalledWith({ title: 'Board moved', body: 'to Done', silent: true })
  })

  it('is gated by the plugin toggle alone, not by the other kinds', async () => {
    setBackgrounded(true)
    setNativeNotifyKind('plugin', false)
    dispatchPluginNativeNotification('kanban', { title: 'Board moved' })
    await flush()
    expect(send).not.toHaveBeenCalled()
  })

  it('defaults a kind the stored prefs predate rather than reading it back as off', async () => {
    // Written by a build that had no `plugin` kind: without the sanitizer merge
    // it decodes to `undefined`, which reads as "the user turned this off".
    localStorage.setItem(
      'hermes.native-notifications',
      JSON.stringify({
        enabled: true,
        kinds: { approval: false, backgroundDone: true, input: true, turnDone: true, turnError: true }
      })
    )
    vi.resetModules()

    const { $nativeNotifyPrefs: reloaded } = await import('./native-notifications')

    expect(reloaded.get().kinds.plugin).toBe(true)
    // The user's own choices still win.
    expect(reloaded.get().kinds.approval).toBe(false)
  })

  it('keys throttling by plugin id so two plugins cannot collapse each other', async () => {
    setBackgrounded(true)
    dispatchPluginNativeNotification('alpha', { title: 'from alpha' })
    dispatchPluginNativeNotification('beta', { title: 'from beta' })
    dispatchPluginNativeNotification('alpha', { title: 'alpha again' })
    await flush()
    expect(send).toHaveBeenCalledTimes(2)
  })
})
