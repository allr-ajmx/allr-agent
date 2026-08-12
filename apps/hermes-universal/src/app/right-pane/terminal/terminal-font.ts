import { atom } from 'nanostores'

/**
 * The terminal's font family, driven by the profile config key
 * `terminal.font_family`.
 *
 * This module owns CONSUMPTION: the live value, how a friendly name becomes a
 * CSS stack, and how a change is applied to a running xterm without recreating
 * it or its PTY. The Settings picker that WRITES the key lives in
 * `app/settings/terminal-font-setting.tsx`; it pushes the new value into the
 * atom on every keystroke so the open terminal re-renders before the save even
 * round-trips. `./use-terminal-font-config` feeds the atom from the shared
 * config-record query, and `./terminal-font-sync` carries a change to the OTHER
 * WebViews — the atom below is per-WebView, and the picker and the terminal it
 * re-faces are not always in the same one.
 */

export const DEFAULT_TERMINAL_FONT_FAMILY = "'JetBrains Mono', 'Cascadia Code', 'SF Mono', Menlo, Consolas, monospace"

/** Families worth offering in a picker — Nerd Font builds first, because a
 *  powerline prompt is the reason anyone changes this setting. */
export const TERMINAL_FONT_SUGGESTIONS = [
  'MesloLGS NF',
  'JetBrainsMono Nerd Font',
  'CaskaydiaCove Nerd Font',
  'FiraCode Nerd Font',
  'Hack Nerd Font',
  'SauceCodePro Nerd Font',
  'JetBrains Mono',
  'SF Mono',
  'Menlo',
  'Cascadia Code'
] as const

/** The profile-backed value as written in config.yaml. Empty = bundled default. */
export const $terminalFontFamily = atom('')

export function normalizeTerminalFontFamily(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function quoteSingleFamily(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

/** Accept a friendly single family name OR an authored CSS font stack. The
 *  bundled default is always appended, so a name the host doesn't have falls
 *  back to a readable monospace face instead of the browser's proportional one. */
export function resolveTerminalFontFamily(value: unknown): string {
  const configured = normalizeTerminalFontFamily(value)

  if (!configured) {
    return DEFAULT_TERMINAL_FONT_FAMILY
  }

  const preferred = configured.includes(',') || /['"]/.test(configured) ? configured : quoteSingleFamily(configured)

  return `${preferred}, ${DEFAULT_TERMINAL_FONT_FAMILY}`
}

export function setTerminalFontFamilyFromConfig(value: unknown): void {
  $terminalFontFamily.set(normalizeTerminalFontFamily(value))
}

/**
 * Read `terminal.font_family` out of a profile config record.
 *
 * Takes the whole record rather than fetching, because both consumers already
 * hold one: the terminal pane and the Settings picker each read the SHARED
 * `use-config-record` query. That shared cache IS the config→atom sync — any
 * surface that saves or revalidates it re-pushes the family into the atom, so a
 * `config.yaml` value no longer waits for a pane remount to be seen.
 */
export function terminalFontFamilyFromConfig(config: unknown): string {
  const terminal = (config as { terminal?: unknown } | null | undefined)?.terminal

  return normalizeTerminalFontFamily((terminal as { font_family?: unknown } | null | undefined)?.font_family)
}

type FontFaceLoader = Pick<FontFaceSet, 'load'>

function browserFontSet(): FontFaceLoader | undefined {
  return typeof document === 'undefined' ? undefined : document.fonts
}

/** Warm every face xterm uses BEFORE WebGL builds its glyph texture atlas — an
 *  atlas built on the fallback face keeps the fallback's metrics for the rest of
 *  the session. */
export async function warmTerminalFontFamily(
  fontFamily: string,
  fontSet: FontFaceLoader | undefined = browserFontSet()
): Promise<void> {
  if (!fontSet?.load) {
    return
  }

  await Promise.allSettled(
    ['400', '700', 'italic 400'].map(descriptor =>
      Promise.resolve().then(() => fontSet.load(`${descriptor} 11px ${fontFamily}`))
    )
  )
}

export interface TerminalFontTarget {
  options: { fontFamily?: string }
  rows: number
  refresh: (start: number, end: number) => void
}

interface ApplyTerminalFontOptions {
  clearTextureAtlas: () => void
  fit: () => void
  fontFamily: string
  isCurrent: () => boolean
  term: TerminalFontTarget
  warm?: (fontFamily: string) => Promise<void>
}

/**
 * Apply a live font change without recreating the xterm instance or its PTY —
 * which is what makes the setting apply "without a restart" rather than
 * respawning the user's shell out from under them.
 *
 * Order matters: warm the face, set it, re-fit (the cell size changed, so the
 * grid did), then drop the texture atlas and repaint. Clearing the atlas before
 * the fit would rebuild it at the old grid size and immediately throw it away.
 * `isCurrent` bails on a change that was superseded while the face loaded.
 */
export async function applyTerminalFontFamily({
  clearTextureAtlas,
  fit,
  fontFamily,
  isCurrent,
  term,
  warm = warmTerminalFontFamily
}: ApplyTerminalFontOptions): Promise<boolean> {
  await warm(fontFamily)

  if (!isCurrent()) {
    return false
  }

  term.options.fontFamily = fontFamily
  fit()
  clearTextureAtlas()

  if (term.rows > 0) {
    term.refresh(0, term.rows - 1)
  }

  return true
}
