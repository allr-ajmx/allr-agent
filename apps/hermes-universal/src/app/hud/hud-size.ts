/**
 * How tall the HUD's window wants to be (MJXHRM-438).
 *
 * Pure, and separate from the hook that measures, because the arithmetic is the
 * part that can be wrong in a way nothing else notices: a window that stopped
 * growing looks identical whether the cap was applied, the request was dropped,
 * or the measurement was zero.
 *
 * WHAT IS MEASURED, AND WHY IT IS NOT THE CARD. On the plain-toplevel path the
 * card is `h-full` — it IS the window's inner box — so a resize driven by the
 * card's own height is a fixed point that can never grow past where it already
 * is. What has to be measured is what the content WANTS, which is independent
 * of the window: the input bar (`[data-slot='composer-root']`) and the natural
 * height of the transcript (`[data-slot='aui_thread-content']`, the content box
 * inside the scroller, not the scroller).
 */

/** The bar and nothing else. Must match `HUD_COLLAPSED_HEIGHT` in
 *  `src-tauri/src/window.rs`, which is the floor Rust clamps to and the size the
 *  window is born at. */
export const HUD_BAR_HEIGHT_PX = 88 

/** Must match `HUD_MAX_HEIGHT` in `src-tauri/src/window.rs`. Rust re-clamps and
 *  is authoritative; this end knows the cap only so it stops ASKING once there
 *  is no more room — an unclamped request would cross IPC on every token for a
 *  window that is not going to move. */
export const HUD_MAX_HEIGHT_PX = 520

/**
 * Growth is quantised to this, and that is what makes a streaming reply cheap.
 *
 * Text arriving a token at a time changes the content height by one or two
 * pixels dozens of times a second, and each of those is an IPC round trip and a
 * compositor reconfigure for a change nobody can see. Same reasoning, same
 * number, as the composer's own metrics reporter.
 */
export const HUD_HEIGHT_STEP_PX = 8

/** Panel border (2px) plus the 0.625rem gap between it and the bar — the part of
 *  the panel that is not transcript. Mirrors the `[data-slot='thread-root']`
 *  rule in `styles.css`. */
const PANEL_CHROME_PX = 12

/**
 * The response panel never takes more than this much of the screen. Raised from
 * 168px, which is a strip: the panel is where a whole answer is read now, not a
 * two-line glance above a bar.
 */
export const HUD_BAND_MAX_PX = 336
export const HUD_BAND_MAX_FRACTION = 0.5

/** Minimum vertical room reserved when a composer dropdown menu (model, attachment) is open. */
export const HUD_DROPDOWN_MENU_HEIGHT_PX = 360
export const HUD_MODEL_MENU_HEIGHT_PX = HUD_DROPDOWN_MENU_HEIGHT_PX
export const HUD_ATTACHMENT_MENU_HEIGHT_PX = HUD_DROPDOWN_MENU_HEIGHT_PX

/**
 * `--hud-band-max` for a screen this tall.
 *
 * Takes the SCREEN's height, not the window's, and that is a fix rather than a
 * detail. The old expression read `window.innerHeight`, which on the layer-shell
 * path is the output (right) but on an ordinary toplevel is the HUD's own window
 * — 88px once the HUD opens as a bar. Half of 88 is 44, so the panel would have
 * been capped below its own chrome and could never have opened at all on macOS,
 * Windows or X11.
 */
export function hudBandMax(screenHeightPx: number): number {
  const height = Number.isFinite(screenHeightPx) ? Math.max(screenHeightPx, 0) : 0

  return Math.min(height * HUD_BAND_MAX_FRACTION, HUD_BAND_MAX_PX)
}

export interface HudHeightInput {
  /** The panel's cap for this screen — `--hud-band-max`, in pixels. */
  bandMaxPx: number
  /** Measured height of the input bar. */
  barPx: number
  /** Natural height of the transcript, ignoring how much of it is on screen. */
  contentPx: number
  /** Whether the composer attachment/context menu dropdown is currently open. */
  attachmentMenuOpen?: boolean
  /** Whether the composer model selector dropdown is currently open. */
  modelMenuOpen?: boolean
  /** Whether the response panel is showing at all. */
  open: boolean
}

/**
 * The window height this HUD wants, bucketed and clamped.
 *
 * Answers `HUD_BAR_HEIGHT_PX` for anything that measures as nothing: a card that
 * has not been laid out yet reports 0 for every box, and a HUD that shrank to
 * zero on its first frame would be an invisible window holding the keyboard.
 */
export function hudWindowHeight({
  attachmentMenuOpen,
  bandMaxPx,
  barPx,
  contentPx,
  modelMenuOpen,
  open
}: HudHeightInput): number {
  const bar = Number.isFinite(barPx) ? Math.max(barPx, 0) : 0
  const content = Number.isFinite(contentPx) ? Math.max(contentPx, 0) : 0
  const cap = Number.isFinite(bandMaxPx) ? Math.max(bandMaxPx, 0) : 0

  // Collapsed, the transcript's height is not merely ignored — it must be, or
  // the window would stay at the size of a conversation the user has hidden.
  const panel = open ? Math.min(content + PANEL_CHROME_PX, cap) : 0
  const baseHeight = bar + panel
  const menuOpen = modelMenuOpen || attachmentMenuOpen
  const menuHeight = menuOpen ? Math.min(bar + HUD_DROPDOWN_MENU_HEIGHT_PX, HUD_MAX_HEIGHT_PX) : 0
  const target = Math.max(baseHeight, menuHeight)
  const stepped = Math.ceil(target / HUD_HEIGHT_STEP_PX) * HUD_HEIGHT_STEP_PX

  return Math.min(Math.max(stepped, HUD_BAR_HEIGHT_PX), HUD_MAX_HEIGHT_PX)
}

/** Full width of the HUD window. Must match `SatelliteSpec.width` in `src-tauri/src/window.rs`. */
export const HUD_WIDTH_PX = 600 
export const HUD_BASE_WIDTH_PX = HUD_WIDTH_PX
export const HUD_EXPANDED_WIDTH_PX = HUD_WIDTH_PX

export interface HudWidthInput {
  attachmentMenuOpen?: boolean
  modelMenuOpen?: boolean
}

export function hudWindowWidth(_input?: HudWidthInput): number {
  return HUD_WIDTH_PX
}
