import { atom } from 'nanostores'

/**
 * The terminal's font family, driven by the profile config key
 * `terminal.font_family`.
 *
 * Two halves, and only one of them is here. This module owns CONSUMPTION: the
 * live value, how a friendly name becomes a CSS stack, and how a change is
 * applied to a running xterm without recreating it or its PTY. The Settings
 * picker that WRITES the key belongs to the settings pages, which SE-F owns —
 * see the note on MJXHRM-221. Until it lands the key is still honoured, it is
 * just set by editing config.yaml rather than by a picker.
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
 * Pull `terminal.font_family` off the profile config into the live atom.
 *
 * Called by the terminal pane on mount rather than from an app-wide bootstrap:
 * universal has no side-effecting config hook (desktop's `use-hermes-config`
 * has no counterpart here), and the pane is the only consumer — so the value is
 * fetched exactly when something can use it. The Settings picker, once SE-F
 * lands it, calls `setTerminalFontFamilyFromConfig` directly on save so the
 * change is live before the write round-trips.
 *
 * The fetcher is injected so a test does not drag the REST layer in.
 */
export async function syncTerminalFontFromConfig(
  load: () => Promise<{ terminal?: { font_family?: string } }>
): Promise<void> {
  try {
    setTerminalFontFamilyFromConfig((await load()).terminal?.font_family)
  } catch {
    /* config unreachable — the bundled default stands */
  }
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
