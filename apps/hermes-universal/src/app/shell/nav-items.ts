import type { ComponentType } from 'react'

import {
  AGENTS_ROUTE,
  type AppView,
  ARTIFACTS_ROUTE,
  COMMAND_CENTER_ROUTE,
  CRON_ROUTE,
  MESSAGING_ROUTE,
  NEW_CHAT_ROUTE,
  PROFILES_ROUTE,
  SETTINGS_ROUTE,
  SKILLS_ROUTE,
  STARMAP_ROUTE
} from '@/app/routes'
import type { Translations } from '@/i18n'
import { Box, Clock, Cpu, LayoutGrid, MessageCircle, Send, Settings, Sparkles, Stars, Users } from '@/lib/icons'

export interface NavItem {
  view: AppView
  path: string
  // Key into the `nav` i18n namespace; `label` is the English fallback.
  labelKey: keyof Translations['nav']
  label: string
  icon: ComponentType<{ className?: string }>
}

// The app's primary destinations. This is the SOURCE the command menu's rows are
// registered from (app/shell/nav-contrib.ts registers one `palette` contribution
// per entry); nothing renders this list directly. `label` holds the English
// string as a fallback + test surface — live labels resolve from `labelKey`
// against the active locale at render time.
export const NAV_ITEMS: NavItem[] = [
  { view: 'chat', path: NEW_CHAT_ROUTE, labelKey: 'chat', label: 'Chat', icon: MessageCircle },
  { view: 'agents', path: AGENTS_ROUTE, labelKey: 'agents', label: 'Agents', icon: Cpu },
  { view: 'skills', path: SKILLS_ROUTE, labelKey: 'skills', label: 'Skills', icon: Sparkles },
  { view: 'cron', path: CRON_ROUTE, labelKey: 'routines', label: 'Routines', icon: Clock },
  { view: 'messaging', path: MESSAGING_ROUTE, labelKey: 'messaging', label: 'Messaging', icon: Send },
  { view: 'artifacts', path: ARTIFACTS_ROUTE, labelKey: 'artifacts', label: 'Artifacts', icon: Box },
  { view: 'starmap', path: STARMAP_ROUTE, labelKey: 'starmap', label: 'Starmap', icon: Stars },
  {
    view: 'command-center',
    path: COMMAND_CENTER_ROUTE,
    labelKey: 'commandCenter',
    label: 'Command Center',
    icon: LayoutGrid
  },
  { view: 'profiles', path: PROFILES_ROUTE, labelKey: 'profiles', label: 'Profiles', icon: Users },
  { view: 'settings', path: SETTINGS_ROUTE, labelKey: 'settings', label: 'Settings', icon: Settings }
]
