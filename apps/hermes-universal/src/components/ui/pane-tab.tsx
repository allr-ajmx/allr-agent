import * as React from 'react'

import { type MenuKit, renderActionItem } from '@/components/ui/actions-menu'
import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/tooltip'
import { translateNow } from '@/i18n'
import { cn } from '@/lib/utils'

/** Inset bottom stroke for a horizontal tab strip — titlebar color, cut by the active tab. */
export const PANE_TAB_STRIP_LINE = 'shadow-[inset_0_-1px_0_var(--ui-stroke-tertiary)]'

/** Inset stroke for a vertical tab rail — content-facing edge. */
export const PANE_TAB_STRIP_LINE_LEFT = 'shadow-[inset_1px_0_0_var(--ui-stroke-tertiary)]'
export const PANE_TAB_STRIP_LINE_RIGHT = 'shadow-[inset_-1px_0_0_var(--ui-stroke-tertiary)]'

const TAB =
  'group/tab relative flex shrink-0 items-center border-transparent bg-(--tab-bg) text-[0.6875rem] font-medium [-webkit-app-region:no-drag]'

const TAB_HORIZONTAL = 'h-full min-w-0 max-w-48 border-b not-first:border-l not-first:border-l-(--ui-stroke-quaternary)'

const TAB_VERTICAL =
  'w-full max-h-48 justify-center not-first:border-t not-first:border-t-(--ui-stroke-quaternary) [writing-mode:vertical-rl]'

const TAB_ACTIVE = 'text-foreground [--tab-bg:var(--pane-tab-active-bg,var(--ui-editor-surface-background))]'

// Inactive = gutter. Hover = 4% translucent wash (VS Code/GitHub alpha hover),
// not an opaque recolor — and never touch borders.
const TAB_IDLE =
  'text-(--ui-text-tertiary) [--tab-bg:var(--pane-tab-strip-bg,var(--theme-card-seed))] hover:shadow-[inset_0_0_0_100vmax_color-mix(in_srgb,var(--ui-base)_4%,transparent)] hover:text-(--ui-text-secondary)'

// A tab riding a multi-tab selection: an accent wash over whatever surface the
// tab sits on. A background-image gradient (not a shadow) so it stacks cleanly
// over `--tab-bg` without fighting the idle hover shadow.
const TAB_SELECTED =
  '[background-image:linear-gradient(color-mix(in_srgb,var(--ui-accent)_14%,transparent),color-mix(in_srgb,var(--ui-accent)_14%,transparent))] text-foreground'

interface PaneTabProps extends React.ComponentProps<'div'> {
  active?: boolean
  dirty?: boolean
  /** Close gesture, no hover X (too easy to hit on small tabs): middle-click,
   *  or ⌘-click as the trackpad-friendly Mac equivalent. */
  onClose?: () => void
  /** Part of a multi-tab selection (⌥/Ctrl-click, Shift-click) — an accent
   *  wash marks every tab that a drag would carry, Chrome-style. */
  selected?: boolean
  /** Vertical rail form (collapsed sidebar zones). */
  vertical?: boolean
  /** Content-facing edge of a vertical rail — the strip line the active tab cuts. */
  side?: 'left' | 'right'
}

/** ⌘-click (metaKey + primary button) — the Mac has no middle button, so this
 *  is the trackpad equivalent of middle-click-to-close. Guarded on metaKey so
 *  it never collides with left-click (activate/drag) or ⌃-click (macOS context
 *  menu). */
const isMetaClose = (event: { button: number; metaKey: boolean }) => event.button === 0 && event.metaKey

/**
 * Editor tab shell — preview rail + zone headers + collapsed vertical rails.
 *
 * Strip sets `--pane-tab-active-bg` (content surface) and `--pane-tab-strip-bg`
 * (gutter; prefer `--theme-card-seed` = VS Code `tab.inactiveBackground`).
 * Active merges into content; inactive sits flush in the gutter.
 */
export const PaneTab = React.forwardRef<HTMLDivElement, PaneTabProps>(function PaneTab(
  {
    active = false,
    dirty = false,
    onClose,
    onAuxClick,
    onMouseDown,
    onPointerDown,
    onClickCapture,
    selected = false,
    vertical = false,
    side = 'left',
    children,
    className,
    ...props
  },
  ref
) {
  // Content-facing edge: horizontal cuts the bottom strip line; vertical cuts
  // the side that faces the editor (left rail → right edge, right rail → left).
  const edge = vertical ? (side === 'right' ? 'border-l' : 'border-r') : 'border-b'

  return (
    <div
      className={cn(
        TAB,
        vertical ? TAB_VERTICAL : TAB_HORIZONTAL,
        edge,
        active ? TAB_ACTIVE : cn(TAB_IDLE, `${edge}-(--ui-stroke-tertiary)`),
        selected && TAB_SELECTED,
        className
      )}
      data-active={active}
      data-selected={selected || undefined}
      data-vertical={vertical || undefined}
      onAuxClick={event => {
        // Middle-click closes (browser/IDE). Swallow mousedown so Chromium
        // doesn't autoscroll.
        if (onClose && event.button === 1) {
          event.preventDefault()
          onClose()
        }

        onAuxClick?.(event)
      }}
      onClickCapture={event => {
        // Sites whose tab activates on the label's own onClick (the preview
        // rail) fire it AFTER our pointerdown close — swallow that stray click
        // in the capture phase so it can't re-select the just-closed tab.
        if (onClose && isMetaClose(event)) {
          event.preventDefault()
          event.stopPropagation()
        }

        onClickCapture?.(event)
      }}
      onMouseDown={event => {
        if (onClose && event.button === 1) {
          event.preventDefault()
        }

        onMouseDown?.(event)
      }}
      onPointerDown={event => {
        // ⌘-click closes. Preempt here — the tab strips activate/drag on
        // pointerdown (drag-session onTap), so we must claim the press before
        // the shell's own handler starts a drag, and skip it entirely.
        if (onClose && isMetaClose(event)) {
          event.preventDefault()
          event.stopPropagation()
          onClose()

          return
        }

        onPointerDown?.(event)
      }}
      ref={ref}
      {...props}
    >
      {children}
      {dirty && (
        <span
          aria-hidden
          className={cn(
            'pointer-events-none absolute grid size-4 place-items-center',
            vertical ? 'bottom-1.5 left-1/2 -translate-x-1/2' : 'right-1.5 top-1/2 -translate-y-1/2'
          )}
        >
          <span className="size-2 rounded-full bg-amber-500 shadow-[0_0_0_2px_var(--tab-bg),0_1px_2px_rgba(0,0,0,0.45)] dark:bg-amber-400" />
        </span>
      )}
    </div>
  )
})

interface PaneTabLabelProps extends React.ComponentProps<'button'> {
  /** `button` when the label is the activation target (preview rail);
   *  default `span` defers to the shell (zone drag/activate). */
  as?: 'button' | 'span'
}

/** Truncating label inside a `PaneTab`. `className` merges into the text span
 *  (e.g. `normal-case tracking-normal` for filenames). */
export const PaneTabLabel = React.forwardRef<HTMLElement, PaneTabLabelProps>(function PaneTabLabel(
  { as = 'span', className, children, ...props },
  ref
) {
  const Comp = as as React.ElementType

  return (
    <Comp
      className="flex h-full min-w-0 max-w-full items-center overflow-hidden px-2 text-left outline-none group-data-[vertical]/tab:h-auto group-data-[vertical]/tab:w-full group-data-[vertical]/tab:justify-center group-data-[vertical]/tab:py-2"
      ref={ref}
      {...props}
    >
      <span className={cn('block min-w-0 truncate text-[9px] font-medium tracking-wide uppercase', className)}>
        {children}
      </span>
    </Comp>
  )
})

interface PaneTabStripProps extends React.ComponentProps<'div'> {
  /** The scrolling tab list — receives `role="tablist"`. */
  children: React.ReactNode
  /** Ref on the scroller itself, for `useActiveTabVisible`. */
  listRef?: React.Ref<HTMLDivElement>
  /** Non-scrolling trailing chrome pinned to the right (strip glyphs, the `+`,
   *  the minimize chevron). Outside the scroller on purpose: inside it they were
   *  scroll content, so the moment the tabs overflowed they slid off the end. */
  trailing?: React.ReactNode
}

/**
 * The horizontal tab bar every strip in the app sits in. Owns the bar's height
 * and surface, the scroll behaviour (hidden scrollbars) and the pinned trailing
 * slot — so a new strip inherits all of it instead of re-deriving the geometry
 * and drifting out of alignment.
 *
 * Tabs go in `children` as `PaneTab`s; per-strip extras (drag handlers,
 * `data-zone-tabstrip`, drop carets) ride on the usual div props.
 */
export const PaneTabStrip = React.forwardRef<HTMLDivElement, PaneTabStripProps>(function PaneTabStrip(
  { children, className, listRef, trailing, ...props },
  ref
) {
  return (
    <div
      // Active = sidebar surface (merges into the body). Strip =
      // `--theme-card-seed` (VS Code `tab.inactiveBackground`). The active tab
      // cuts through PANE_TAB_STRIP_LINE.
      className={cn(
        'group/pane-header relative flex h-7 shrink-0 select-none bg-(--pane-tab-strip-bg) [-webkit-app-region:no-drag] [--pane-tab-active-bg:var(--ui-sidebar-surface-background)] [--pane-tab-strip-bg:var(--theme-card-seed)]',
        PANE_TAB_STRIP_LINE,
        className
      )}
      ref={ref}
      {...props}
    >
      <div
        className="flex min-w-0 flex-1 overflow-x-auto overflow-y-hidden overscroll-x-contain [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        ref={listRef}
        role="tablist"
      >
        {children}
      </div>
      {trailing}
    </div>
  )
})

/** A glyph button on a tab strip: the `+` and anything a tile contributes (a
 *  preview's view-mode switch). Callers pass DATA, never classes — so every
 *  glyph on every strip matches, and a tile never grows its own button styling
 *  to drift from the rest. */
export interface PaneStripTool {
  active?: boolean
  disabled?: boolean
  icon: React.ReactNode
  id: string
  /** Tooltip text and accessible name. */
  label: string
  onSelect: () => void
}

/**
 * Renders one `PaneStripTool`: ghost variant, no active background — state reads
 * from the glyph's own opacity, with `aria-pressed` carrying it for a11y.
 *
 * Pointerdown is claimed here so a click can never also activate or drag the
 * zone behind the strip.
 */
export function PaneStripGlyph({ active, disabled, icon, label, onSelect }: Omit<PaneStripTool, 'id'>) {
  return (
    <Tip label={label}>
      <Button
        aria-label={label}
        aria-pressed={active ?? undefined}
        className={cn(
          'self-center bg-transparent select-none',
          active ? 'opacity-100' : 'opacity-60 hover:opacity-100'
        )}
        disabled={disabled}
        onClick={onSelect}
        onPointerDown={event => event.stopPropagation()}
        size="icon-xs"
        type="button"
        variant="ghost"
      >
        {icon}
      </Button>
    </Tip>
  )
}

/** Close-verb enablement for `paneTabCloseItems` — how many tabs each verb hits. */
export interface PaneTabCloseCounts {
  all: number
  others: number
  right: number
}

interface PaneTabCloseItemsOptions {
  counts: PaneTabCloseCounts
  /** Omit to hide Close entirely (an uncloseable tab shows no dead action). */
  onClose?: () => void
  onCloseAll: () => void
  onCloseOthers: () => void
  onCloseToRight: () => void
}

/**
 * The four close verbs every tab menu offers — Close / others / to the right /
 * all — so a tab answers a right-click the same way wherever it lives. No ⌘W
 * hint on Close: the keybind closes the FOCUSED zone's active tab, so it would
 * be a lie on the inactive tab the user actually right-clicked.
 */
export function paneTabCloseItems(
  kit: MenuKit,
  { counts, onClose, onCloseAll, onCloseOthers, onCloseToRight }: PaneTabCloseItemsOptions
) {
  return (
    <>
      {onClose &&
        renderActionItem(kit, {
          icon: 'close',
          label: translateNow('common.close'),
          onSelect: onClose
        })}
      {renderActionItem(kit, {
        disabled: !counts.others,
        icon: 'close-all',
        label: translateNow('zones.closeOthers'),
        onSelect: onCloseOthers
      })}
      {renderActionItem(kit, {
        disabled: !counts.right,
        icon: 'arrow-right',
        label: translateNow('zones.closeToRight'),
        onSelect: onCloseToRight
      })}
      {renderActionItem(kit, {
        disabled: !counts.all,
        icon: 'clear-all',
        label: translateNow('zones.closeAll'),
        onSelect: onCloseAll
      })}
    </>
  )
}
