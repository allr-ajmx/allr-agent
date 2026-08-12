import { beforeEach, describe, expect, it, vi } from 'vitest'

// The Tauri event bus, reduced to what the module uses — same shape as
// themes/appearance-sync.test.ts. `emit` broadcasts to every WebView INCLUDING
// the sender (which is why the payload carries an origin), and `listen`
// registers this WebView's receiver.
const { emit, listen, listeners, profile } = vi.hoisted(() => {
  const registered: Array<(event: { payload: unknown }) => void> = []

  return {
    emit: vi.fn().mockResolvedValue(undefined),
    listen: vi.fn((_name: string, handler: (event: { payload: unknown }) => void) => {
      registered.push(handler)

      return Promise.resolve(() => {})
    }),
    listeners: registered,
    profile: { name: 'default' }
  }
})

vi.mock('@tauri-apps/api/event', () => ({ emit, listen }))
// Without this the module short-circuits: there is no Tauri bus on plain web.
vi.mock('@/lib/platform', async importOriginal => ({
  ...(await importOriginal<typeof PlatformModule>()),
  IS_TAURI: true
}))
// The real store pulls the whole profile/gateway graph in for one `.get()`.
vi.mock('@/store/profile', () => ({ $activeGatewayProfile: { get: () => profile.name } }))

import type * as PlatformModule from '@/lib/platform'

import { $terminalFontFamily } from './terminal-font'
import { TERMINAL_FONT_EVENT, type TerminalFontChangedPayload } from './terminal-font-sync'

/** Deliver an event the way Tauri would — to every registered listener. */
function deliver(payload: unknown): void {
  for (const handler of listeners) {
    handler({ payload })
  }
}

/** The origin stamped on this WebView's own broadcasts. */
function ownOrigin(): string {
  $terminalFontFamily.set($terminalFontFamily.get() === 'probe-a' ? 'probe-b' : 'probe-a')

  return (emit.mock.calls.at(-1)?.[1] as TerminalFontChangedPayload).origin
}

beforeEach(() => {
  profile.name = 'default'
  $terminalFontFamily.set('')
  vi.clearAllMocks()
})

describe('cross-WebView terminal font sync', () => {
  it('broadcasts a font change so peer windows re-face their terminals', () => {
    $terminalFontFamily.set('MesloLGS NF')

    expect(emit).toHaveBeenCalledOnce()
    const [name, payload] = emit.mock.calls[0]
    expect(name).toBe(TERMINAL_FONT_EVENT)
    expect(payload).toMatchObject({ family: 'MesloLGS NF', profile: 'default' })
    expect((payload as TerminalFontChangedPayload).origin).toBeTruthy()
  })

  it('stamps the profile it is scoped to, not a fixed one', () => {
    profile.name = 'work'
    $terminalFontFamily.set('Hack Nerd Font')

    expect(emit.mock.calls[0][1]).toMatchObject({ family: 'Hack Nerd Font', profile: 'work' })
  })

  it('adopts a peer WebView font — the Android Settings-activity case', () => {
    deliver({ family: 'Hack Nerd Font', origin: 'other-webview', profile: 'default' })

    expect($terminalFontFamily.get()).toBe('Hack Nerd Font')
  })

  it('adopts a clear back to the bundled default', () => {
    $terminalFontFamily.set('MesloLGS NF')
    deliver({ family: '', origin: 'other-webview', profile: 'default' })

    expect($terminalFontFamily.get()).toBe('')
  })

  it('normalizes what a peer sent rather than trusting it verbatim', () => {
    deliver({ family: '  MesloLGS NF  ', origin: 'other-webview', profile: 'default' })

    expect($terminalFontFamily.get()).toBe('MesloLGS NF')
  })

  it('never re-broadcasts what it adopted, so an event cannot circulate', () => {
    const origin = ownOrigin()
    vi.clearAllMocks()

    deliver({ family: 'Hack Nerd Font', origin: 'other-webview', profile: 'default' })

    expect($terminalFontFamily.get()).toBe('Hack Nerd Font')
    expect(emit).not.toHaveBeenCalled()
    expect(origin).not.toBe('other-webview')
  })

  it('drops its own echo — emit is global, so the sender hears itself', () => {
    const origin = ownOrigin()
    $terminalFontFamily.set('MesloLGS NF')
    vi.clearAllMocks()

    deliver({ family: 'Not Applied', origin, profile: 'default' })

    expect($terminalFontFamily.get()).toBe('MesloLGS NF')
  })

  it('ignores a peer scoped to another profile — this is profile config', () => {
    $terminalFontFamily.set('MesloLGS NF')

    deliver({ family: 'Hack Nerd Font', origin: 'other-webview', profile: 'work' })

    expect($terminalFontFamily.get()).toBe('MesloLGS NF')
  })

  it('ignores a malformed payload instead of blanking the font', () => {
    $terminalFontFamily.set('MesloLGS NF')

    deliver(null)
    deliver({ family: 'Hack Nerd Font', profile: 'default' })
    deliver({ family: 42, origin: 'other-webview', profile: 'default' })

    expect($terminalFontFamily.get()).toBe('MesloLGS NF')
  })
})
