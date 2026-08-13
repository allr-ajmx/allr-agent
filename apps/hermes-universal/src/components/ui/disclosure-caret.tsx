import { Codicon, type CodiconProps } from '@/components/ui/codicon'
import { cn } from '@/lib/utils'

interface DisclosureCaretProps extends Omit<CodiconProps, 'name'> {
  open: boolean
}

// Chrome caret for collapsible sections: points toward the reading direction
// when closed (▶ in LTR, ◀ in RTL), rotates to point down (▼) when open.
// Override `className` to layer hover/opacity styling; twMerge resolves
// transition conflicts.
//
// The mirror is a `scale`, not a second `rotate`, so it composes with the open
// state instead of fighting it: CSS applies the individual `rotate` before
// `scale`, so an open caret is rotated to ▼ and then flipped about its vertical
// axis — which a ▼ is symmetric under — leaving it ▼ in both directions.
export function DisclosureCaret({ className, open, size = '0.75rem', ...props }: DisclosureCaretProps) {
  return (
    <Codicon
      className={cn('transition-transform duration-150 rtl:-scale-x-100', open && 'rotate-90', className)}
      name="chevron-right"
      size={size}
      {...props}
    />
  )
}
