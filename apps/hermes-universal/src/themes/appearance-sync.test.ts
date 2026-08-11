import { beforeEach, describe, expect, it, vi } from 'vitest'

// The Tauri event bus, reduced to what the module uses — same shape as
// store/gateway-switch-sync.test.ts. `emit` broadcasts to every WebView INCLUDING
// the sender (which is why the payload carries an origin), and `listen` registers
// this WebView's receiver. Hoisted, because vi.mock's factory is lifted above
// ordinary top-level declarations.
const { emit, listen, listeners } = vi.hoisted(() => {
  const registered: Array<(event: { payload: unknown }) => void> = []

  return {
    emit: vi.fn().mockResolvedValue(undefined),
    listen: vi.fn((_name: string, handler: (event: { payload: unknown }) => void) => {
      registered.push(handler)

      return Promise.resolve(() => {})
    }),
    listeners: registered
  }
})

vi.mock('@tauri-apps/api/event', () => ({ emit, listen }))
// Without this the module short-circuits: there is no Tauri bus on plain web.
// Spread the real module so the theme context's own platform reads still work.
vi.mock('@/lib/platform', async importOriginal => ({
  ...(await importOriginal<typeof PlatformModule>()),
  IS_TAURI: true
}))

import type * as PlatformModule from '@/lib/platform'

import { APPEARANCE_EVENT, initAppearanceSync } from './appearance-sync'
import { $mode, $skin } from './context'

/** Deliver an event the way Tauri would — to every registered listener. */
function deliver(payload: unknown): void {
  for (const handler of listeners) {
    handler({ payload })
  }
}

/** The origin stamped on this WebView's own broadcasts. */
function ownOrigin(): string {
  $skin.set($skin.get() === 'mono' ? 'slate' : 'mono')

  return (emit.mock.calls.at(-1)?.[1] as { origin: string }).origin
}

beforeEach(() => {
  $skin.set('nous')
  $mode.set('system')
  vi.clearAllMocks()
})

describe('cross-WebView appearance sync', () => {
  it('broadcasts a skin switch so peer windows can repaint', () => {
    $skin.set('mono')

    expect(emit).toHaveBeenCalledOnce()
    const [name, payload] = emit.mock.calls[0]
    expect(name).toBe(APPEARANCE_EVENT)
    expect(payload).toMatchObject({ mode: 'system', skin: 'mono' })
    expect((payload as { origin: string }).origin).toBeTruthy()
  })

  it('broadcasts a light/dark switch too, not just the skin', () => {
    $mode.set('dark')

    expect(emit).toHaveBeenCalledOnce()
    expect(emit.mock.calls[0][1]).toMatchObject({ mode: 'dark', skin: 'nous' })
  })

  it('repaints this WebView from a peer switch', () => {
    deliver({ mode: 'dark', origin: 'some-other-webview', skin: 'mono' })

    expect($skin.get()).toBe('mono')
    expect($mode.get()).toBe('dark')
  })

  // A backend skin reaches each WebView on its own gateway event, so a peer can
  // legitimately name one this window has not been pushed yet. Downgrading it to
  // the default here would strand it — the ThemeProvider normalizes for paint.
  it('keeps a skin name it cannot resolve yet instead of falling back', () => {
    deliver({ mode: 'system', origin: 'elsewhere', skin: 'a-skin-hermes-just-authored' })

    expect($skin.get()).toBe('a-skin-hermes-just-authored')
  })

  // `emit` is global, so this WebView receives its own broadcast.
  it('ignores its own broadcast', () => {
    const origin = ownOrigin()
    $skin.set('nous')
    vi.clearAllMocks()

    deliver({ mode: 'dark', origin, skin: 'mono' })

    expect($skin.get()).toBe('nous')
    expect($mode.get()).toBe('system')
  })

  // Applying a peer's appearance moves the atoms, and the atoms are what triggers
  // a broadcast — so without the guard every switch would ping-pong across N
  // windows forever.
  it('does not re-broadcast the appearance it adopted from a peer', () => {
    deliver({ mode: 'dark', origin: 'elsewhere', skin: 'mono' })

    expect(emit).not.toHaveBeenCalled()
  })

  it('ignores a malformed event rather than painting nothing', () => {
    deliver(null)
    deliver({ mode: 'dark' })
    deliver({ origin: 'elsewhere', skin: 42 })

    expect($skin.get()).toBe('nous')
    expect($mode.get()).toBe('system')
  })

  // main.tsx imports this module for its side effect; an extra init (HMR, a test)
  // must not stack receivers, or one peer switch would be applied N times — and
  // must not stack announcers, or one local switch would emit N broadcasts.
  it('registers exactly one listener however many times it is initialised', () => {
    const before = listeners.length
    initAppearanceSync()
    initAppearanceSync()

    expect(listeners.length).toBe(before)

    $skin.set('mono')
    expect(emit).toHaveBeenCalledOnce()
  })
})
