import type { ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { Tip, TipKeybindLabel } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

// Shared titlebar/window-control button. Matches desktop's `titlebarButtonClass`:
// transparent fill, muted-foreground/85 idle icon, control-hover fill + full
// foreground on hover. Compact (desktop titlebar density). `active` reflects a
// toggle (aria-pressed + a persistent control-active fill).
//
// The tip is the themed `<Tip>`, never native `title=` — native tooltips are
// unstyled and ~500ms delayed (see no-native-title.test.ts). With `actionId`
// set it also shows the action's live keybind; `text` is always passed through
// because titlebar labels are context-dependent ("Show"/"Hide sidebar").
export function TitlebarButton({
  label,
  actionId,
  onClick,
  active = false,
  className,
  children
}: {
  label: string
  /** Keybind action id — when set, the tip shows the label + current combo. */
  actionId?: string
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
