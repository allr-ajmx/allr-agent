/**
 * Shared mobile-shell token class strings for CVA variants.
 * Values map to CSS vars defined in themes / styles.css — do not invent colors.
 */

/** Chrome fill + bottom/top hairline used by MobileChromeBar / MobileTabBar. */
export const shellChromeSurface = 'border-(--ui-stroke-tertiary) bg-(--ui-bg-chrome) select-none'

/** Active accent (tab underline, badge fill). */
export const shellAccent = 'bg-(--ui-accent-primary)'

/** Quiet chrome control idle → hover (desktop-compact TitlebarButton). */
export const shellChromeControlIdle =
  'bg-transparent text-muted-foreground/85 hover:bg-[var(--ui-control-hover-background)] hover:text-foreground'

export const shellChromeControlActive = 'bg-[var(--ui-control-active-background)] text-foreground'

/** Tab / nav label colors. */
export const shellTabIdle = 'text-muted-foreground'
export const shellTabActive = 'text-foreground'
