import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { I18nProvider, useI18n } from './context'
import { createPluginI18n, registerPluginLocales, translatePlugin, usePluginI18n } from './plugin-i18n'
import { setRuntimeI18nLocale } from './runtime'
import type { Locale } from './types'

const noopTrack = (dispose: () => void) => dispose

afterEach(() => {
  cleanup()
  setRuntimeI18nLocale('en')
})

describe('plugin locale registry', () => {
  it('resolves the active locale, falling back to English then the raw key', () => {
    const dispose = registerPluginLocales('cost', {
      en: { panel: { title: 'Cost' }, spent: (n: number) => `$${n} spent` },
      ja: { panel: { title: 'コスト' } }
    })

    expect(translatePlugin('cost', 'ja', 'panel.title', [])).toBe('コスト')
    // Missing in ja → English.
    expect(translatePlugin('cost', 'ja', 'spent', [7])).toBe('$7 spent')
    // Missing everywhere → the key itself.
    expect(translatePlugin('cost', 'ja', 'nope', [])).toBe('nope')

    dispose()
  })

  it('scopes bundles per plugin — no cross-read', () => {
    const a = registerPluginLocales('a', { en: { hi: 'from a' } })
    const b = registerPluginLocales('b', { en: { hi: 'from b' } })

    expect(translatePlugin('a', 'en', 'hi', [])).toBe('from a')
    expect(translatePlugin('b', 'en', 'hi', [])).toBe('from b')
    // An unknown plugin resolves to the key.
    expect(translatePlugin('c', 'en', 'hi', [])).toBe('hi')

    a()
    b()
  })

  it('merges repeated registrations and drops everything on dispose', () => {
    const one = registerPluginLocales('merge', { en: { a: 'A' } })
    const two = registerPluginLocales('merge', { en: { b: 'B' }, ja: { a: 'あ' } })

    expect(translatePlugin('merge', 'en', 'a', [])).toBe('A')
    expect(translatePlugin('merge', 'en', 'b', [])).toBe('B')
    expect(translatePlugin('merge', 'ja', 'a', [])).toBe('あ')

    one()
    two()

    expect(translatePlugin('merge', 'en', 'a', [])).toBe('a')
  })

  it('never resolves a bundle for a locale universal cannot select', () => {
    // Desktop supports `ar`; universal's Locale union does not. A plugin shipping
    // one is not an error — resolution falls through to the plugin's `en`.
    const dispose = registerPluginLocales('wide', {
      ar: { greet: 'مرحبا' },
      en: { greet: 'hello' }
    } as never)

    expect(translatePlugin('wide', 'ar' as Locale, 'greet', [])).toBe('مرحبا')
    expect(translatePlugin('wide', 'en', 'greet', [])).toBe('hello')

    dispose()
  })

  it('ctx.i18n.t reads the app runtime locale', () => {
    const i18n = createPluginI18n('runtime-plugin', noopTrack)
    i18n.register({ en: { greet: 'hello' }, ja: { greet: 'こんにちは' } })

    expect(i18n.t('greet')).toBe('hello')

    setRuntimeI18nLocale('ja')
    expect(i18n.t('greet')).toBe('こんにちは')
  })

  it('ctx.i18n.register routes its disposer through track', () => {
    const tracked: Array<() => void> = []

    const i18n = createPluginI18n('tracked', dispose => {
      tracked.push(dispose)

      return dispose
    })

    i18n.register({ en: { greet: 'hi' } })

    expect(tracked).toHaveLength(1)
    expect(i18n.t('greet')).toBe('hi')

    // The loader tears bundles down through the tracked disposers on unload.
    for (const dispose of tracked) {
      dispose()
    }

    expect(i18n.t('greet')).toBe('greet')
  })
})

function Probe({ pluginId }: { pluginId: string }) {
  const t = usePluginI18n(pluginId)

  return <p data-testid="copy">{t('greet')}</p>
}

// Universal persists the locale in a localStorage-backed atom (desktop round-trips
// it through Hermes config), so a test that switches must switch back or it leaks
// into the next one.
function LocaleSwitch({ to }: { to: Locale }) {
  const { setLocale } = useI18n()

  return (
    <button onClick={() => void setLocale(to)} type="button">
      to {to}
    </button>
  )
}

describe('usePluginI18n', () => {
  it('re-renders on a locale switch', () => {
    const dispose = registerPluginLocales('hooked', {
      en: { greet: 'hello' },
      ja: { greet: 'こんにちは' }
    })

    render(
      <I18nProvider>
        <LocaleSwitch to="ja" />
        <LocaleSwitch to="en" />
        <Probe pluginId="hooked" />
      </I18nProvider>
    )

    expect(screen.getByTestId('copy').textContent).toBe('hello')

    fireEvent.click(screen.getByRole('button', { name: 'to ja' }))
    expect(screen.getByTestId('copy').textContent).toBe('こんにちは')

    fireEvent.click(screen.getByRole('button', { name: 'to en' }))
    expect(screen.getByTestId('copy').textContent).toBe('hello')

    dispose()
  })

  it('picks up a bundle registered after mount', () => {
    render(
      <I18nProvider>
        <Probe pluginId="late" />
      </I18nProvider>
    )

    expect(screen.getByTestId('copy').textContent).toBe('greet')

    let dispose = () => {}
    act(() => {
      dispose = registerPluginLocales('late', { en: { greet: 'landed' } })
    })

    expect(screen.getByTestId('copy').textContent).toBe('landed')

    dispose()
  })
})
