import { useCallback, useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

import { appViewForPath, isOverlayView, NEW_CHAT_ROUTE, SETTINGS_ROUTE } from '@/app/routes'

// Ported from apps/desktop/src/app/shell/hooks/use-overlay-routing.ts. Overlay
// views (settings / command-center / agents / cron / profiles / starmap /
// webhooks) render
// as full-screen portals over the chat backdrop rather than routed panes, so the
// router only carries which one is open. A single `returnPathRef` stashes the
// underlying path while no overlay is open, so closing any of them returns there
// instead of bouncing to `/`.
//
// Seam vs desktop: universal's Settings has nested routes (`/settings/gateway`,
// …) which `appViewForPath` maps to 'chat', so settings is matched by prefix.
// Desktop's contributed-plugin ('extension') view has no universal equivalent.
export function useOverlayRouting() {
  const location = useLocation()
  const navigate = useNavigate()

  const currentView = appViewForPath(location.pathname)
  const settingsOpen = location.pathname === SETTINGS_ROUTE || location.pathname.startsWith(`${SETTINGS_ROUTE}/`)
  const commandCenterOpen = currentView === 'command-center'
  const agentsOpen = currentView === 'agents'
  const starmapOpen = currentView === 'starmap'
  const cronOpen = currentView === 'cron'
  const profilesOpen = currentView === 'profiles'
  const webhooksOpen = currentView === 'webhooks'
  const chatOpen = currentView === 'chat' && !settingsOpen
  const overlayOpen = settingsOpen || isOverlayView(currentView)

  const returnPathRef = useRef(NEW_CHAT_ROUTE)

  useEffect(() => {
    if (!overlayOpen) {
      returnPathRef.current = `${location.pathname}${location.search}${location.hash}`
    }
  }, [location.hash, location.pathname, location.search, overlayOpen])

  const closeOverlayToPreviousRoute = useCallback(
    () => navigate(returnPathRef.current || NEW_CHAT_ROUTE, { replace: true }),
    [navigate]
  )

  return {
    agentsOpen,
    chatOpen,
    closeOverlayToPreviousRoute,
    commandCenterOpen,
    cronOpen,
    currentView,
    overlayOpen,
    profilesOpen,
    returnPathRef,
    settingsOpen,
    starmapOpen,
    webhooksOpen
  }
}
