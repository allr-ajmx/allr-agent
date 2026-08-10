import { cva, type VariantProps } from 'class-variance-authority'
import type { ReactNode } from 'react'

/**
 * RequestBar CVA (MJXHRM-322 Approval/Sudo/Secret bars).
 */
export const requestBarVariants = cva(
  'flex flex-col gap-2 rounded-(--radius) border border-(--ui-stroke-primary) bg-card p-3'
)

export const requestBarDescriptionVariants = cva('text-[0.8125rem] break-words text-secondary-foreground', {
  variants: {
    mono: {
      true: 'font-mono',
      false: ''
    }
  },
  defaultVariants: {
    mono: false
  }
})

export type RequestBarDescriptionVariantProps = VariantProps<typeof requestBarDescriptionVariants>

export const requestBarActionsVariants = cva('flex flex-wrap gap-2')

// Shared shell for the composer-docked request bars (approval / clarify / sudo /
// secret). Replaces the pre-port `.approval*` legacy CSS classes; the chrome is
// expressed in the same theme tokens the desktop app uses, so these bars track
// the active skin instead of the retired mobile stylesheet.
export function RequestBar({ children, title }: { children: ReactNode; title: ReactNode }) {
  return (
    <div className={requestBarVariants()} data-slot="request-bar">
      <div className="text-[0.8125rem] font-semibold text-midground">{title}</div>
      {children}
    </div>
  )
}

/** Request body text. `mono` for machine content (a command), prose otherwise. */
export function RequestBarDescription({ children, mono = false }: { children: ReactNode; mono?: boolean }) {
  return (
    <div className={requestBarDescriptionVariants({ mono })} data-slot="request-bar-description">
      {children}
    </div>
  )
}

export function RequestBarActions({ children }: { children: ReactNode }) {
  return (
    <div className={requestBarActionsVariants()} data-slot="request-bar-actions">
      {children}
    </div>
  )
}
