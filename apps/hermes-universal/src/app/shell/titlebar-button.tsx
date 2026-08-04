import type { ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { Tip, TipKeybindLabel } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

// Shared titlebar/window-control button. Matches desktop's `titlebarButtonClass`:
// transparent fill, muted-foreground/85 idle icon, control-hover fill + full
// foreground on hover. Compact (desktop titlebar density). `active` reflects a
// toggle (aria-pressed + a persistent control-active fill).
//
// Tooltip, not the native `title`: the app's own Tip renders instantly, matches
// the rest of the chrome, and — with `actionId` — carries the button's live
// keybind, which a native tooltip can't show.
export function TitlebarButton({
  actionId,
  label,
  onClick,
  active = false,
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
}) {
  return (
    <Tip label={actionId ? <TipKeybindLabel actionId={actionId} text={label} /> : label}>
      <Button
        aria-label={label}
        aria-pressed={active}
        className={cn(
          'size-5 rounded-[4px] bg-transparent text-muted-foreground/85 [&_.codicon]:text-[0.875rem] hover:bg-[var(--ui-control-hover-background)] hover:text-foreground',
          active && 'bg-[var(--ui-control-active-background)] text-foreground',
          className
        )}
        onClick={onClick}
        type="button"
        variant="ghost"
      >
        {children}
      </Button>
    </Tip>
  )
}
