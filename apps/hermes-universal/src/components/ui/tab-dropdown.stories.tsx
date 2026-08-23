import type { Meta, StoryObj } from '@storybook/react-vite'

import { Activity, BarChart3, MessageCircle, Settings, Wrench } from '@/lib/icons'

import { withMobile } from '../../../.storybook/decorators'

import { TabDropdown } from './tab-dropdown'

/**
 * The one responsive nav collapse in the app — Settings' sections and the
 * Command Center's both funnel through it, so this is where they become a
 * drawer on touch rather than each learning about phones separately.
 *
 * The item list is the same one the dropdown gets. `OverlayNav` already
 * flattens a group's children into it with `indent`, which is why sub-sections
 * are listed here rather than hidden behind a second tap.
 */
const ITEMS = [
  { active: false, icon: MessageCircle, id: 'sessions', label: 'Sessions', meta: 23, onSelect: () => {} },
  { active: true, icon: Activity, id: 'system', label: 'System', onSelect: () => {} },
  { active: false, icon: BarChart3, id: 'usage', label: 'Usage', onSelect: () => {} },
  { active: false, icon: Wrench, id: 'maintenance', label: 'Maintenance', onSelect: () => {}, separatorBefore: true },
  { active: false, icon: Settings, id: 'diagnostics', indent: true, label: 'Diagnostics', onSelect: () => {} },
  { active: false, icon: Settings, id: 'backups', indent: true, label: 'Backups', onSelect: () => {} }
]

const meta = {
  args: { items: ITEMS },
  component: TabDropdown,
  decorators: [withMobile],
  parameters: { layout: 'fullscreen', viewport: { defaultViewport: 'mobile1' } },
  title: 'Nav/Tab Dropdown'
} satisfies Meta<typeof TabDropdown>

export default meta

/** Tap the trigger: the nav slides down from the top, full-width rows, with the
 *  indented sub-sections listed inline. */
export const Mobile: StoryObj<typeof meta> = {}
