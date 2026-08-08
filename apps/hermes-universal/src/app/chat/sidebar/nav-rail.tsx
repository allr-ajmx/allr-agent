import '@/app/shell/nav-contrib' // side-effect: registers the app's own rail rows

import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

import { type AppView, appViewForPath, SIDEBAR_NAV_AREA, type SidebarNavContribution } from '@/app/routes'
import { NAV_ACTION_BY_VIEW } from '@/app/shell/nav-items'
import { NAV_ROW_ACTIVE, NAV_ROW_BASE } from '@/app/shell/nav-row'
import { Codicon } from '@/components/ui/codicon'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import { KbdCombo } from '@/components/ui/kbd'
import { Tip, TipKeybindLabel } from '@/components/ui/tooltip'
import { useContributions } from '@/contrib/react/use-contributions'
import { useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import { IS_MOBILE } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import { openCommandPalette } from '@/store/command-palette'
import { $bindings, bindingsFor } from '@/store/keybinds'
import { NEW_SESSION_FLASH_EVENT } from '@/store/layout'
import { openRouteTile } from '@/store/route-tiles'

// The transparent top nav rail — the SAME four items desktop shows: New session
// (an action, with a live ⌘N hint), Capabilities (skills), Messaging, Artifacts.
// Sits under the frameless titlebar (its top padding clears it). Every other view
// is reached through the command menu (opened from the titlebar on desktop, or
// the in-drawer button on phones).
//
// MJX-52: the rows come from the `sidebar.nav` area — the built-ins register in
// app/shell/nav-contrib.ts, plugin rows follow them. This file only renders.

type NavId = 'new-session' | 'skills' | 'messaging' | 'artifacts'

interface RailItem {
  icon: string
  /** Core rail ids resolve their label through i18n (`labelKey`); contributed
   *  rows carry a literal `label` instead. */
  id: NavId | string
  label?: string
  labelKey?: string
  route?: string
  run?: () => void
  view?: AppView
}

// The button look is shared with the mobile Status list — see @/app/shell/nav-row.
const ROW_BASE = NAV_ROW_BASE
const ROW_ACTIVE = NAV_ROW_ACTIVE

export function SidebarNavRail({ variant, onNavigate }: { variant: 'pane' | 'sheet'; onNavigate?: () => void }) {
  const { t } = useI18n()
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const currentView = appViewForPath(pathname)
  const [kbdFlash, setKbdFlash] = useState(false)
  // The live ⌘N combo — a rebind repaints the hint (it used to be a frozen
  // module constant, so it lied after any rebind).
  const newSessionCombo = bindingsFor('session.new', useStore($bindings))[0]

  // Core rows first (negative `order`), then contributed ones — a plugin pairing
  // a page with a rail entry. An entry with no `codicon` gets `plug`.
  const navContributions = useContributions(SIDEBAR_NAV_AREA)

  const items = useMemo<RailItem[]>(
    () =>
      navContributions.flatMap(c => {
        const data = c.data as Partial<SidebarNavContribution> | undefined

        // A row must be able to say something and do something.
        if (!data || !(data.label || data.labelKey) || !(data.run || data.path?.startsWith('/'))) {
          return []
        }

        return [
          {
            icon: data.codicon || 'plug',
            id: c.id,
            label: data.label,
            labelKey: data.labelKey,
            route: data.path,
            run: data.run,
            view: data.view
          }
        ]
      }),
    [navContributions]
  )

  // Flash the ⌘N hint when the shortcut fires from anywhere.
  useEffect(() => {
    const onFlash = () => {
      setKbdFlash(true)
      const timer = window.setTimeout(() => setKbdFlash(false), 140)

      return () => window.clearTimeout(timer)
    }

    window.addEventListener(NEW_SESSION_FLASH_EVENT, onFlash)

    return () => window.removeEventListener(NEW_SESSION_FLASH_EVENT, onFlash)
  }, [])

  const handle = (item: RailItem) => {
    // An action row owns its own behaviour (New session spawns the session AND
    // lands on the draft route); a plain row just navigates.
    if (item.run) {
      item.run()
    } else if (item.route) {
      navigate(item.route)
    }

    onNavigate?.()
  }

  return (
    <div
      className={cn(
        'shrink-0 px-2.5 pb-2',
        // The sheet drawer's safe-area top is handled by the ChatSidebar sheet
        // container now, so both variants just take a small top padding.
        variant === 'pane' ? 'pt-1.5' : 'pt-2'
      )}
    >
      <div className="flex flex-col gap-px">
        {items.map(item => {
          // Core rows light up by view; a contributed row has no AppView of its
          // own (they all resolve to 'extension'), so match its exact path.
          const active = item.view ? currentView === item.view : pathname === item.route

          const label = item.label ?? t.sidebar.nav[(item.labelKey ?? item.id) as NavId] ?? item.id
          const isNewSession = item.id === 'new-session'
          // New session already paints its combo inline, so its tip stays the
          // plain label; the other core rows carry the hint in the tooltip. A
          // contributed row has no keybind of its own, so it gets the label too.
          const actionId = item.view ? NAV_ACTION_BY_VIEW[item.view] : undefined
          const tipLabel = !isNewSession && actionId ? <TipKeybindLabel actionId={actionId} text={label} /> : label

          const row = (
            <button
              aria-current={active ? 'page' : undefined}
              className={cn(ROW_BASE, active && ROW_ACTIVE)}
              onClick={() => handle(item)}
              type="button"
            >
              <Codicon
                className="size-4 shrink-0 text-[color-mix(in_srgb,currentColor_72%,transparent)]"
                name={item.icon}
              />
              <span className="min-w-0 flex-1 truncate">{label}</span>
              {isNewSession && newSessionCombo && (
                <KbdCombo
                  className={cn('ml-auto opacity-55', kbdFlash && 'opacity-100!')}
                  combo={newSessionCombo}
                  size="sm"
                />
              )}
            </button>
          )

          // A page row can also open BESIDE the chat as a layout tile (the page
          // analog of a session tile) — same right-click verb sessions use.
          // Tiles are a layout-tree affordance, so phones don't offer it.
          if (IS_MOBILE || !item.route) {
            return (
              <Tip key={item.id} label={tipLabel}>
                {row}
              </Tip>
            )
          }

          // Tip wraps the TRIGGER, not the other way round: both compose via
          // `asChild`, and only this order leaves the button as the single real
          // child both of them clone onto.
          return (
            <ContextMenu key={item.id}>
              <Tip label={tipLabel}>
                <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
              </Tip>
              <ContextMenuContent aria-label={label}>
                <ContextMenuItem
                  onSelect={() => {
                    void triggerHaptic('selection')
                    openRouteTile(item.route!, 'right')
                  }}
                >
                  <Codicon name="split-horizontal" size="0.875rem" />
                  <span>{t.sidebar.row.openInTile}</span>
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          )
        })}

        {/* Phones have no titlebar, so the command menu (other views) needs an
            in-drawer entry point. Desktop reaches it from the titlebar. */}
        {variant === 'sheet' && (
          <Tip label={<TipKeybindLabel actionId="nav.commandPalette" text={t.titlebar.search} />}>
            <button
              className={cn(ROW_BASE, 'mt-1')}
              onClick={() => {
                openCommandPalette()
                onNavigate?.()
              }}
              type="button"
            >
              <Codicon
                className="size-4 shrink-0 text-[color-mix(in_srgb,currentColor_72%,transparent)]"
                name="search"
              />
              <span className="min-w-0 flex-1 truncate">{t.titlebar.search}</span>
            </button>
          </Tip>
        )}
      </div>
    </div>
  )
}
