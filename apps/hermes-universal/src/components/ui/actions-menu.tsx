import type * as React from 'react'

import { Codicon } from '@/components/ui/codicon'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'

// One place to define a set of actions and get BOTH a kebab dropdown and a
// matching right-click context menu — so a row's ⋯ menu and its right-click menu
// never drift. The dropdown and context primitives share an identical item
// surface (Item / Separator / Sub…), so a caller writes `items={kit => …}` once
// and hands the render function to both wrappers.
//
// Ported verbatim from desktop `components/ui/actions-menu.tsx`.

/**
 * A menu flavour — the item + separator + submenu parts.
 *
 * Typed STRUCTURALLY rather than as `typeof DropdownMenuItem | typeof
 * ContextMenuItem`. Those two unions admitted exactly the two Radix flavours,
 * which was fine while both were menus; a third flavour renders a touch drawer
 * out of plain buttons and is not a Radix menu part at all. The props below are
 * what `renderActionItem` and the spec renderers actually pass, so a flavour
 * only has to accept those — not to be a particular component.
 */
/** A selectable row. `onSelect` is the DOM-event shape Radix menu items use. */
export interface MenuItemProps {
  children?: React.ReactNode
  className?: string
  disabled?: boolean
  onSelect?: (event: Event) => void
  variant?: 'default' | 'destructive'
}

/** Structural parts — no `onSelect`, because a submenu trigger's is React's
 *  handler shape and nothing here ever passes one. */
export interface MenuSectionProps {
  children?: React.ReactNode
  className?: string
  disabled?: boolean
}

export interface MenuKit {
  Item: React.ComponentType<MenuItemProps>
  Label: React.ComponentType<MenuSectionProps>
  Separator: React.ComponentType<MenuSectionProps>
  Sub: React.ComponentType<MenuSectionProps>
  SubTrigger: React.ComponentType<MenuSectionProps>
  SubContent: React.ComponentType<MenuSectionProps>
  /** `CopyButton`'s `appearance` for this flavour — pass to a menu-item copy. */
  copyAppearance: 'context-menu-item' | 'menu-item'
}

export const DROPDOWN_KIT: MenuKit = {
  Item: DropdownMenuItem,
  Label: DropdownMenuLabel,
  Separator: DropdownMenuSeparator,
  Sub: DropdownMenuSub,
  SubContent: DropdownMenuSubContent,
  SubTrigger: DropdownMenuSubTrigger,
  copyAppearance: 'menu-item'
}

export const CONTEXT_KIT: MenuKit = {
  Item: ContextMenuItem,
  Label: ContextMenuLabel,
  Separator: ContextMenuSeparator,
  Sub: ContextMenuSub,
  SubContent: ContextMenuSubContent,
  SubTrigger: ContextMenuSubTrigger,
  copyAppearance: 'context-menu-item'
}

/** A single action row. Provide `icon` (codicon name) or `iconNode` (any node). */
export interface ActionItemSpec {
  className?: string
  disabled?: boolean
  icon?: string
  iconNode?: React.ReactNode
  /** Stable key; defaults to `label` when it's a string. */
  key?: string
  label: React.ReactNode
  onSelect: (event: Event) => void
  variant?: 'default' | 'destructive'
}

/** Render one `ActionItemSpec` with the given kit's Item component. */
export function renderActionItem(
  kit: MenuKit,
  { className, disabled, icon, iconNode, key, label, onSelect, variant }: ActionItemSpec
) {
  return (
    <kit.Item
      className={className}
      disabled={disabled}
      key={key ?? (typeof label === 'string' ? label : undefined)}
      onSelect={onSelect}
      variant={variant}
    >
      {iconNode ?? (icon ? <Codicon name={icon} size="0.875rem" /> : null)}
      {typeof label === 'string' ? <span>{label}</span> : label}
    </kit.Item>
  )
}

interface ActionsMenuProps extends Pick<
  React.ComponentProps<typeof DropdownMenuContent>,
  'align' | 'side' | 'sideOffset'
> {
  /** The trigger (a kebab button). Wrapped in `DropdownMenuTrigger asChild`. */
  children: React.ReactNode
  /** The action rows, rendered with `DROPDOWN_KIT`. Share this with `ActionsContextMenu`. */
  items: (kit: MenuKit) => React.ReactNode
  ariaLabel?: string
  contentClassName?: string
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

/**
 * A kebab dropdown menu. Pair it with `ActionsContextMenu` using the same
 * `items` render function so the two menus stay identical. No tip on the
 * trigger — `aria-label` on the button is enough.
 */
export function ActionsMenu({
  align = 'end',
  ariaLabel,
  children,
  contentClassName,
  items,
  onOpenChange,
  open,
  side,
  sideOffset = 6
}: ActionsMenuProps) {
  return (
    <DropdownMenu onOpenChange={onOpenChange} open={open}>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent
        align={align}
        aria-label={ariaLabel}
        className={contentClassName}
        side={side}
        sideOffset={sideOffset}
      >
        {items(DROPDOWN_KIT)}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

interface ActionsContextMenuProps {
  /** The area that receives right-click. Wrapped in `ContextMenuTrigger asChild`. */
  children: React.ReactNode
  /** The action rows, rendered with `CONTEXT_KIT`. Share this with `ActionsMenu`. */
  items: (kit: MenuKit) => React.ReactNode
  ariaLabel?: string
  contentClassName?: string
  /** Skip the wrapper (render children bare) — e.g. nothing is actionable yet. */
  disabled?: boolean
}

/**
 * Wrap a row so right-clicking it opens the same menu as its kebab. Pass the
 * kebab's `items` render function so both surfaces mirror each other.
 */
export function ActionsContextMenu({
  ariaLabel,
  children,
  contentClassName,
  disabled,
  items
}: ActionsContextMenuProps) {
  if (disabled) {
    return <>{children}</>
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent aria-label={ariaLabel} className={contentClassName}>
        {items(CONTEXT_KIT)}
      </ContextMenuContent>
    </ContextMenu>
  )
}
