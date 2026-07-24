import { useNavigate } from 'react-router-dom'

import { useStatusbarItems } from '@/app/shell/hooks/use-statusbar-items'
import { NAV_ROW_ACTIVE } from '@/app/shell/nav-row'
import { SidebarPanelLabel } from '@/app/shell/sidebar-label'
import { type StatusbarItem, StatusbarItemView } from '@/app/shell/statusbar-controls'
import { cn } from '@/lib/utils'

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
const SECTIONS: { title: string; ids: readonly string[] }[] = [
  { title: 'Session', ids: ['running-timer', 'session-timer', 'context-usage'] },
  { title: 'Status', ids: ['gateway-health', 'workspace-cwd', 'agents', 'cron', 'approval-mode'] },
  { title: 'Updates', ids: ['version-client', 'version-backend'] },
  { title: 'System', ids: ['terminal', 'command-center'] }
]

// Re-shape a bar descriptor for the nav-styled row list:
//   • icon-only items (command-center, terminal) have no label + a square layout
//     class → label from the tooltip title, drop the square class;
//   • swap the bar's active highlight for the nav-rail active style so an active
//     row matches the left sidebar's selected button.
function toRow(item: StatusbarItem): StatusbarItem {
  let className = item.className
  let label = item.label

  if (!label && item.title) {
    className = className?.replace(ICON_ONLY_BAR_CLASS, '').trim() || undefined
    label = item.title
  }

  className = className?.replace(BAR_ACTIVE_CLASS, NAV_ROW_ACTIVE).trim() || undefined

  return { ...item, className, label }
}

// The mobile Status tab: the full status-bar inventory (see useStatusbarItems,
// `rich`) as vertical nav-styled rows, grouped into Session / Status / System
// sections with sidebar-style headers.
export function MobileStatusList() {
  const navigate = useNavigate()
  const { leftStatusbarItems, statusbarItems } = useStatusbarItems({ includeAll: true, rich: true })

  const byId = new Map<string, StatusbarItem>()

  for (const item of [...leftStatusbarItems, ...statusbarItems]) {
    if (!item.hidden) {
      byId.set(item.id, item)
    }
  }

  const sections = SECTIONS.map(section => ({
    title: section.title,
    items: section.ids.map(id => byId.get(id)).filter((item): item is StatusbarItem => Boolean(item))
  })).filter(section => section.items.length > 0)

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
            {section.items.map(item => {
              const rowItem = toRow(item)
              const finalItem = LIGHT_LABEL_SECTIONS.has(section.title)
                ? { ...rowItem, className: cn(rowItem.className, 'font-normal') }
                : rowItem

              return <StatusbarItemView item={finalItem} key={item.id} navigate={navigate} row />
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
