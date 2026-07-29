import type { ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

import { COMMAND_CENTER_ROUTE } from '@/app/routes'
import { useSettingsNav } from '@/app/settings/settings-nav'
import { NAV_ROW_ACTIVE, NAV_ROW_BASE } from '@/app/shell/nav-row'
import { Codicon } from '@/components/ui/codicon'
import { useI18n } from '@/i18n'
import { Activity, BarChart3, MessageCircle, Wrench } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { type ActivitySurface, returnHome } from '@/store/windows'

// The left drawer for a native activity screen (MJX-141): the surface's view
// navigation rendered in the SAME row format as the home page's nav rail (shared
// NAV_ROW_* from @/app/shell/nav-row), with a Home entry on top that finishes the
// activity → MainActivity. Command Center lists Sessions/System/Usage/Maintenance
// (driven by the `?section=` query the view reads); Settings lists its sections
// (driven by `/settings/:id`). Section state lives in the URL, so tapping a row
// just navigates and the chromeless view (`hideNav`) re-renders that section.

// Match the nav-rail's dimmed icon look (72% of the row's text colour).
const ICON_CLASS = 'size-4 shrink-0 text-[color-mix(in_srgb,currentColor_72%,transparent)]'

interface NavRowModel {
  id: string
  icon: ReactNode
  label: string
  active: boolean
  onSelect: () => void
}

function NavRow({ active, icon, label, onSelect }: Omit<NavRowModel, 'id'>) {
  return (
    <button
      aria-current={active ? 'page' : undefined}
      className={cn(NAV_ROW_BASE, active && NAV_ROW_ACTIVE)}
      onClick={onSelect}
      title={label}
      type="button"
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  )
}

const CC_SECTIONS = [
  { id: 'sessions', Icon: MessageCircle },
  { id: 'system', Icon: Activity },
  { id: 'usage', Icon: BarChart3 },
  { id: 'maintenance', Icon: Wrench }
] as const

export function ActivityNavSidebar({
  surface,
  onNavigate,
  footer
}: {
  surface: ActivitySurface
  /** Close the drawer after a selection (sheet variant). */
  onNavigate?: () => void
  /** Optional footer row (Settings uses it for Export / Import / Reset). */
  footer?: ReactNode
}) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const location = useLocation()
  // Hooks run unconditionally; only the settings branch consumes this.
  const settingsEntries = useSettingsNav()

  const go = (path: string) => {
    navigate(path)
    onNavigate?.()
  }

  let rows: NavRowModel[]

  if (surface === 'command-center') {
    const active = new URLSearchParams(location.search).get('section') ?? 'sessions'

    rows = CC_SECTIONS.map(({ id, Icon }) => ({
      id,
      icon: <Icon className={ICON_CLASS} />,
      label: t.commandCenter.sections[id],
      active: active === id,
      onSelect: () => go(`${COMMAND_CENTER_ROUTE}?section=${id}`)
    }))
  } else if (surface === 'settings') {
    const topId = location.pathname.startsWith('/settings/')
      ? location.pathname.slice('/settings/'.length).split('/')[0]
      : settingsEntries[0]?.id

    rows = settingsEntries.map(entry => ({
      id: entry.id,
      icon: <entry.icon className={ICON_CLASS} />,
      label: entry.label,
      active: entry.id === topId,
      onSelect: () => go(`/settings/${entry.id}`)
    }))
  } else {
    // Profiles is a master/detail list with no fixed sub-sections — the drawer is
    // just the Home entry (the switcher lives in the right drawer).
    rows = []
  }

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-(--ui-sidebar-surface-background)"
      style={{ paddingTop: 'var(--safe-area-inset-top)', paddingBottom: 'var(--safe-area-inset-bottom)' }}
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2.5 pb-2 pt-2">
        <div className="flex flex-col gap-px">
          {/* Home entry — finishes the activity, returning to MainActivity. */}
          <NavRow
            active={false}
            icon={<Codicon className={ICON_CLASS} name="home" />}
            label="Home"
            onSelect={() => {
              void returnHome()
              onNavigate?.()
            }}
          />

          {rows.map(row => (
            <NavRow active={row.active} icon={row.icon} key={row.id} label={row.label} onSelect={row.onSelect} />
          ))}
        </div>
      </div>

      {footer && <div className="flex shrink-0 items-center gap-1 px-2.5 pb-1 pt-0.5">{footer}</div>}
    </div>
  )
}
