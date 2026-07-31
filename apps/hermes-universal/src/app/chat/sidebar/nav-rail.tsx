import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

import {
  type AppView,
  appViewForPath,
  ARTIFACTS_ROUTE,
  MESSAGING_ROUTE,
  NEW_CHAT_ROUTE,
  SKILLS_ROUTE
} from '@/app/routes'
import { NAV_ROW_ACTIVE, NAV_ROW_BASE } from '@/app/shell/nav-row'
import { Codicon } from '@/components/ui/codicon'
import { KbdGroup } from '@/components/ui/kbd'
import { Tip, TipKeybindLabel } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { comboTokens } from '@/lib/keybinds/combo'
import { IS_MOBILE } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { newChatBubble } from '@/store/chat-bubbles'
import { openCommandMenu } from '@/store/command-menu'
import { $bindings, bindingsFor } from '@/store/keybinds'
import { NEW_SESSION_FLASH_EVENT } from '@/store/layout'
import { newSession } from '@/store/session'

// The transparent top nav rail — the SAME four items desktop shows: New session
// (an action, with a ⌘N hint), Capabilities (skills), Messaging, Artifacts. Sits
// under the frameless titlebar (its top padding clears it). Every other view is
// reached through the command menu (opened from the titlebar on desktop, or the
// in-drawer button on phones).

type NavId = 'new-session' | 'skills' | 'messaging' | 'artifacts'

interface RailItem {
  id: NavId
  icon: string
  /** Keybind action id — drives the row's tooltip hint (and, for new-session,
   *  the inline caps). Reading it from the registry keeps the hint honest after
   *  a rebind; this row used to hardcode `comboTokens('mod+n')`. */
  keybindActionId: string
  route?: string
  view?: AppView
}

const NAV: RailItem[] = [
  { id: 'new-session', icon: 'robot', keybindActionId: 'session.new' },
  { id: 'skills', icon: 'symbol-misc', keybindActionId: 'nav.skills', route: SKILLS_ROUTE, view: 'skills' },
  { id: 'messaging', icon: 'comment', keybindActionId: 'nav.messaging', route: MESSAGING_ROUTE, view: 'messaging' },
  { id: 'artifacts', icon: 'files', keybindActionId: 'nav.artifacts', route: ARTIFACTS_ROUTE, view: 'artifacts' }
]

// The button look is shared with the mobile Status list — see @/app/shell/nav-row.
const ROW_BASE = NAV_ROW_BASE
const ROW_ACTIVE = NAV_ROW_ACTIVE

export function SidebarNavRail({ variant, onNavigate }: { variant: 'pane' | 'sheet'; onNavigate?: () => void }) {
  const { t } = useI18n()
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const currentView = appViewForPath(pathname)
  const [kbdFlash, setKbdFlash] = useState(false)
  // Live, not frozen: subscribing to $bindings re-renders the caps on a rebind.
  // bindingsFor falls through stored overrides to the shipped default, so a
  // contributed action resolves too.
  const bindings = useStore($bindings)
  const newSessionCombo = bindingsFor('session.new', bindings)[0]

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
    if (item.id === 'new-session') {
      // Mobile: spawn a new parallel bubble instead of replacing the current
      // chat (no-op when already on a draft). Desktop: plain new session.
      if (IS_MOBILE) {
        newChatBubble()
      } else {
        newSession()
      }

      navigate(NEW_CHAT_ROUTE)
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
        {NAV.map(item => {
          const active = Boolean(item.view) && currentView === item.view
          const label = t.sidebar.nav[item.id]
          const isNewSession = item.id === 'new-session'

          return (
            // New session already paints its combo inline, so its tip stays the
            // plain label — the other rows carry the hint in the tooltip.
            <Tip
              key={item.id}
              label={isNewSession ? label : <TipKeybindLabel actionId={item.keybindActionId} text={label} />}
            >
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
                  <KbdGroup
                    className={cn('ml-auto opacity-55', kbdFlash && 'opacity-100!')}
                    keys={comboTokens(newSessionCombo)}
                    size="sm"
                  />
                )}
              </button>
            </Tip>
          )
        })}

        {/* Phones have no titlebar, so the command menu (other views) needs an
            in-drawer entry point. Desktop reaches it from the titlebar. */}
        {variant === 'sheet' && (
          <Tip label={<TipKeybindLabel actionId="nav.commandPalette" text={t.titlebar.search} />}>
            <button
              className={cn(ROW_BASE, 'mt-1')}
              onClick={() => {
                openCommandMenu()
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
