/**
 * Command surface for contributions — `palette` data contributions become rows in
 * universal's command menu, same schema as every other area. The app's own nav
 * destinations register here too (app/shell/nav-contrib.ts), so the menu renders
 * one list from one area rather than a built-in branch plus contributions.
 *
 * Kept at desktop's path (`app/command-palette/contrib.ts`) so ported code and the
 * SDK's import line match. Universal honours id / label / icon / keywords /
 * order / run, plus `action` (the live hotkey hint) and the core-only `labelKey`.
 * The palette renders app destinations and plugin commands in separate groups,
 * told apart by the contribution's `source`.
 */

import { useContributions } from '@/contrib/react/use-contributions'
import { translateFrom, TRANSLATIONS, useI18n } from '@/i18n'
import type { IconComponent } from '@/lib/icons'

export const PALETTE_AREA = 'palette'

/** Payload of a `palette` data contribution. */
export interface PaletteContribution {
  id: string
  /** Literal row label. Plugins set this; core rows use `labelKey` instead. */
  label?: string
  /** CORE ONLY: dot-path into the translation catalog (e.g. `nav.settings`), so
   *  the row follows the active locale instead of freezing at register time. */
  labelKey?: string
  /** Keybind action id — its live combo renders as the row's hotkey hint. */
  action?: string
  icon?: IconComponent
  /** Extra terms the menu's filter matches, beyond `label`. */
  keywords?: string[]
  run: () => void
}

export interface PaletteRow extends PaletteContribution {
  key: string
  label: string
  /** Registering source — `undefined` for the app's own rows, the plugin id for
   *  a plugin's. The palette groups core destinations and plugin commands
   *  separately on it. */
  source?: string
}

/** Command rows with stable render keys and locale-resolved labels. */
export function usePaletteContributions(): PaletteRow[] {
  const { locale } = useI18n()

  // Resolved off `locale` (not `translateNow`) so a language switch repaints the
  // menu in the same render the provider publishes it, with no stale frame.
  return useContributions(PALETTE_AREA)
    .map(c => {
      const data = c.data as PaletteContribution | undefined

      return {
        ...(data as PaletteContribution),
        key: `${c.source ?? 'core'}:${c.id}`,
        label: data?.label ?? (data?.labelKey ? translateFrom(l => TRANSLATIONS[l], locale, data.labelKey, []) : ''),
        source: c.source
      }
    })
    .filter(item => Boolean(item.label) && typeof item.run === 'function')
}
