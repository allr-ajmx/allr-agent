import { normalize } from '@/lib/text'

import type { Locale } from './types'

export const DEFAULT_LOCALE: Locale = 'en'

export const LOCALE_OPTIONS = [
  {
    id: 'en',
    name: 'English',
    englishName: 'English',
    configValue: 'en'
  },
  {
    id: 'zh',
    name: '简体中文',
    englishName: 'Simplified Chinese',
    configValue: 'zh'
  },
  {
    id: 'zh-hant',
    name: '繁體中文',
    englishName: 'Traditional Chinese',
    configValue: 'zh-hant'
  },
  {
    id: 'ja',
    name: '日本語',
    englishName: 'Japanese',
    configValue: 'ja'
  },
  {
    id: 'ar',
    name: 'العربية',
    englishName: 'Arabic',
    configValue: 'ar'
  }
] as const satisfies readonly { configValue: string; englishName: string; id: Locale; name: string }[]

/**
 * Writing direction per locale.
 *
 * Kept as an explicit table rather than derived from the language tag: the set
 * of locales is small and curated, and a wrong guess here flips the entire
 * layout. Everything not listed is left-to-right.
 */
export const LOCALE_DIRECTION: Record<Locale, 'ltr' | 'rtl'> = {
  ar: 'rtl',
  en: 'ltr',
  ja: 'ltr',
  zh: 'ltr',
  'zh-hant': 'ltr'
}

export function localeDirection(locale: Locale): 'ltr' | 'rtl' {
  return LOCALE_DIRECTION[locale] ?? 'ltr'
}

// `name` is the endonym (native name) shown in the picker so users recognize
// their language regardless of the current UI language. No country flags:
// languages are not countries. `englishName` is search-only (not shown) so an
// English speaker can type "japanese"/"traditional" to filter the list.
export const LOCALE_META: Record<Locale, { name: string; englishName: string }> = Object.fromEntries(
  LOCALE_OPTIONS.map(locale => [locale.id, { name: locale.name, englishName: locale.englishName }])
) as Record<Locale, { name: string; englishName: string }>

const LOCALE_ALIASES: Record<string, Locale> = {
  en: 'en',
  'en-us': 'en',
  en_us: 'en',
  zh: 'zh',
  'zh-cn': 'zh',
  zh_cn: 'zh',
  'zh-hans': 'zh',
  zh_hans: 'zh',
  'zh-hans-cn': 'zh',
  zh_hans_cn: 'zh',
  'zh-tw': 'zh-hant',
  zh_tw: 'zh-hant',
  'zh-hk': 'zh-hant',
  zh_hk: 'zh-hant',
  'zh-mo': 'zh-hant',
  zh_mo: 'zh-hant',
  'zh-hant': 'zh-hant',
  zh_hant: 'zh-hant',
  'zh-hant-tw': 'zh-hant',
  zh_hant_tw: 'zh-hant',
  'zh-hant-hk': 'zh-hant',
  zh_hant_hk: 'zh-hant',
  ja: 'ja',
  'ja-jp': 'ja',
  ja_jp: 'ja',
  // Arabic is one UI locale across every region — the dialects differ in speech
  // far more than in the written MSA these strings are in, so every ar-* tag
  // resolves to the same catalogue rather than 20 near-identical entries.
  ar: 'ar',
  'ar-ae': 'ar',
  ar_ae: 'ar',
  'ar-dz': 'ar',
  ar_dz: 'ar',
  'ar-eg': 'ar',
  ar_eg: 'ar',
  'ar-iq': 'ar',
  ar_iq: 'ar',
  'ar-jo': 'ar',
  ar_jo: 'ar',
  'ar-kw': 'ar',
  ar_kw: 'ar',
  'ar-lb': 'ar',
  ar_lb: 'ar',
  'ar-ma': 'ar',
  ar_ma: 'ar',
  'ar-qa': 'ar',
  ar_qa: 'ar',
  'ar-sa': 'ar',
  ar_sa: 'ar',
  'ar-tn': 'ar',
  ar_tn: 'ar'
}

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && LOCALE_OPTIONS.some(locale => locale.id === value)
}

export function normalizeLocale(value: unknown): Locale {
  if (typeof value !== 'string') {
    return DEFAULT_LOCALE
  }

  return LOCALE_ALIASES[normalize(value)] ?? DEFAULT_LOCALE
}

export function isSupportedLocaleValue(value: unknown): boolean {
  return typeof value === 'string' && LOCALE_ALIASES[normalize(value)] != null
}

export function localeConfigValue(locale: Locale): string {
  return LOCALE_OPTIONS.find(item => item.id === locale)?.configValue ?? DEFAULT_LOCALE
}
