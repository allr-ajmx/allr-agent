/**
 * User-installed themes registry — the extensibility seam the theme context
 * reads for `availableThemes` and every skin lookup, so an installed theme shows
 * up wherever a built-in does (the theme picker + `/skin`) with no per-surface
 * wiring.
 *
 * Ported from apps/desktop/src/themes/user-themes.ts, including the Marketplace
 * import surface (`marketplaceIdOf`, `$marketplaceInstalls`) — search + install
 * run through `store/marketplace.ts` and `app/settings/appearance-section.tsx`.
 * The registry is localStorage-backed. `atom` routes through the `@/store/atom`
 * seam.
 *
 * The one unexposed path is `installVscodeThemeFromText` (`themes/install.ts`),
 * which has no UI call site — there is no paste-JSON or file-picker surface.
 * Desktop has none either, so this is parity-neutral, not a gap.
 */

import { atom, computed } from '@/store/atom'

import { BUILTIN_THEMES } from './presets'
import type { DesktopTheme, DesktopThemeColors } from './types'

const USER_THEMES_KEY = 'hermes-user-themes-v1'

// Marketplace-imported themes carry `VS Code · <extensionId>` as their description
// (set by `buildThemeFromMarketplace`); the prefix is how we recover the id.
const MARKETPLACE_DESC_PREFIX = 'VS Code · '

// The minimal set of color keys a stored theme must carry to be usable. We keep
// this loose — `applyTheme` tolerates missing optionals via fallbacks — but a
// theme with no background/foreground/primary is junk and gets dropped.
const REQUIRED_COLOR_KEYS: ReadonlyArray<keyof DesktopThemeColors> = ['background', 'foreground', 'primary']

function isValidTheme(value: unknown): value is DesktopTheme {
  if (!value || typeof value !== 'object') {
    return false
  }

  const theme = value as Partial<DesktopTheme>

  if (typeof theme.name !== 'string' || typeof theme.label !== 'string' || !theme.colors) {
    return false
  }

  const colors = theme.colors as unknown as Record<string, unknown>

  return REQUIRED_COLOR_KEYS.every(key => typeof colors[key] === 'string')
}

function readStored(): Record<string, DesktopTheme> {
  try {
    const raw = window.localStorage.getItem(USER_THEMES_KEY)

    if (!raw) {
      return {}
    }

    const parsed: unknown = JSON.parse(raw)

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }

    const out: Record<string, DesktopTheme> = {}

    for (const [key, value] of Object.entries(parsed)) {
      // Never let a stored theme shadow a built-in name.
      if (!BUILTIN_THEMES[key] && isValidTheme(value)) {
        out[key] = value
      }
    }

    return out
  } catch {
    return {}
  }
}

function persist(record: Record<string, DesktopTheme>) {
  try {
    window.localStorage.setItem(USER_THEMES_KEY, JSON.stringify(record))
  } catch {
    // Best-effort: a restricted storage context shouldn't break theming.
  }
}

/** Reactive map of installed user themes, keyed by slug. */
export const $userThemes = atom<Record<string, DesktopTheme>>(typeof window === 'undefined' ? {} : readStored())

/** Install (or replace) a user theme. Returns the stored theme. */
export function installUserTheme(theme: DesktopTheme): DesktopTheme {
  if (BUILTIN_THEMES[theme.name]) {
    throw new Error(`"${theme.name}" collides with a built-in theme.`)
  }

  if (!isValidTheme(theme)) {
    throw new Error('Theme is missing required colors.')
  }

  const next = { ...$userThemes.get(), [theme.name]: theme }
  $userThemes.set(next)
  persist(next)

  return theme
}

/** Remove a user theme by slug. No-op for unknown / built-in names. */
export function removeUserTheme(name: string): void {
  const current = $userThemes.get()

  if (!current[name]) {
    return
  }

  const next = { ...current }
  delete next[name]
  $userThemes.set(next)
  persist(next)
}

export const isUserTheme = (name: string): boolean => Boolean($userThemes.get()[name])

/** The Marketplace extension id an installed theme came from, or null. */
export function marketplaceIdOf(theme: DesktopTheme): string | null {
  return theme.description.startsWith(MARKETPLACE_DESC_PREFIX)
    ? theme.description.slice(MARKETPLACE_DESC_PREFIX.length)
    : null
}

/**
 * Reactive `extensionId → installed theme` map, so the install UIs can mark
 * Marketplace rows you already have (and re-activate them without re-downloading)
 * from one memoized source instead of re-deriving the set on every render.
 */
export const $marketplaceInstalls = computed($userThemes, themes => {
  const map = new Map<string, DesktopTheme>()

  for (const theme of Object.values(themes)) {
    const id = marketplaceIdOf(theme)

    if (id) {
      map.set(id, theme)
    }
  }

  return map
})

/** Resolve a theme by name across the merged registry (built-in + user). */
export function resolveTheme(name: string): DesktopTheme | undefined {
  return BUILTIN_THEMES[name] ?? $userThemes.get()[name]
}

/** Built-ins first (stable order), then user themes by install order. */
export function listAllThemes(): DesktopTheme[] {
  return [...Object.values(BUILTIN_THEMES), ...Object.values($userThemes.get())]
}
