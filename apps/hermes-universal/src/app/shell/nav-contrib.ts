/**
 * The app's OWN navigation, registered as contributions.
 *
 * MJX-52: routes, nav and palette entries are contributions — core included, so
 * a plugin row and a built-in row are the same kind of thing and every surface
 * has exactly one list to render.
 *
 *  - `palette` (the command menu): every primary destination, ordered ahead of
 *    plugin commands by a negative `order`. `action` carries the destination's
 *    keybind id so the row shows the live combo.
 *  - `sidebar.nav` (the rail): the four rows the rail has always shown. New
 *    session is an ACTION row (`run`), the rest navigate.
 *
 * Labels stay `labelKey`s, not strings: a contribution registered at module load
 * would otherwise freeze the label at boot locale, and the language picker would
 * leave the menu and rail behind.
 *
 * Imported for its side effect by `app/contrib/controller.tsx`, alongside the
 * pane/layout registrations.
 */

import { PALETTE_AREA } from '@/app/command-palette/contrib'
import {
  ARTIFACTS_ROUTE,
  MESSAGING_ROUTE,
  SIDEBAR_NAV_AREA,
  type SidebarNavContribution,
  SKILLS_ROUTE
} from '@/app/routes'
import { registry } from '@/contrib/registry'
import { startNewSession } from '@/store/new-session'
import { openAppRoute } from '@/store/windows'

import { NAV_ACTION_BY_VIEW, NAV_ITEMS } from './nav-items'

// Core rows sort ahead of contributed ones: a plugin command registers with no
// `order` (0), so the app's destinations claim the negative range.
registry.registerMany(
  NAV_ITEMS.map((item, index) => ({
    area: PALETTE_AREA,
    data: {
      action: NAV_ACTION_BY_VIEW[item.view],
      icon: item.icon,
      id: `nav.${item.view}`,
      keywords: item.keywords,
      labelKey: `nav.${item.labelKey}`,
      // Promote Settings / Command Center to their native activity on Android;
      // everything else navigates in-app (openAppRoute decides).
      run: () => openAppRoute(item.path)
    },
    id: `nav.${item.view}`,
    order: -1000 + index * 10
  }))
)

const RAIL_ROWS: Array<SidebarNavContribution & { id: string }> = [
  // No `view`: New session is an action, not a destination — it never lights up
  // (a chat route belongs to the session, not to this row).
  { codicon: 'robot', id: 'new-session', labelKey: 'new-session', run: startNewSession },
  { codicon: 'symbol-misc', id: 'skills', labelKey: 'skills', path: SKILLS_ROUTE, view: 'skills' },
  { codicon: 'comment', id: 'messaging', labelKey: 'messaging', path: MESSAGING_ROUTE, view: 'messaging' },
  { codicon: 'files', id: 'artifacts', labelKey: 'artifacts', path: ARTIFACTS_ROUTE, view: 'artifacts' }
]

registry.registerMany(
  RAIL_ROWS.map((row, index) => ({
    area: SIDEBAR_NAV_AREA,
    data: row,
    id: row.id,
    order: -1000 + index * 10
  }))
)
