import type { ComponentProps } from 'react'
import { memo } from 'react'

import { cn } from '@/lib/utils'

// Ported from apps/desktop/src/components/status-dot.tsx. A 6px tone dot for the
// gateway-health panel (connection / inference / per-platform state) and the
// messaging screen. THE tone dot — `components/ui/status-dot.tsx` used to hold a
// byte-identical second copy, which meant two of these could drift apart.
export type StatusTone = 'good' | 'muted' | 'warn' | 'bad'

const TONE_BG: Record<StatusTone, string> = {
  good: 'bg-primary',
  muted: 'bg-muted-foreground/40',
  warn: 'bg-amber-500',
  bad: 'bg-destructive'
}

interface StatusDotProps extends ComponentProps<'span'> {
  tone: StatusTone
}

/** Memoized (desktop parity): `tone` is a string union and the dot is list
 *  rendered — one per platform in the gateway menu and per statusbar chip. */
export const StatusDot = memo(function StatusDot({ className, tone, ...props }: StatusDotProps) {
  return (
    <span
      aria-hidden="true"
      className={cn('inline-block size-1.5 rounded-full', TONE_BG[tone], className)}
      {...props}
    />
  )
})
