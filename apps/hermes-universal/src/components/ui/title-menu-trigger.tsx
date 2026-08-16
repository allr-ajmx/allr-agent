import { cva, type VariantProps } from 'class-variance-authority'
import type * as React from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { cn } from '@/lib/utils'

/**
 * TitleMenuTrigger CVA (MJXHRM-316).
 */
export const titleMenuTriggerVariants = cva(
  'group/title-trigger pointer-events-auto relative flex min-w-0 max-w-full gap-1 overflow-hidden border-0 bg-transparent px-2 py-0 text-start text-(--ui-text-secondary) hover:text-foreground [-webkit-app-region:no-drag]',
  {
    variants: {
      density: {
        desktop: 'h-6',
        mobile: 'h-full'
      },
      state: {
        default: '',
        open: ''
      }
    },
    defaultVariants: {
      density: 'desktop',
      state: 'default'
    }
  }
)

export type TitleMenuTriggerVariantProps = VariantProps<typeof titleMenuTriggerVariants>

/**
 * Compact "Label ▾" chrome trigger. Domain-agnostic — drop in as the child of
 * `DropdownMenuTrigger asChild` (or any asChild menu trigger).
 */
export function TitleMenuTrigger({
  children,
  className,
  density = 'desktop',
  ...props
}: Omit<React.ComponentProps<typeof Button>, 'children' | 'size' | 'variant'> & {
  children: React.ReactNode
} & TitleMenuTriggerVariantProps) {
  return (
    <Button
      className={cn(titleMenuTriggerVariants({ density }), className)}
      data-density={density}
      data-slot="title-menu-trigger"
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
      <span className="relative min-w-0 flex-1 truncate text-[0.75rem] font-medium leading-4">{children}</span>
      <Codicon className="relative shrink-0 text-(--ui-text-tertiary)" name="chevron-down" size="0.8125rem" />
    </Button>
  )
}
