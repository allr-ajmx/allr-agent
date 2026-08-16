import type * as React from 'react'

import { cn } from '@/lib/utils'

interface SidebarPanelLabelProps extends React.ComponentProps<'span'> {
  dotClassName?: string
}

// Uppercase section label with a small dithered accent dot. Ported from desktop
// `app/shell/sidebar-label.tsx`. The dot's `currentColor` resolves to the
// label's `--theme-primary`.
export function SidebarPanelLabel({ children, className, dotClassName, ...props }: SidebarPanelLabelProps) {
  return (
    <span
      className={cn(
        'flex min-w-0 items-center gap-2 ps-2 text-[0.64rem] font-semibold uppercase tracking-[0.16em] text-(--theme-primary)',
        className
      )}
      {...props}
    >
      <span aria-hidden="true" className={cn('dither inline-block size-2 shrink-0 rounded-[1px]', dotClassName)} />
      <span className="min-w-0 truncate leading-none">{children}</span>
    </span>
  )
}
