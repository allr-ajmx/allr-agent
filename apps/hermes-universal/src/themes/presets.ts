/**
 * Built-in desktop themes. Names match the CLI skins / dashboard presets.
 * Add new themes here — no code changes needed elsewhere.
 */

import type { DesktopTheme, DesktopThemeTypography } from './types'

// Color-emoji fonts to append to every stack as a last resort. None of the UI
// text/mono fonts carry emoji glyphs, so without this emoji render as tofu
// boxes on platforms whose default text font lacks them (e.g. Linux/#40364).
// Covers macOS, Windows, Linux, plus the `emoji` generic for anything else.
export const EMOJI_FALLBACK = '"Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji", emoji'

// These are written onto --dt-font-sans/--dt-font-mono at runtime (see
// context.tsx applyTheme), so they OVERRIDE the styles.css defaults — keep the
// two copies in sync or the app silently renders the runtime one.
// Desktop's stack with packed Inter (@font-face in styles.css) slotted in ahead
// of `system-ui`: macOS/Windows keep the real SF Pro Text / Segoe UI, while
// Linux and Android render Inter — the closest open-source face to SF Pro Text
// — rather than the host's default. The generic tail is load-bearing rather
// than decorative: WebKitGTK resolves neither the Segoe/SF names nor
// `system-ui`, so without it `sans-serif` is what would actually render.
const SYSTEM_SANS =
  '"Segoe WPC", "Segoe UI", -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Inter", ' +
  '-webkit-system-ui, system-ui, "Noto Sans", sans-serif, ' +
  EMOJI_FALLBACK

// `ui-monospace` trails the concrete families: WebKitGTK maps it to the default
// SANS face, so leading with it unmonospaces code surfaces on Linux.
const SYSTEM_MONO =
  '"Cascadia Code", "JetBrains Mono", "SF Mono", Menlo, Monaco, Consolas, "DejaVu Sans Mono", "Liberation Mono", ' +
  'ui-monospace, monospace, ' +
  EMOJI_FALLBACK

export const DEFAULT_TYPOGRAPHY: DesktopThemeTypography = { fontSans: SYSTEM_SANS, fontMono: SYSTEM_MONO }

const NOUS_BLUE = '#0053FD'
const PSYCHE_BLUE = '#1540B1'
const PSYCHE_WARM = '#FFE6CB'

const nousTint = (pct: number) => `color-mix(in srgb, ${NOUS_BLUE} ${pct}%, #FFFFFF)`
const nousTintTransparent = (pct: number) => `color-mix(in srgb, ${NOUS_BLUE} ${pct}%, transparent)`

/**
 * Nous — canonical Allr desktop identity. The palette keeps the current
 * glass geometry neutral, then lets the old bb/gui blue and psyche cream
 * return as accent seeds.
 */
export const nousTheme: DesktopTheme = {
  name: 'nous',
  label: 'Nous',
  description: 'Glass neutrals with Nous blue accents',
  colors: {
    background: '#F8FAFF',
    foreground: '#17171A',
    card: '#FFFFFF',
    cardForeground: '#17171A',
    muted: nousTint(5),
    mutedForeground: '#666678',
    popover: '#FFFFFF',
    popoverForeground: '#17171A',
    primary: NOUS_BLUE,
    primaryForeground: '#FCFCFC',
    secondary: nousTint(7),
    secondaryForeground: '#242432',
    accent: nousTint(10),
    accentForeground: '#202030',
    border: nousTintTransparent(22),
    input: nousTintTransparent(30),
    ring: NOUS_BLUE,
    midground: NOUS_BLUE,
    composerRing: NOUS_BLUE,
    destructive: '#C72E4D',
    destructiveForeground: '#FFFFFF',
    sidebarBackground: '#F3F7FF',
    sidebarBorder: nousTintTransparent(18),
    userBubble: nousTint(6),
    userBubbleBorder: nousTintTransparent(24)
  },
  darkColors: {
    background: '#0D2F86',
    foreground: PSYCHE_WARM,
    card: '#12378F',
    cardForeground: PSYCHE_WARM,
    muted: '#183F9A',
    mutedForeground: '#B5C7F3',
    popover: '#123A96',
    popoverForeground: PSYCHE_WARM,
    primary: PSYCHE_WARM,
    primaryForeground: '#0D2F86',
    secondary: '#1B45A4',
    secondaryForeground: '#E0E8FF',
    accent: PSYCHE_BLUE,
    accentForeground: '#F0F4FF',
    border: '#3158AD',
    input: '#0B2566',
    ring: PSYCHE_WARM,
    midground: NOUS_BLUE,
    composerRing: PSYCHE_WARM,
    destructive: '#C0473A',
    destructiveForeground: '#FEF2F2',
    sidebarBackground: '#09286F',
    sidebarBorder: '#234A9C',
    userBubble: '#143B91',
    userBubbleBorder: '#3A63BD'
  },
  typography: {
    // Courier Prime is self-hosted (@font-face in styles.css) — no fontUrl.
    fontSans: SYSTEM_SANS,
    fontMono: `"Courier Prime", ${SYSTEM_MONO}`
  }
}

// ─── Allr ───────────────────────────────────────────────────────────────────
// Palette lifted from the Allr brand book. Two rules from that document drive
// the mapping below, and they are the reason this is not a straight hex swap:
//
//   • GREEN IS EARNED — completion, live status, primary CTA. Never decoration.
//   • HONEY IS ANTICIPATION — in-progress, focus rings, underlines.
//
// In this app `primary` paints buttons and CTAs, while `midground` (aliased to
// `--ui-accent`) paints focus rings, the streaming cursor, active-session pills
// and the branded scrollbar — all of which mean "working on it". So primary is
// green and midground/ring is honey, not the other way round.
//
// Third rule, applied throughout: ink is never pure black and paper is never
// pure white. `card` is the sole `#FFFFFF`, and it is a surface, never a text
// colour.
const ALLR_PAPER = '#FBF8F2'
const ALLR_BODY = '#F7F1E6' // the site's actual page background — warmer than paper
const ALLR_INK = '#223B33' // deep pine
const ALLR_INK_SOFT = '#5C7168'
const ALLR_HONEY = '#E9A83E' // lamplight
const ALLR_HONEY_DEEP = '#B77E1F'
const ALLR_HONEY_TINT = '#FBEFD8'
const ALLR_HONEY_LINE = '#F0DCB4'
// The brand's "done" green is #2E9E63; the theme uses green-deep so small white
// label text on primary controls stays legible.
const ALLR_GREEN_DEEP = '#1E7A49'
const ALLR_SAGE_TINT = '#ECF2EC'
const ALLR_CLAY = '#A6543C'

/** Strokes and dividers are ink at low alpha, so they stay pine-tinted rather
 *  than going grey against the warm surfaces. */
const allrInkTransparent = (pct: number) => `color-mix(in srgb, ${ALLR_INK} ${pct}%, transparent)`
const allrHoneyTint = (pct: number) => `color-mix(in srgb, ${ALLR_HONEY} ${pct}%, #FFFFFF)`

/**
 * Allr — warm evening paper under lamplight. The brand ships a single light
 * theme, so the dark variant below is ours: rather than let the synth pass
 * generate a neutral grey dark (which would read as a different product), it is
 * built by inverting around the pine ink the light theme already uses for text,
 * and keeping honey as the accent so focus and progress feel identical in both.
 */
export const allrTheme: DesktopTheme = {
  name: 'allr',
  label: 'Allr',
  description: 'Warm paper, honey and green',
  colors: {
    background: ALLR_PAPER,
    foreground: ALLR_INK,
    card: '#FFFFFF',
    cardForeground: ALLR_INK,
    muted: allrHoneyTint(8),
    mutedForeground: ALLR_INK_SOFT,
    popover: '#FFFFFF',
    popoverForeground: ALLR_INK,
    // The brand CTA is #2E9E63, but white-on-that is 3.39:1 — fine for the
    // site's 1.05rem bold buttons, short of AA for this app's 13px controls.
    // Green-deep is the brand's own CTA hover colour and clears 5.3:1.
    primary: ALLR_GREEN_DEEP,
    primaryForeground: '#FFFFFF',
    secondary: ALLR_HONEY_TINT,
    secondaryForeground: ALLR_INK,
    accent: ALLR_SAGE_TINT,
    accentForeground: ALLR_GREEN_DEEP,
    border: allrInkTransparent(14),
    input: allrInkTransparent(20),
    // Honey-DEEP rather than honey in light mode. #E9A83E against paper is
    // 1.95:1 — fine as a 3px outline on a marketing page, invisible as this
    // app's 1px focus rings, streaming cursor and accent text. #B77E1F is the
    // brand's own darker honey and clears the 3:1 non-text threshold.
    ring: ALLR_HONEY_DEEP,
    midground: ALLR_HONEY_DEEP,
    composerRing: ALLR_HONEY_DEEP,
    destructive: ALLR_CLAY,
    destructiveForeground: '#FFFFFF',
    sidebarBackground: ALLR_BODY,
    sidebarBorder: allrInkTransparent(11),
    userBubble: ALLR_HONEY_TINT,
    userBubbleBorder: ALLR_HONEY_LINE
  },
  darkColors: {
    background: '#16241F',
    foreground: '#F0E9DA',
    card: ALLR_INK,
    cardForeground: '#F0E9DA',
    muted: '#2B4139',
    mutedForeground: '#A9BDB2',
    popover: ALLR_INK,
    popoverForeground: '#F0E9DA',
    // Lifted off #2E9E63 — the brand green is tuned for white and drops below
    // 4.5:1 against pine.
    primary: '#45B87F',
    primaryForeground: '#0F1C17',
    secondary: '#2E4A40',
    secondaryForeground: '#F0E9DA',
    accent: '#2E4A40',
    accentForeground: '#F6C56B',
    border: '#2F4A40',
    input: '#3A574C',
    ring: ALLR_HONEY,
    midground: ALLR_HONEY,
    composerRing: ALLR_HONEY,
    destructive: '#D98A72',
    destructiveForeground: '#1B0F0B',
    sidebarBackground: '#101C18',
    sidebarBorder: '#2F4A40',
    userBubble: '#2A4239',
    userBubbleBorder: '#3E5D51'
  },
  typography: {
    // Nunito Sans and Courier Prime are both vendored (@font-face in
    // styles.css) — no fontUrl. The system stack stays in the tail so the
    // subset faces have something to fall through to outside latin/latin-ext.
    fontSans: `"Nunito Sans", ${SYSTEM_SANS}`,
    // The brand book flags mono as an open gap. Courier Prime is the warm
    // typewriter face already in the bundle — it suits paper far better than
    // the grid-y developer monos.
    fontMono: `"Courier Prime", ${SYSTEM_MONO}`
  }
}

/** Deep blue-violet with cool accents. Matches the dashboard midnight theme. */
export const midnightTheme: DesktopTheme = {
  name: 'midnight',
  label: 'Midnight',
  description: 'Deep blue-violet with cool accents',
  colors: {
    background: '#08081c',
    foreground: '#ddd6ff',
    card: '#0d0d28',
    cardForeground: '#ddd6ff',
    muted: '#13133a',
    mutedForeground: '#7c7ab0',
    popover: '#0f0f2e',
    popoverForeground: '#ddd6ff',
    primary: '#ddd6ff',
    primaryForeground: '#08081c',
    secondary: '#1a1a4a',
    secondaryForeground: '#c4bff0',
    accent: '#1a1a44',
    accentForeground: '#d0c8ff',
    border: '#1e1e52',
    input: '#1e1e52',
    ring: '#8b80e8',
    midground: '#8b80e8',
    destructive: '#b03060',
    destructiveForeground: '#fef2f2',
    sidebarBackground: '#06061a',
    sidebarBorder: '#12123a',
    userBubble: '#14143a',
    userBubbleBorder: '#242466'
  },
  typography: {
    // JetBrains Mono is bundled (@font-face in styles.css) — no fontUrl.
    fontMono: `"JetBrains Mono", ${SYSTEM_MONO}`
  }
}

/** Warm crimson and bronze — forge vibes. Matches the CLI ares skin. */
export const emberTheme: DesktopTheme = {
  name: 'ember',
  label: 'Ember',
  description: 'Warm crimson and bronze — forge vibes',
  colors: {
    background: '#160800',
    foreground: '#ffd8b0',
    card: '#1e0e04',
    cardForeground: '#ffd8b0',
    muted: '#2a1408',
    mutedForeground: '#aa7a56',
    popover: '#221008',
    popoverForeground: '#ffd8b0',
    primary: '#ffd8b0',
    primaryForeground: '#160800',
    secondary: '#341800',
    secondaryForeground: '#f0c090',
    accent: '#301600',
    accentForeground: '#e8c080',
    border: '#3a1c08',
    input: '#3a1c08',
    ring: '#d97316',
    midground: '#d97316',
    destructive: '#c43010',
    destructiveForeground: '#fef2f2',
    sidebarBackground: '#100600',
    sidebarBorder: '#2a1004',
    userBubble: '#2a1000',
    userBubbleBorder: '#4a2010'
  },
  typography: {
    // IBM Plex Mono is self-hosted (@font-face in styles.css) — no fontUrl.
    fontMono: `"IBM Plex Mono", ${SYSTEM_MONO}`
  }
}

/** Clean grayscale. Matches the CLI mono skin and dashboard mono theme. */
export const monoTheme: DesktopTheme = {
  name: 'mono',
  label: 'Mono',
  description: 'Clean grayscale — minimal and focused',
  colors: {
    background: '#0e0e0e',
    foreground: '#eaeaea',
    card: '#141414',
    cardForeground: '#eaeaea',
    muted: '#1e1e1e',
    mutedForeground: '#808080',
    popover: '#181818',
    popoverForeground: '#eaeaea',
    primary: '#eaeaea',
    primaryForeground: '#0e0e0e',
    secondary: '#262626',
    secondaryForeground: '#c8c8c8',
    accent: '#222222',
    accentForeground: '#d8d8d8',
    border: '#2a2a2a',
    input: '#2a2a2a',
    ring: '#9a9a9a',
    midground: '#9a9a9a',
    destructive: '#a84040',
    destructiveForeground: '#fef2f2',
    sidebarBackground: '#0a0a0a',
    sidebarBorder: '#202020',
    userBubble: '#1a1a1a',
    userBubbleBorder: '#363636'
  }
}

/** Neon green on black. Matches the CLI cyberpunk skin and dashboard theme. */
export const cyberpunkTheme: DesktopTheme = {
  name: 'cyberpunk',
  label: 'Cyberpunk',
  description: 'Neon green on black — matrix terminal',
  colors: {
    background: '#000a00',
    foreground: '#00ff41',
    card: '#001200',
    cardForeground: '#00ff41',
    muted: '#001a00',
    mutedForeground: '#1a8a30',
    popover: '#001000',
    popoverForeground: '#00ff41',
    primary: '#00ff41',
    primaryForeground: '#000a00',
    secondary: '#002800',
    secondaryForeground: '#00cc34',
    accent: '#002000',
    accentForeground: '#00e038',
    border: '#003000',
    input: '#003000',
    ring: '#00ff41',
    midground: '#00ff41',
    destructive: '#ff003c',
    destructiveForeground: '#000a00',
    sidebarBackground: '#000600',
    sidebarBorder: '#001800',
    userBubble: '#001400',
    userBubbleBorder: '#004800'
  },
  typography: {
    // "Courier New" ships on Windows/macOS only, so on Linux/Android this skin
    // used to fall through to the generic and lose its typewriter look
    // entirely. The packed Courier Prime sits right behind it as the same
    // intent, rendered from a face we control.
    fontMono: `"Courier New", "Courier Prime", Courier, monospace, ${EMOJI_FALLBACK}`,
    fontSans: `"Courier New", "Courier Prime", Courier, monospace, ${EMOJI_FALLBACK}`
  }
}

/** Cool slate blue for developers. Matches the CLI slate skin. */
export const slateTheme: DesktopTheme = {
  name: 'slate',
  label: 'Slate',
  description: 'Cool slate blue — focused developer theme',
  colors: {
    background: '#0d1117',
    foreground: '#c9d1d9',
    card: '#161b22',
    cardForeground: '#c9d1d9',
    muted: '#21262d',
    mutedForeground: '#8b949e',
    popover: '#1c2128',
    popoverForeground: '#c9d1d9',
    primary: '#c9d1d9',
    primaryForeground: '#0d1117',
    secondary: '#2a3038',
    secondaryForeground: '#adb5bf',
    accent: '#1e2530',
    accentForeground: '#c0c8d0',
    border: '#30363d',
    input: '#30363d',
    ring: '#58a6ff',
    midground: '#58a6ff',
    destructive: '#cf4848',
    destructiveForeground: '#fef2f2',
    sidebarBackground: '#090d13',
    sidebarBorder: '#1c2228',
    userBubble: '#1e2a38',
    userBubbleBorder: '#2e4060'
  },
  typography: {
    fontMono: `"JetBrains Mono", ${SYSTEM_MONO}`
  }
}

export const BUILTIN_THEMES: Record<string, DesktopTheme> = {
  allr: allrTheme,
  nous: nousTheme,
  midnight: midnightTheme,
  ember: emberTheme,
  mono: monoTheme,
  cyberpunk: cyberpunkTheme,
  slate: slateTheme
}

export const BUILTIN_THEME_LIST = Object.values(BUILTIN_THEMES)

/** Skin used when nothing is persisted or the persisted name is retired. */
export const DEFAULT_SKIN_NAME = 'allr'
