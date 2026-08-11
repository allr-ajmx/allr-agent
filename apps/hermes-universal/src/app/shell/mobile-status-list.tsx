import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'

import { useStatusbarContributions } from '@/app/contrib/surfaces'
import { useStatusbarItems } from '@/app/shell/hooks/use-statusbar-items'
import { NAV_ROW_ACTIVE } from '@/app/shell/nav-row'
import { SidebarPanelLabel } from '@/app/shell/sidebar-label'
import { type StatusbarItem, StatusbarItemView } from '@/app/shell/statusbar-controls'
import { useI18n } from '@/i18n'
import { Settings, Users } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { openProfilesScreen, openSettingsScreen } from '@/store/windows'

// Bar-layout class that only makes sense as a compact icon-only square; stripped
// when re-rendering those items as full-width rows.
const ICON_ONLY_BAR_CLASS = 'w-7 justify-center px-0'

// The bar's active highlight; rows use the sidebar nav-rail's active look instead.
const BAR_ACTIVE_CLASS = 'bg-accent/55 text-foreground'

// Sections whose rows use a lighter label weight — the status VALUE stays
// emphasized (its accent span keeps font-medium), the label reads calmer.
const LIGHT_LABEL_SECTIONS = new Set(['Status', 'Updates'])

// The Status tab, ordered into sidebar-style sections (see the left sidebar's
// session sections). Each entry lists the item ids in display order.
// Trailing section: the core `plugins` row (inventory counts → Settings ▸ Plugins)
// followed by every `statusBar.*` contribution — ids no SECTION claims. Kept out
// of SECTIONS because its membership is discovered, not listed.
//
// The core row leads this section rather than sitting under System so the word
// "Plugins" appears once: as the heading over the manage row and the plugin-
// contributed rows it governs.
const PLUGINS_SECTION = 'Plugins'

const SECTIONS: { title: string; ids: readonly string[] }[] = [
  { title: 'Session', ids: ['running-timer', 'session-timer', 'context-usage'] },
  { title: 'Status', ids: ['gateway-health', 'workspace-cwd', 'agents', 'cron', 'approval-mode'] },
  { title: 'Updates', ids: ['version-client', 'version-backend'] },
  { title: 'System', ids: ['command-center'] }
]

// Ids this list deliberately drops. `terminal` toggles `$terminalOpen`, which
// only desktop surfaces read — on a phone the terminal is a Workspace tab, so
// the row looked live and did nothing. It has to be named here rather than just
// left out of SECTIONS, because anything a section does not claim falls through
// into the trailing contributed bucket.
const HIDDEN_IDS = new Set(['terminal'])

// Re-shape a bar descriptor for the nav-styled row list:
//   • icon-only items (command-center) have no label + a square layout
//     class → label from the tooltip title, drop the square class;
//   • swap the bar's active highlight for the nav-rail active style so an active
//     row matches the left sidebar's selected button.
function toRow(item: StatusbarItem): StatusbarItem {
  // A render-item owns its own node (a plugin's stateful component). The label /
  // class rewriting below would be meaningless at best and corrupting at worst.
  if (item.render) {
    return item
  }

  let className = item.className
  let label = item.label

  if (!label && item.title) {
    className = className?.replace(ICON_ONLY_BAR_CLASS, '').trim() || undefined
    label = item.title
  }

  className = className?.replace(BAR_ACTIVE_CLASS, NAV_ROW_ACTIVE).trim() || undefined

  return { ...item, className, label }
}

/**
 * One row of the list.
 *
 * This component exists ONLY to give the reshaped descriptor a stable identity
 * (MJXHRM-303). `toRow` spreads its input, so calling it inline in the list body
 * handed `StatusbarItemView` a brand-new object on every render — discarding, at
 * the very last hop, the whole per-item restructure `useStatusbarItems` does
 * upstream. The phone never mounts `<Statusbar/>`, so this list is the only
 * surface those items reach on mobile: the memo was dead in the one root that
 * matters there, on every one of the ~20 stores the hook subscribes to.
 *
 * Deliberately NOT wrapped in `memo()`. Re-running two `useMemo` lookups is
 * cheap, and `StatusbarItemView`'s own memo is the boundary that bails — one
 * comparison per row, in the place the ticket put it.
 */
function MobileStatusRow({
  item,
  light,
  navigate
}: {
  item: StatusbarItem
  /** Sections whose labels read calmer (see LIGHT_LABEL_SECTIONS). */
  light: boolean
  navigate: ReturnType<typeof useNavigate>
}) {
  const rowItem = useMemo(() => toRow(item), [item])

  const finalItem = useMemo(
    () => (light ? { ...rowItem, className: cn(rowItem.className, 'font-normal') } : rowItem),
    [light, rowItem]
  )

  return <StatusbarItemView item={finalItem} navigate={navigate} row />
}

// The mobile Status tab: the full status-bar inventory (see useStatusbarItems,
// `rich`) as vertical nav-styled rows, grouped into Session / Status / System
// sections with sidebar-style headers.
export function MobileStatusList() {
  const { t } = useI18n()
  const navigate = useNavigate()
  // The phone never mounts the Statusbar (MobileController gates it on
  // !IS_MOBILE), so this list is the ONLY place `statusBar.*` contributions can
  // surface on mobile — pull them here too, not just in the bar.
  const extraLeftItems = useStatusbarContributions('left')
  const extraRightItems = useStatusbarContributions('right')

  const { leftStatusbarItems, statusbarItems } = useStatusbarItems({
    extraLeftItems,
    extraRightItems,
    includeAll: true,
    rich: true
  })

  // Open Settings — appended to the System section (opens the Settings activity on
  // Android, the in-app overlay elsewhere). A synthetic action item so it renders
  // identically to the other System rows (command-center). Memoized like every
  // other descriptor here: these two go straight into `StatusbarItemView`, so a
  // fresh literal per render is a guaranteed memo miss (MJXHRM-303).
  const openSettingsRow: StatusbarItem = useMemo(
    () => ({
      icon: <Settings className="size-3.5" />,
      id: 'open-settings',
      label: t.titlebar.openSettings,
      onSelect: () => void openSettingsScreen(),
      title: t.titlebar.openSettings,
      variant: 'action'
    }),
    [t.titlebar.openSettings]
  )

  // Profiles — the third windowable screen; opens the Profiles surface (native
  // screen activity on Android, in-app overlay elsewhere).
  const openProfilesRow: StatusbarItem = useMemo(
    () => ({
      icon: <Users className="size-3.5" />,
      id: 'open-profiles',
      label: t.profiles.title,
      onSelect: () => void openProfilesScreen(),
      title: t.profiles.title,
      variant: 'action'
    }),
    [t.profiles.title]
  )

  // Section assembly, memoized on the two groups. It allocates a Map, a Set and
  // four arrays, and the hook above re-runs on ~20 stores — the groups only
  // change identity when an item in them actually changed, so this now runs once
  // per real change instead of once per store write.
  const sections = useMemo(() => {
    const byId = new Map<string, StatusbarItem>()

    for (const item of [...leftStatusbarItems, ...statusbarItems]) {
      if (!item.hidden) {
        byId.set(item.id, item)
      }
    }

    const claimed = new Set(SECTIONS.flatMap(section => section.ids))

    // Anything not claimed by a SECTION used to be dropped silently. SECTIONS covers
    // every other core id useStatusbarItems emits, so this bucket is the core
    // `plugins` row — pinned first, whichever group it came from — followed by the
    // `statusBar.*` contributions in insertion order (left group, then right).
    const unclaimed = [...byId.values()].filter(item => !claimed.has(item.id) && !HIDDEN_IDS.has(item.id))
    const manageRow = unclaimed.find(item => item.id === 'plugins')

    const contributed = [...(manageRow ? [manageRow] : []), ...unclaimed.filter(item => item.id !== 'plugins')]

    return [
      ...SECTIONS.map(section => ({
        title: section.title,
        items: section.ids.map(id => byId.get(id)).filter((item): item is StatusbarItem => Boolean(item))
      })),
      { title: PLUGINS_SECTION, items: contributed }
    ].filter(section => section.items.length > 0)
  }, [leftStatusbarItems, statusbarItems])

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2.5 py-2">
      {sections.map(section => (
        // Extra top space separates a section's heading from the previous
        // section's rows; the first section keeps a smaller gap under the tab bar.
        <div className="pt-4 first:pt-2" key={section.title}>
          <div className="flex shrink-0 items-center pb-2 pt-1.5">
            <SidebarPanelLabel>{section.title}</SidebarPanelLabel>
          </div>
          <div className="flex flex-col gap-px">
            {section.items.map(item => (
              <MobileStatusRow
                item={item}
                key={item.id}
                light={LIGHT_LABEL_SECTIONS.has(section.title)}
                navigate={navigate}
              />
            ))}
            {/* The screen switcher (Open Settings · Profiles) sits at the end of
                the System section, next to Command Center. */}
            {section.title === 'System' && (
              <>
                <StatusbarItemView item={openSettingsRow} navigate={navigate} row />
                <StatusbarItemView item={openProfilesRow} navigate={navigate} row />
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
