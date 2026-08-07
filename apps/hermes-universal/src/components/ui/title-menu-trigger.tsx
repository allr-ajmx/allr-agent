import type * as React from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { cn } from '@/lib/utils'

/**
 * Compact "Label ▾" chrome trigger. Domain-agnostic — drop in as the child of
 * `DropdownMenuTrigger asChild` (or any asChild menu trigger). Sessions,
 * projects, filters, etc. own their menus; this only owns the trigger look.
 */
export function TitleMenuTrigger({
  children,
  className,
  ...props
}: Omit<React.ComponentProps<typeof Button>, 'children' | 'size' | 'variant'> & {
  children: React.ReactNode
}) {
  return (
    <Button
      className={cn(
        'group/title-trigger pointer-events-auto relative flex h-6 min-w-0 max-w-full gap-1 overflow-hidden border-0 bg-transparent px-2 py-0 text-left text-(--ui-text-secondary) hover:text-foreground [-webkit-app-region:no-drag]',
        className
      )}
      type="button"
      variant="ghost"
      {...props}
    >
      {/* The highlight is painted by this layer, not by the button box, so the
          two can differ in height. On a coarse pointer every button is floored
          at 44px (styles.css) — that floor is the tap target and has to stay —
          but a 44px slab of border and fill inside a 48px bar reads as one
          oversized control rather than a title. `max-h-9` caps the PAINT at
          36px and centres it, leaving air top and bottom; the button underneath
          keeps its full height. Desktop's pill is 24px, well under the cap, so
          it is unchanged. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-1/2 h-full max-h-9 -translate-y-1/2 rounded-[2.5px] border border-transparent transition-colors group-hover/title-trigger:border-(--ui-stroke-tertiary) group-hover/title-trigger:bg-(--ui-control-hover-background) group-data-[state=open]/title-trigger:border-(--ui-stroke-tertiary) group-data-[state=open]/title-trigger:bg-(--ui-control-active-background)"
      />
      {/* `flex-1`: when a caller makes this full-width (the phone's top bar) the
          label takes the slack, so the chevron parks at the far right edge
          instead of trailing the text. Content-width on desktop, where it is a
          no-op. `leading-4`, not `leading-none`: `truncate` clips overflow, and
          a line box exactly one font-size tall cuts descenders off. */}
      {/* `relative` on both: the highlight above is positioned, so without it
          the label and chevron (plain in-flow content) paint UNDER it. */}
      <span className="relative min-w-0 flex-1 truncate text-[0.75rem] font-medium leading-4">{children}</span>
      <Codicon className="relative shrink-0 text-(--ui-text-tertiary)" name="chevron-down" size="0.8125rem" />
    </Button>
  )
}
