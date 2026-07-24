import { type ComponentProps, type ReactNode, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { NAV_ROW_BASE, NAV_ROW_ICON, NAV_ROW_LAYOUT } from '@/app/shell/nav-row'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tip, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

// Ported from apps/desktop/src/app/shell/statusbar-controls.tsx. The dumb,
// data-driven renderer: paints an array of StatusbarItem descriptors (assembled
// by use-statusbar-items) as a two-group footer. Adaptations for universal:
//   • dropped the Electron `[-webkit-app-region:no-drag]` class (Tauri drag is
//     opt-in via data-tauri-drag-region; the footer is never in a drag region);
//   • responsive sizing — a compact 20px chrome bar with hover on desktop (md+),
//     a taller touch bar with press feedback + a safe-area gutter on phones.

// Shared chrome styling for interactive statusbar items (button / link / menu
// trigger). The 'text' variant intentionally omits hover/transition/disabled.
const STATUSBAR_ACTION_CLASS =
  'inline-flex h-full items-center gap-1 rounded-none px-2 text-xs text-(--ui-text-tertiary) transition-colors hover:bg-(--chrome-action-hover) hover:text-foreground active:bg-(--chrome-action-hover) disabled:cursor-default disabled:opacity-45 md:px-1.5 md:text-[0.6875rem]'

const STATUSBAR_TEXT_CLASS =
  'inline-flex h-full items-center gap-1 px-2 text-xs text-(--ui-text-tertiary) md:px-1.5 md:text-[0.6875rem]'

// Row layout (the mobile Status list): each item is a full-width row that matches
// the left sidebar's nav-rail buttons (NAV_ROW_*) — icon + label on the left, the
// value/detail pushed to the right — instead of the bar's compact inline segment.

export interface StatusbarMenuItem {
  id: string
  icon?: ReactNode
  label: string
  className?: string
  disabled?: boolean
  hidden?: boolean
  href?: string
  onSelect?: () => void
  title?: string
  to?: string
}

export interface StatusbarItem {
  id: string
  label?: ReactNode
  detail?: ReactNode
  icon?: ReactNode
  className?: string
  disabled?: boolean
  hidden?: boolean
  href?: string
  menuAlign?: 'center' | 'end' | 'start'
  menuClassName?: string
  // A render fn receives a `close()` to dismiss the popover from inside the content.
  menuContent?: ((close: () => void) => ReactNode) | ReactNode
  menuItems?: readonly StatusbarMenuItem[]
  onSelect?: (modifiers: StatusbarSelectModifiers) => void
  title?: string
  to?: string
  variant?: 'action' | 'link' | 'menu' | 'text'
}

export interface StatusbarSelectModifiers {
  shiftKey: boolean
}

export type StatusbarItemSide = 'left' | 'right'
export type SetStatusbarItemGroup = (id: string, items: readonly StatusbarItem[], side?: StatusbarItemSide) => void

interface StatusbarControlsProps extends ComponentProps<'footer'> {
  leftItems?: readonly StatusbarItem[]
  items?: readonly StatusbarItem[]
}

export function StatusbarControls({ className, leftItems = [], items = [], ...props }: StatusbarControlsProps) {
  const navigate = useNavigate()

  return (
    <footer
      className={cn(
        'flex h-8 shrink-0 items-stretch justify-between gap-2 border-t border-(--ui-stroke-tertiary) bg-(--ui-sidebar-surface-background) px-1 pb-[env(safe-area-inset-bottom)] text-(--ui-text-tertiary) md:h-5 md:pb-0',
        className
      )}
      data-slot="statusbar"
      {...props}
    >
      {/* `overflow-x-clip` (not `overflow-x-auto`) so a wide status item — for
          example "Connecting…" on a fresh/untitled session — can't paint a
          horizontal scrollbar across the bottom of the window. Items already
          `truncate` their labels, so clipping is the right behavior. */}
      <div className="flex min-w-0 items-stretch gap-0.5 overflow-x-clip">
        {leftItems
          .filter(item => !item.hidden)
          .map(item => (
            <StatusbarItemView item={item} key={`left:${item.id}`} navigate={navigate} />
          ))}
      </div>
      <div className="flex min-w-0 items-stretch gap-0.5 overflow-x-clip">
        {items
          .filter(item => !item.hidden)
          .map(item => (
            <StatusbarItemView item={item} key={`right:${item.id}`} navigate={navigate} />
          ))}
      </div>
    </footer>
  )
}

export function StatusbarItemView({
  item,
  navigate,
  row = false
}: {
  item: StatusbarItem
  navigate: ReturnType<typeof useNavigate>
  // Full-width row form (the mobile Status list) vs the compact bar segment.
  row?: boolean
}) {
  const [menuOpen, setMenuOpen] = useState(false)

  const actionClass = row ? NAV_ROW_BASE : STATUSBAR_ACTION_CLASS
  const textClass = row ? NAV_ROW_LAYOUT : STATUSBAR_TEXT_CLASS

  // Rows match the sidebar nav buttons: a fixed icon slot, the label takes the
  // slack, and the value/detail is pushed to the right. The bar keeps everything
  // grouped left and inline.
  const content = row ? (
    <>
      <span className={NAV_ROW_ICON}>{item.icon}</span>
      {item.label && <span className="min-w-0 flex-1 truncate text-left">{item.label}</span>}
      {item.detail && <span className="truncate text-(--ui-text-tertiary)">{item.detail}</span>}
    </>
  ) : (
    <>
      {item.icon}
      {item.label && <span className="truncate">{item.label}</span>}
      {item.detail && <span className="truncate text-muted-foreground/80">{item.detail}</span>}
    </>
  )

  if (item.variant === 'menu' && (item.menuContent || (item.menuItems && item.menuItems.length > 0))) {
    // The `Tip` helper can't wrap a menu: its TooltipTrigger needs a DOM child,
    // but DropdownMenu's Root renders no element, so the hover listeners never
    // land on the button and the tooltip silently never shows. Compose the two
    // trigger Slots directly onto the same <button> instead (both asChild).
    const trigger = (
      <DropdownMenuTrigger asChild>
        <button className={cn(actionClass, item.className)} disabled={item.disabled} type="button">
          {content}
        </button>
      </DropdownMenuTrigger>
    )

    return (
      <DropdownMenu onOpenChange={setMenuOpen} open={menuOpen}>
        {item.title ? (
          <TooltipProvider delayDuration={0}>
            <Tooltip>
              <TooltipTrigger asChild>{trigger}</TooltipTrigger>
              <TooltipContent>{item.title}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : (
          trigger
        )}
        <DropdownMenuContent
          align={item.menuAlign ?? 'start'}
          className={cn('w-56', item.menuContent && 'p-0', item.menuClassName)}
          side={row ? 'bottom' : 'top'}
          sideOffset={8}
        >
          {item.menuContent
            ? typeof item.menuContent === 'function'
              ? item.menuContent(() => setMenuOpen(false))
              : item.menuContent
            : (item.menuItems ?? [])
                .filter(menuItem => !menuItem.hidden)
                .map(menuItem => (
                  <DropdownMenuItem
                    className={cn('gap-2 text-foreground focus:bg-accent [&_svg]:size-4', menuItem.className)}
                    disabled={menuItem.disabled}
                    key={menuItem.id}
                    onSelect={() => {
                      if (menuItem.to) {
                        navigate(menuItem.to)
                      }

                      menuItem.onSelect?.()
                    }}
                  >
                    {menuItem.href ? (
                      <a
                        className="inline-flex w-full items-center gap-2"
                        href={menuItem.href}
                        rel="noreferrer"
                        target="_blank"
                      >
                        {menuItem.icon}
                        <span className="truncate">{menuItem.label}</span>
                      </a>
                    ) : (
                      <>
                        {menuItem.icon}
                        <span className="truncate">{menuItem.label}</span>
                      </>
                    )}
                  </DropdownMenuItem>
                ))}
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }

  if (item.variant === 'text' && !item.onSelect && !item.to && !item.href) {
    return (
      <Tip label={item.title}>
        <div className={cn(textClass, item.className)}>{content}</div>
      </Tip>
    )
  }

  if (item.href || item.variant === 'link') {
    return (
      <Tip label={item.title}>
        <a className={cn(actionClass, item.className)} href={item.href} rel="noreferrer" target="_blank">
          {content}
        </a>
      </Tip>
    )
  }

  return (
    <Tip label={item.title}>
      <button
        className={cn(actionClass, item.className)}
        disabled={item.disabled}
        onClick={event => {
          if (item.to) {
            navigate(item.to)
          }

          item.onSelect?.({ shiftKey: event.shiftKey })
        }}
        type="button"
      >
        {content}
      </button>
    </Tip>
  )
}
