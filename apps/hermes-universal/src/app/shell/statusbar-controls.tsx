import { type ComponentProps, type ReactNode, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { NAV_ROW_BASE, NAV_ROW_ICON, NAV_ROW_LAYOUT } from '@/app/shell/nav-row'
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tip, TipKeybindLabel, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { useKeybindHint } from '@/lib/keybinds/use-keybind-hint'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import { $statusbarHiddenIds, setStatusbarItemVisible, toggleStatusbarVisible } from '@/store/statusbar-prefs'

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
  /** Escape hatch: render an arbitrary node into the bar (own state, tooltip,
   *  events). When set, it OWNS the slot — label/variant/onSelect are ignored.
   *  This is how a plugin drops a full stateful React component into the bar. */
  render?: () => ReactNode
  /** Keybind action id — when set, the tooltip shows the label + keybind hint. */
  actionId?: string
  /** Plain-text name for the bar's right-click show/hide menu. An item without
   *  one is never listed there and always shows — the safe default for plugin
   *  contributions that don't opt in. */
  toggleLabel?: string
  /** Listed in the menu but not switchable: the bar's own affordances (command
   *  center, version pills) would strand the user if they could be hidden from
   *  the surface that hides them. */
  lockedVisible?: boolean
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
  const hiddenIds = useStore($statusbarHiddenIds)

  // An item is in the show/hide menu only if it named itself (`toggleLabel`);
  // anything else — including a plugin's contribution — always shows.
  const visible = (item: StatusbarItem) =>
    !item.hidden && (item.lockedVisible || !item.toggleLabel || !hiddenIds.includes(item.id))

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
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
            {leftItems.filter(visible).map(item => (
              <StatusbarItemView item={item} key={`left:${item.id}`} navigate={navigate} />
            ))}
          </div>
          <div className="flex min-w-0 items-stretch gap-0.5 overflow-x-clip">
            {items.filter(visible).map(item => (
              <StatusbarItemView item={item} key={`right:${item.id}`} navigate={navigate} />
            ))}
          </div>
        </footer>
      </ContextMenuTrigger>
      <StatusbarVisibilityMenu hiddenIds={hiddenIds} items={items} leftItems={leftItems} />
    </ContextMenu>
  )
}

/** Right-click the bar: pick what it shows, or hide the bar outright. */
function StatusbarVisibilityMenu({
  hiddenIds,
  items,
  leftItems
}: {
  hiddenIds: readonly string[]
  items: readonly StatusbarItem[]
  leftItems: readonly StatusbarItem[]
}) {
  const { t } = useI18n()
  const copy = t.shell.statusbar

  const toggles = useMemo(() => {
    const seen = new Set<string>()

    return [...leftItems, ...items].filter(item => {
      if (!item.toggleLabel || seen.has(item.id)) {
        return false
      }

      seen.add(item.id)

      return true
    })
  }, [items, leftItems])

  return (
    <ContextMenuContent className="w-52">
      <ContextMenuLabel>{copy.customizeTitle}</ContextMenuLabel>
      <ContextMenuSeparator />
      {toggles.map(item => (
        <ContextMenuCheckboxItem
          checked={item.lockedVisible || !hiddenIds.includes(item.id)}
          disabled={item.lockedVisible}
          key={item.id}
          onCheckedChange={checked => setStatusbarItemVisible(item.id, checked)}
          // Keep the menu open so several items can be toggled in one pass.
          onSelect={event => event.preventDefault()}
        >
          {item.toggleLabel}
        </ContextMenuCheckboxItem>
      ))}
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={toggleStatusbarVisible}>
        {copy.hideStatusbar}
        <StatusbarHideHint />
      </ContextMenuItem>
    </ContextMenuContent>
  )
}

/** The way BACK, shown where the bar is hidden — the bar can't offer itself. */
function StatusbarHideHint() {
  const hint = useKeybindHint('view.toggleStatusbar')

  return <span className="ml-auto pl-2 text-(--ui-text-quaternary)">{hint}</span>
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

  // Render escape hatch: the contribution owns its own chrome/state/tooltip.
  // Must come before the `row` reshaping below — a contributed node is never
  // wrapped in bar chrome or rewritten into a nav row.
  if (item.render) {
    return <>{item.render()}</>
  }

  const actionClass = row ? NAV_ROW_BASE : STATUSBAR_ACTION_CLASS
  const textClass = row ? NAV_ROW_LAYOUT : STATUSBAR_TEXT_CLASS

  // An item bound to a keybind advertises it in the tooltip, live from the
  // store — `title` stays the wording (it's context-dependent: Show/Hide).
  const tooltipLabel = item.actionId ? <TipKeybindLabel actionId={item.actionId} text={item.title} /> : item.title

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
              <TooltipContent>{tooltipLabel}</TooltipContent>
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
      <Tip label={tooltipLabel}>
        <div className={cn(textClass, item.className)}>{content}</div>
      </Tip>
    )
  }

  if (item.href || item.variant === 'link') {
    return (
      <Tip label={tooltipLabel}>
        <a className={cn(actionClass, item.className)} href={item.href} rel="noreferrer" target="_blank">
          {content}
        </a>
      </Tip>
    )
  }

  return (
    <Tip label={tooltipLabel}>
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
