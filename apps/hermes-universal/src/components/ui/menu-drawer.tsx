import { createContext, type ReactNode, useContext, useState } from 'react'

import { Codicon } from '@/components/ui/codicon'
import { TopDrawer, TopDrawerRow } from '@/components/ui/top-drawer'
import { cn } from '@/lib/utils'

import type { MenuItemProps, MenuKit, MenuSectionProps } from './actions-menu'

/**
 * A `MenuKit` that renders a menu as a top DRAWER, with submenus as PAGES.
 *
 * The menu itself is not rewritten. A caller already describes its rows once and
 * hands the description to `DROPDOWN_KIT` or `CONTEXT_KIT`; this is a third
 * flavour of the same seam, so a touch surface costs a kit rather than a second
 * copy of what the menu contains — which is how the two would drift apart.
 *
 * WHY PAGES AND NOT NESTING. A Radix submenu opens on HOVER, which a finger does
 * not have, and lands a second floating panel over the first. Here a submenu row
 * pushes its content as a page with a back button: one panel, full-width rows,
 * and the same gesture for every level.
 */

interface DrawerPage {
  content: ReactNode
  title: string
}

interface MenuDrawerContext {
  close: () => void
  push: (page: DrawerPage) => void
}

const Ctx = createContext<MenuDrawerContext>({ close: () => {}, push: () => {} })

/** Pull the readable text out of a node tree.
 *
 *  A submenu's trigger is `<Codicon/><span>Label</span>`, and the page it pushes
 *  needs a TITLE — a string, not that tree. The kit only ever sees the rendered
 *  children (the spec that produced them belongs to the caller), so the label is
 *  recovered from them rather than threaded through every spec type. */
function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }

  if (Array.isArray(node)) {
    return node.map(textOf).join('')
  }

  if (node && typeof node === 'object' && 'props' in node) {
    return textOf((node as { props?: { children?: ReactNode } }).props?.children)
  }

  return ''
}

function DrawerItem({ children, className, disabled, onSelect, variant }: MenuItemProps) {
  const { close } = useContext(Ctx)

  if (disabled) {
    return (
      <div
        className={cn(
          'flex min-h-(--touch-target-min) w-full items-center gap-3 px-4 text-sm opacity-50',
          variant === 'destructive' && 'text-destructive',
          className
        )}
      >
        {children}
      </div>
    )
  }

  return (
    <TopDrawerRow
      onSelect={() => {
        // Radix hands `onSelect` a DOM event it can `preventDefault()` to keep
        // the menu open. Nothing in a drawer reads it, but the signature is the
        // caller's, so give it a real event rather than a cast.
        onSelect?.(new Event('select'))
        close()
      }}
    >
      <span className={cn('flex min-w-0 flex-1 items-center gap-3', variant === 'destructive' && 'text-destructive')}>
        {children}
      </span>
    </TopDrawerRow>
  )
}

/** Markers. `Sub` reads them off its own children; on their own they render
 *  nothing, which is why they never reach the DOM. */
function DrawerSubTrigger({ children }: MenuSectionProps) {
  return <>{children}</>
}

function DrawerSubContent({ children }: MenuSectionProps) {
  return <>{children}</>
}

function DrawerSub({ children }: MenuSectionProps) {
  const { push } = useContext(Ctx)
  const parts = Array.isArray(children) ? children : [children]

  const trigger = parts.find(
    (part): part is { props: { children?: ReactNode }; type: unknown } =>
      !!part && typeof part === 'object' && 'type' in part && part.type === DrawerSubTrigger
  )

  const content = parts.find(
    (part): part is { props: { children?: ReactNode }; type: unknown } =>
      !!part && typeof part === 'object' && 'type' in part && part.type === DrawerSubContent
  )

  const label = textOf(trigger?.props?.children)

  return (
    <TopDrawerRow onSelect={() => push({ content: content?.props?.children, title: label })}>
      <span className="flex min-w-0 flex-1 items-center gap-3">{trigger?.props?.children}</span>
      <Codicon className="shrink-0 opacity-60 rtl:-scale-x-100" name="chevron-right" size="0.875rem" />
    </TopDrawerRow>
  )
}

function DrawerLabel({ children, className }: MenuSectionProps) {
  return (
    <p className={cn('px-4 pt-3 pb-1 text-xs font-medium tracking-wide text-(--ui-text-tertiary) uppercase', className)}>
      {children}
    </p>
  )
}

function DrawerSeparator() {
  return <div aria-hidden className="my-1 h-px bg-border/65" />
}

export const DRAWER_KIT: MenuKit = {
  Item: DrawerItem,
  Label: DrawerLabel,
  Separator: DrawerSeparator,
  Sub: DrawerSub,
  SubContent: DrawerSubContent,
  SubTrigger: DrawerSubTrigger,
  copyAppearance: 'menu-item'
}

/**
 * Host a kit-rendered menu in a top drawer.
 *
 * Owns the page stack so `DRAWER_KIT` can push from anywhere inside the tree
 * without the caller threading state through its spec list.
 */
export function MenuDrawer({
  offsetTop,
  onOpenChange,
  open,
  render,
  title
}: {
  /** Bottom edge of the control that opened this — see `TopDrawer`. */
  offsetTop?: number
  onOpenChange: (open: boolean) => void
  open: boolean
  render: (kit: MenuKit) => ReactNode
  title: string
}) {
  const [page, setPage] = useState<DrawerPage | null>(null)

  const close = () => {
    onOpenChange(false)
    // Reset on the way out — reopening into a page you left behind reads as the
    // drawer having remembered the wrong thing.
    setPage(null)
  }

  return (
    <Ctx.Provider value={{ close, push: setPage }}>
      <TopDrawer
        offsetTop={offsetTop}
        onBack={page ? () => setPage(null) : undefined}
        onOpenChange={next => (next ? onOpenChange(true) : close())}
        open={open}
        title={page ? page.title : title}
      >
        {page ? page.content : render(DRAWER_KIT)}
      </TopDrawer>
    </Ctx.Provider>
  )
}
