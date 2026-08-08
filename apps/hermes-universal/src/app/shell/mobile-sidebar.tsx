import '@/app/shell/nav-contrib' // side-effect: registers the app's own rail rows

import { useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'

import { ProfileRail } from '@/app/chat/sidebar/profile-switcher'
import { SidebarScrollBody } from '@/app/chat/sidebar/sidebar-content'
import { SIDEBAR_NAV_AREA, type SidebarNavContribution } from '@/app/routes'
import { MobileChromeBar } from '@/app/shell/mobile-chrome-bar'
import { MobileTabBar, MobileTabButton } from '@/app/shell/mobile-tab-button'
import { TitlebarButton } from '@/app/shell/titlebar-button'
import { Codicon } from '@/components/ui/codicon'
import { useContributions } from '@/contrib/react/use-contributions'
import { useI18n } from '@/i18n'
import { ESCAPE_PRIORITY, isTopEscapeLayer, pushEscapeLayer } from '@/lib/escape-layers'
import { openCommandPalette } from '@/store/command-palette'

// The phone's sidebar: a full-screen surface, not a 19rem drawer.
//
// It is the Workspace's mirror image, deliberately — same chrome bar, same
// bottom nav bar, same escape — because they are the app's two halves and a
// phone should not have to learn two shapes for "the other side of the chat".
// A drawer also spent a third of the screen on a dimmed backdrop, on the one
// surface that is nothing but a long list.
//
// Order, top to bottom: who you are (the profile rail), what you have (pinned,
// sessions, messaging, cron), how you find it (search), where else you can go
// (the nav bar). The two controls you reach for most sit in the thumb zone; the
// list gets everything in between.
//
// The nav rows are the SAME `sidebar.nav` contributions the desktop rail renders
// — plugin rows included — so a contributed page reaches a phone without knowing
// this surface exists. What is NOT carried over is the rail's keyboard-shortcut
// chrome: a ⌘N hint on a device with no ⌘ is noise.
export function MobileSidebar({ onClose }: { onClose: () => void }) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const navContributions = useContributions(SIDEBAR_NAV_AREA)

  const rows = useMemo(
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
            label: data.label ?? t.sidebar.nav[(data.labelKey ?? c.id) as keyof typeof t.sidebar.nav] ?? c.id,
            run: data.run,
            route: data.path
          }
        ]
      }),
    [navContributions, t]
  )

  // Escape closes the surface, under the shared layer order so a dialog opened
  // inside it (the project editor, a row's action sheet) gets first refusal.
  useEffect(() => {
    const release = pushEscapeLayer(ESCAPE_PRIORITY.overlay)

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !isTopEscapeLayer(ESCAPE_PRIORITY.overlay)) {
        return
      }

      event.preventDefault()
      onClose()
    }

    window.addEventListener('keydown', onKeyDown)

    return () => {
      release()
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  return (
    <div
      // Slides in from the side it belongs to, fast. A full-screen surface that
      // simply appears reads as a route change rather than a panel, and gives no
      // hint which edge to swipe back toward. 150ms — long enough to see the
      // direction, short enough that it never sits between you and the list.
      // Enter only: an exit needs the surface to outlive its own unmount.
      className="animate-in slide-in-from-left fixed right-0 left-0 z-50 flex flex-col bg-(--ui-sidebar-surface-background) duration-150"
      style={{
        // The VISIBLE rectangle — see MobileWorkspace for why this is not
        // `inset-0` plus a keyboard margin.
        height: 'var(--visual-viewport-height, 100%)',
        paddingLeft: 'var(--safe-area-inset-left)',
        paddingRight: 'var(--safe-area-inset-right)',
        top: 'var(--visual-viewport-top, 0px)'
      }}
    >
      <MobileChromeBar
        center={<span className="block truncate text-xs text-muted-foreground">{t.sidebar.sessions}</span>}
        left={
          <TitlebarButton className="size-4" label={t.mobileWorkspace.backToChat} onClick={onClose}>
            <Codicon name="chevron-left" size="1.4rem" />
          </TitlebarButton>
        }
      />

      {/* Who you are. On the desktop pane this is a footer, under a nav rail that
          no longer exists here — so it takes the top, where an identity belongs. */}
      <div className="shrink-0 px-2 pb-1 pt-1">
        <ProfileRail />
      </div>

      <SidebarScrollBody onNavigate={onClose} searchPlacement="bottom" />

      <MobileTabBar ariaLabel={t.titlebar.showSidebar}>
        {rows.map(row => (
          <MobileTabButton
            icon={row.icon}
            key={row.id}
            label={row.label}
            onSelect={() => {
              // An action row owns its behaviour (New session spawns the session
              // AND lands on the draft route); a plain row just navigates.
              if (row.run) {
                row.run()
              } else if (row.route) {
                navigate(row.route)
              }

              onClose()
            }}
          />
        ))}

        {/* Every view that is not one of the rows above. A phone has no titlebar
            to reach the command palette from, so it lives here. */}
        <MobileTabButton
          icon="search"
          label={t.titlebar.search}
          onSelect={() => {
            openCommandPalette()
            onClose()
          }}
        />
      </MobileTabBar>
    </div>
  )
}
