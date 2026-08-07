import type { ReactNode } from 'react'
import { useLocation } from 'react-router-dom'

import { COMMAND_CENTER_ROUTE } from '@/app/routes'
import { useSettingsNav } from '@/app/settings/settings-nav'
import { useI18n } from '@/i18n'
import { Activity, BarChart3, MessageCircle, Wrench } from '@/lib/icons'
import type { ActivitySurface } from '@/store/windows'

// The view navigation for a windowable surface, as data.
//
// Section state lives in the URL — Command Center reads `?section=`, Settings
// reads `/settings/:id` — so a row is just a path: navigating re-renders the
// chromeless view at that section. Extracted from the old activity-screen nav
// drawer so the phone can present the same rows as a title dropdown.

// Match the nav-rail's dimmed icon look (72% of the row's text colour).
const ICON_CLASS = 'size-4 shrink-0 text-[color-mix(in_srgb,currentColor_72%,transparent)]'

export interface SurfaceNavRow {
  active: boolean
  icon: ReactNode
  id: string
  label: string
  path: string
}

const CC_SECTIONS = [
  { Icon: MessageCircle, id: 'sessions' },
  { Icon: Activity, id: 'system' },
  { Icon: BarChart3, id: 'usage' },
  { Icon: Wrench, id: 'maintenance' }
] as const

/** Empty for a surface with no fixed sub-sections (Profiles, Cron) — both are
 *  master/detail lists whose navigation is the list itself. */
export function useSurfaceNavRows(surface: ActivitySurface): SurfaceNavRow[] {
  const { t } = useI18n()
  const location = useLocation()
  // Hooks run unconditionally; only the settings branch consumes this.
  const settingsEntries = useSettingsNav()

  if (surface === 'command-center') {
    const active = new URLSearchParams(location.search).get('section') ?? 'sessions'

    return CC_SECTIONS.map(({ Icon, id }) => ({
      active: active === id,
      icon: <Icon className={ICON_CLASS} />,
      id,
      label: t.commandCenter.sections[id],
      path: `${COMMAND_CENTER_ROUTE}?section=${id}`
    }))
  }

  if (surface === 'settings') {
    const topId = location.pathname.startsWith('/settings/')
      ? location.pathname.slice('/settings/'.length).split('/')[0]
      : settingsEntries[0]?.id

    return settingsEntries.map(entry => ({
      active: entry.id === topId,
      icon: <entry.icon className={ICON_CLASS} />,
      id: entry.id,
      label: entry.label,
      path: `/settings/${entry.id}`
    }))
  }

  return []
}
