import type { ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { useI18n } from '@/i18n'
import { ChevronLeft } from '@/lib/icons'
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
/**
 * Where a drawer opened by `el` should start: the bottom of the BAR it sits in,
 * falling back to the control itself.
 *
 * The control is vertically centred in a taller bar, so anchoring to the control
 * alone leaves the drawer covering the bar's last few pixels — including its
 * border — which is exactly the "over the top bar" look this avoids. Bars opt in
 * with `data-top-bar` rather than being guessed at by walking parents, because
 * the two that matter (the phone's chrome bar, the overlay nav strip) have
 * nothing structural in common.
 */
export function topBarBottom(el: HTMLElement | null): number {
  const bar = el?.closest<HTMLElement>('[data-top-bar]')

  if (bar) {
    return Math.round(bar.getBoundingClientRect().bottom)
  }

  // The trigger is not inside a marked bar — a menu opened from somewhere else,
  // or a ref that was not attached by the time it was read. Fall back to the
  // LOWEST bar on screen rather than to the control: a menu that opens at 0
  // covers the chrome it belongs to, which is the one outcome to avoid, and the
  // lowest bar is the innermost one on a stacked surface.
  const bars = [...document.querySelectorAll<HTMLElement>('[data-top-bar]')]
    .map(node => node.getBoundingClientRect().bottom)
    .filter(bottom => bottom > 0)

  if (bars.length > 0) {
    return Math.round(Math.max(...bars))
  }

  return el ? Math.round(el.getBoundingClientRect().bottom) : 0
}

export function TopDrawer({
  children,
  className,
  offsetTop,
  onBack,
  onOpenChange,
  open,
  title
}: {
  children: ReactNode
  className?: string
  /** Where the panel's top edge sits, in px — normally the BOTTOM of the control
   *  that opened it, so the drawer appears to come out from under the bar rather
   *  than over it. Measured by the caller rather than assumed here: the chat's
   *  top bar and the Settings / Command Center nav strip are different heights,
   *  so any constant would be wrong on one of them. */
  offsetTop?: number
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
        className={cn(
          'flex flex-col gap-0 p-0',
          // No focus ring. The panel is focused on open (see below) and a
          // `tabIndex={-1}` container takes the platform's default outline with
          // it — which is where the stray blue line above the list came from.
          // It is not a theme colour and never was.
          'outline-none focus:outline-none focus-visible:outline-none',
          // Hangs off the bar: square at the top, rounded below, and no top
          // border, so it reads as the bar continuing downward rather than as a
          // separate card floating under it.
          'rounded-t-none rounded-b-xl border-t-0',
          className
        )}
        data-top-drawer
        /* Radix focuses the first focusable child on open; where that is a field
           it means the soft keyboard arriving over the list. Focus the panel
           instead — the dialog still takes focus, so Escape and screen readers
           work, but nothing typeable does. */
        onOpenAutoFocus={event => {
          event.preventDefault()
          ;(event.currentTarget as HTMLElement | null)?.focus?.()
        }}
        /* The scrim starts where the panel does. Covering the bar dimmed AND
           blurred the very chrome the menu belongs to, which is what made this
           read as a modal sheet instead of a menu. */
        overlayClassName="backdrop-blur-none bg-black/22"
        overlayStyle={{ top: offsetTop ?? 0 }}
        showCloseButton={false}
        side="top"
        style={{
          // 75% of the visible screen, and capped by what is actually left below
          // the bar — whichever is smaller. The second term matters on a short
          // screen or with the keyboard up, where 75% of the viewport would run
          // the panel off the bottom.
          maxHeight: `min(75vh, calc(var(--visual-viewport-height, 100vh) - ${offsetTop ?? 0}px - 2rem))`,
          top: offsetTop ?? 0
        }}
      >
        {/* The panel clips; THIS slides. Keeping the two apart is what makes
            the menu appear from under the bar — see the `top-drawer` block in
            styles.css. */}
        <div className="flex min-h-0 flex-1 flex-col" data-top-drawer-inner>
          {/* Radix needs an accessible name; the BAR already shows it, so
              repeating it as a heading just said "Settings" twice down the
              screen. Visually hidden, not removed. */}
          <SheetTitle className="sr-only">{title}</SheetTitle>

          {/* A header only when there is somewhere to go back to. At the top
              level the rows are the whole menu — a hamburger has no title bar of
              its own, and the close is the same control you opened it with. */}
          {onBack && (
            <div className="flex shrink-0 items-center gap-2 border-b border-border/65 px-2 py-1.5">
              <Button aria-label={common.back} onClick={onBack} size="icon" type="button" variant="ghost">
                <ChevronLeft className="size-5" />
              </Button>
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1">{children}</div>
        </div>
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
