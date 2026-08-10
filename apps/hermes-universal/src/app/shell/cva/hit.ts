import { cva, type VariantProps } from 'class-variance-authority'

/**
 * Touch hit helpers for mobile shell chrome.
 * Coarse-pointer floors also live in styles.css for `[data-slot='button']`;
 * these classes make intent explicit on non-Button chrome (tabs, chrome hits).
 */

/** Minimum interactive size: 44px iOS / comfortable 48px Material row. */
export const HIT_MIN_PX = 44
export const HIT_COMFORT_PX = 48

export const shellHitVariants = cva('inline-flex shrink-0 items-center justify-center', {
  variants: {
    size: {
      /** Edge chrome icon hit — floored to 44 on coarse via Button CSS or explicit min. */
      icon: 'min-h-11 min-w-11',
      /** Comfortable chrome row cell (ChromeBar control row is h-12 = 48px). */
      row: 'min-h-12',
      /** Bottom tab entry. */
      tab: 'min-h-11 min-w-14'
    }
  },
  defaultVariants: {
    size: 'icon'
  }
})

export type ShellHitVariantProps = VariantProps<typeof shellHitVariants>
