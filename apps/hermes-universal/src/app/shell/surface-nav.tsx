import type { ReactNode } from 'react'
import { useLocation } from 'react-router-dom'

import { COMMAND_CENTER_ROUTE } from '@/app/routes'
import { useSettingsNavGroups } from '@/app/settings/settings-nav'
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
  /** A sub-tab, listed under its group and indented. */
  indent?: boolean
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
  //
  // The GROUPED model, not the flat `useSettingsNav()` this used to read. The
  // flat one has no `children`, so the phone could not list Providers → API
  // keys / Custom endpoints or Keys → Settings at all; they were reachable only
  // by opening the group and finding a second, different control inside the
  // page. This is the same model the desktop rail renders, so the two now agree
  // on what Settings contains.
  const settingsEntries = useSettingsNavGroups()

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

    const section = location.pathname.startsWith('/settings/')
      ? location.pathname.slice('/settings/'.length)
      : (settingsEntries[0]?.id ?? '')

    // Groups AND their sub-tabs, flattened and indented — the same shape
    // `OverlayNav` flattens into its narrow dropdown. Only the groups were
    // listed before, which put Providers → API keys (and Keys → Settings)
    // behind a group tap and then a second, different control inside the page.
    return settingsEntries.flatMap(entry => [
      {
        active: entry.id === topId && section === entry.id,
        icon: <entry.icon className={ICON_CLASS} />,
        id: entry.id,
        label: entry.label,
        path: `/settings/${entry.id}`
      },
      ...(entry.children ?? []).map(child => ({
        active: section === child.id,
        icon: <child.icon className={ICON_CLASS} />,
        id: child.id,
        indent: true,
        label: child.label,
        path: `/settings/${child.id}`
      }))
    ])
  }

  return []
}
