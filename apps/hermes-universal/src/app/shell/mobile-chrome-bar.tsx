import { cva, type VariantProps } from 'class-variance-authority'
import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

import { shellChromeSurface } from './cva/tokens'

/**
 * MobileChromeBar CVA (MJXHRM-311).
 * One phone top bar — chat, Workspace, windowable surfaces share height/gutter/safe-area.
 */
export const mobileChromeBarVariants = cva(cn('shrink-0 border-b', shellChromeSurface), {
  variants: {
    density: {
      /** Default phone chrome — 48px control row below notch. */
      mobile: '',
      compact: ''
    }
  },
  defaultVariants: {
    density: 'mobile'
  }
})

export const mobileChromeBarRowVariants = cva('flex items-center gap-1 px-2', {
  variants: {
    density: {
      mobile: 'h-12',
      compact: 'h-10'
    }
  },
  defaultVariants: {
    density: 'mobile'
  }
})

export const mobileChromeBarSlotVariants = cva('', {
  variants: {
    slot: {
      left: 'flex shrink-0 items-center gap-1',
      center: 'flex min-w-0 flex-1 items-center self-stretch overflow-hidden',
      right: 'flex shrink-0 items-center gap-1'
    }
  },
  defaultVariants: {
    slot: 'center'
  }
})

export type MobileChromeBarVariantProps = VariantProps<typeof mobileChromeBarVariants>

// The one mobile top bar.
//
// Every phone surface draws the same row — the chat shell, the Workspace, the
// windowable screens (Settings / Command Center / Profiles) — so its height,
// gutter and safe-area handling have to be defined in exactly one place.
//
// It owns the safe-area TOP inset: the chrome fills the status-bar / notch area
// and the controls sit below it. Callers own the bottom and side insets.
export function MobileChromeBar({
  center,
  left,
  right,
  density = 'mobile',
  className
}: {
  center?: ReactNode
  left?: ReactNode
  right?: ReactNode
  className?: string
} & MobileChromeBarVariantProps) {
  return (
    <div
      className={cn(mobileChromeBarVariants({ density }), className)}
      data-density={density}
      data-slot="mobile-chrome-bar"
      style={{ paddingTop: 'var(--safe-area-inset-top)' }}
    >
      <div className={mobileChromeBarRowVariants({ density })}>
        {left != null ? <div className={mobileChromeBarSlotVariants({ slot: 'left' })}>{left}</div> : left}
        <div className={mobileChromeBarSlotVariants({ slot: 'center' })}>{center}</div>
        {right != null ? <div className={mobileChromeBarSlotVariants({ slot: 'right' })}>{right}</div> : right}
      </div>
    </div>
  )
}
