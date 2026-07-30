/**
 * Command surface for contributions — `palette` data contributions become rows in
 * universal's command menu, same schema as every other area.
 *
 * Kept at desktop's path (`app/command-palette/contrib.ts`) so ported code and the
 * SDK's import line match, even though universal's surface is a command MENU
 * (app/shell/command-menu.tsx: a filtered list in a Dialog) rather than desktop's
 * full ⌘K palette. Universal honours id / label / icon / keywords / order / run.
 *
 * Dropped from desktop's `PaletteContribution`: `action` (a keybind action id
 * whose live combo renders as a hotkey hint) — universal's menu shows no hotkey
 * column, and a plugin wanting a shortcut contributes to `keybinds` instead.
 */

import { useContributions } from '@/contrib/react/use-contributions'
import type { IconComponent } from '@/lib/icons'

export const PALETTE_AREA = 'palette'

/** Payload of a `palette` data contribution. */
export interface PaletteContribution {
  id: string
  label: string
  icon?: IconComponent
  /** Extra terms the menu's filter matches, beyond `label`. */
  keywords?: string[]
  run: () => void
}

/** Contributed command rows, with stable render keys. */
export function usePaletteContributions(): Array<PaletteContribution & { key: string }> {
  return useContributions(PALETTE_AREA)
    .map(c => ({ key: `${c.source ?? 'core'}:${c.id}`, ...(c.data as PaletteContribution) }))
    .filter(item => Boolean(item.label && item.run))
}
