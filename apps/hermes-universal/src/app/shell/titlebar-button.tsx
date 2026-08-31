import { cva, type VariantProps } from 'class-variance-authority'
import type { ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { Tip, TipKeybindLabel } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

import { shellChromeControlActive, shellChromeControlIdle } from './cva/tokens'

/**
 * TitlebarButton CVA (MJXHRM-313).
 * `desktop` = compact titlebar density; `mobile` = ≥44px touch hit for phone chrome.
 */
export const titlebarButtonVariants = cva(cn('rounded-[4px] [&_.codicon]:text-[0.875rem]', shellChromeControlIdle), {
  variants: {
    density: {
      desktop: 'size-5',
      mobile: 'size-11 min-h-11 min-w-11'
    },
    active: {
      true: shellChromeControlActive,
      false: ''
    }
  },
  defaultVariants: {
    density: 'desktop',
    active: false
  }
})

export type TitlebarButtonVariantProps = VariantProps<typeof titlebarButtonVariants>

// Shared titlebar/window-control button. Matches desktop's `titlebarButtonClass`:
// transparent fill, muted-foreground/85 idle icon, control-hover fill + full
// foreground on hover. `density="mobile"` expands the hit for phone chrome.
export function TitlebarButton({
  actionId,
  label,
  onClick,
  active = false,
  density = 'desktop',
  className,
  children
}: {
  /** Keybind action id — appends its live combo to the tooltip. */
  actionId?: string
  label: string
  onClick: () => void
  active?: boolean
  className?: string
  children: ReactNode
} & TitlebarButtonVariantProps) {
  return (
    <Tip label={actionId ? <TipKeybindLabel actionId={actionId} text={label} /> : label}>
      <Button
        aria-label={label}
        aria-pressed={active || undefined}
        className={cn(titlebarButtonVariants({ density, active }), className)}
        data-density={density}
        data-slot="titlebar-button"
        data-state={active ? 'active' : 'default'}
        onClick={onClick}
        type="button"
        variant="ghost"
      >
        {children}
      </Button>
    </Tip>
  )
}
