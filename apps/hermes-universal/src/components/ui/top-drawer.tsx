import type { ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { useI18n } from '@/i18n'
import { ChevronLeft, X } from '@/lib/icons'
import { cn } from '@/lib/utils'

/**
 * A menu presented as a drawer down from the top, for touch.
 *
 * WHY A DRAWER AND NOT THE DROPDOWN. A dropdown is anchored to its trigger and
 * sized to its content, which is fine beside a mouse and wrong under a thumb:
 * on a phone it opens off the edge, its rows are sized by their text, and a
 * submenu is reached by HOVER, which a finger does not have. A drawer is
 * full-width, its rows are real touch targets, and a submenu becomes a PAGE.
 *
 * PAGES ARE THE CALLER'S. This owns the surface — the panel, the header, the
 * close — and takes `onBack` when the caller has pushed a page, because only
 * the caller knows what a submenu means. That keeps one drawer serving both a
 * flat nav list and a menu with interactive submenus.
 */
export function TopDrawer({
  children,
  className,
  onBack,
  onOpenChange,
  open,
  title
}: {
  children: ReactNode
  className?: string
  /** Present = a sub-page is showing; renders the back button. */
  onBack?: () => void
  onOpenChange: (open: boolean) => void
  open: boolean
  title: string
}) {
  const common = useI18n().t.common

  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent
        className={cn('flex max-h-[calc(var(--visual-viewport-height,100vh)-4rem)] flex-col gap-0 p-0', className)}
        /* Radix focuses the first focusable child on open. In a drawer with a
           search or a text field that is the soft keyboard, arriving on top of
           the list you opened this to read. Focus the panel: the dialog still
           takes focus, so Escape and screen readers work, but nothing typeable
           does. Same reason the model drawer does it. */
        onOpenAutoFocus={event => {
          event.preventDefault()
          ;(event.currentTarget as HTMLElement | null)?.focus?.()
        }}
        showCloseButton={false}
        side="top"
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-border/65 p-3">
          {onBack && (
            <Button aria-label={common.back} className="shrink-0" onClick={onBack} size="icon" type="button" variant="ghost">
              <ChevronLeft className="size-5" />
            </Button>
          )}
          <SheetTitle className="min-w-0 flex-1 truncate text-sm font-medium">{title}</SheetTitle>
          <Button
            aria-label={common.close}
            className="shrink-0"
            onClick={() => onOpenChange(false)}
            size="icon"
            type="button"
            variant="ghost"
          >
            <X className="size-5" />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-2">{children}</div>
      </SheetContent>
    </Sheet>
  )
}

/** One row in a top drawer. Full width and a real touch target, which is most of
 *  the point — a menu row sized by its text is what made these hard to hit. */
export function TopDrawerRow({
  active,
  children,
  indent,
  onSelect
}: {
  active?: boolean
  children: ReactNode
  indent?: boolean
  onSelect: () => void
}) {
  return (
    <button
      className={cn(
        'flex w-full items-center gap-3 px-4 text-start text-sm',
        'min-h-(--touch-target-min)',
        'hover:bg-(--ui-row-hover-background) active:bg-(--ui-row-hover-background)',
        indent && 'ps-10',
        active && 'font-medium text-foreground'
      )}
      onClick={onSelect}
      type="button"
    >
      {children}
    </button>
  )
}
