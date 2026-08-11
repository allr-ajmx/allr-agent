import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo } from 'react'

import { Codecs, persistentAtom } from '@/lib/persisted'
import { useStore } from '@/store/atom'

import { TRANSLATIONS } from './catalog'
import { DEFAULT_LOCALE, localeDirection, normalizeLocale } from './languages'
import { setRuntimeI18nLocale } from './runtime'
import type { Locale, Translations } from './types'

export { LOCALE_META } from './languages'

// Mobile persists the locale in localStorage (the desktop round-trips it through
// the Hermes config). Same public contract as desktop I18nContextValue so ported
// components + translateNow work unchanged; the async/config fields are trivially
// satisfied (localStorage is synchronous).
const $locale = persistentAtom<string>('hermes.locale', DEFAULT_LOCALE, Codecs.text)
setRuntimeI18nLocale(normalizeLocale($locale.get()))

export interface I18nContextValue {
  configLoadError: Error | null
  /** Writing direction of the active locale — mirrors the document's `dir`. */
  direction: 'ltr' | 'rtl'
  isLoadingConfig: boolean
  isSavingLocale: boolean
  locale: Locale
  saveError: Error | null
  setLocale: (next: Locale) => Promise<void>
  t: Translations
}

const I18nContext = createContext<I18nContextValue>({
  configLoadError: null,
  direction: 'ltr',
  isLoadingConfig: false,
  isSavingLocale: false,
  locale: DEFAULT_LOCALE,
  saveError: null,
  setLocale: async () => {},
  t: TRANSLATIONS[DEFAULT_LOCALE]
})

export function I18nProvider({ children }: { children: ReactNode }) {
  const locale = normalizeLocale(useStore($locale))

  useEffect(() => {
    setRuntimeI18nLocale(locale)
  }, [locale])

  // The document's `dir` and `lang` are the ONLY place RTL is switched on.
  // Everything downstream — CSS logical properties, `text-align: start`, native
  // caret and selection behaviour in inputs, the browser's own bidi resolution —
  // reads the inherited direction, so setting it here is what makes an Arabic UI
  // an Arabic UI rather than English text in Arabic glyphs. `lang` matters too:
  // it picks the right font fallback and hyphenation.
  useEffect(() => {
    if (typeof document === 'undefined') {
      return
    }

    document.documentElement.dir = localeDirection(locale)
    document.documentElement.lang = locale
  }, [locale])

  const setLocale = useCallback(async (next: Locale) => {
    $locale.set(next)
  }, [])

  const value = useMemo<I18nContextValue>(
    () => ({
      configLoadError: null,
      isLoadingConfig: false,
      isSavingLocale: false,
      direction: localeDirection(locale),
      locale,
      saveError: null,
      setLocale,
      t: TRANSLATIONS[locale]
    }),
    [locale, setLocale]
  )

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext)
}
