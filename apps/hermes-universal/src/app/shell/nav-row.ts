// The sidebar nav-row style — the look of the left sidebar's nav-rail buttons
// (New session / Capabilities / Messaging / Artifacts). Shared so other row lists
// (e.g. the mobile Status list) match those buttons exactly, from one source.

export const NAV_ROW_LAYOUT =
  'flex h-7 w-full items-center justify-start gap-2 rounded-md border border-transparent px-2 text-left text-[0.8125rem] font-medium text-(--ui-text-secondary)'

export const NAV_ROW_HOVER =
  'transition-colors duration-100 ease-out hover:bg-(--ui-control-hover-background) hover:text-foreground hover:transition-none'

/** Interactive nav row (button / link / menu trigger). */
export const NAV_ROW_BASE = `${NAV_ROW_LAYOUT} ${NAV_ROW_HOVER}`

/** Active/selected nav row — subtle border + control-active fill. */
export const NAV_ROW_ACTIVE =
  'border-(--ui-stroke-tertiary) bg-(--ui-control-active-background) text-foreground shadow-none hover:border-(--ui-stroke-tertiary)!'

/** Leading-icon slot — a 16px box that dims the glyph to 72% like the nav rail. */
export const NAV_ROW_ICON =
  'flex size-4 shrink-0 items-center justify-center text-[color-mix(in_srgb,currentColor_72%,transparent)]'
