import type { ComponentType } from 'react'

import { useI18n } from '@/i18n'
import { Archive, Bell, Globe, Info, Key, Keyboard, Paw, Settings, Wrench, Zap } from '@/lib/icons'

import { SECTIONS } from './constants'

// The drill-in list model: the schema-driven config sections (from SECTIONS,
// includes appearance) followed by the custom, non-schema tabs. Each id maps to
// a `/settings/:id` detail route. Deferred tabs (gateway/providers/pet) are not
// listed until their gating tracks land.
export interface SettingsNavEntry {
  id: string
  label: string
  icon: ComponentType<{ className?: string }>
}

export function useSettingsNav(): SettingsNavEntry[] {
  const { t } = useI18n()
  const sectionLabels = t.settings.sections as Record<string, string>

  const configEntries: SettingsNavEntry[] = SECTIONS.map(section => ({
    id: section.id,
    icon: section.icon,
    label: sectionLabels[section.id] ?? section.label
  }))

  const customEntries: SettingsNavEntry[] = [
    { id: 'gateway', icon: Globe, label: t.settings.nav.gateway },
    { id: 'notifications', icon: Bell, label: t.settings.nav.notifications },
    { id: 'keys', icon: Key, label: t.settings.nav.apiKeys },
    { id: 'shortcuts', icon: Keyboard, label: t.keybinds.title },
    { id: 'pet', icon: Paw, label: t.commandCenter.pets.title },
    { id: 'archived', icon: Archive, label: t.settings.nav.archivedChats },
    { id: 'about', icon: Info, label: t.settings.nav.about }
  ]

  return [...configEntries, ...customEntries]
}

export interface SettingsNavChild {
  id: string
  label: string
  icon: ComponentType<{ className?: string }>
}

export interface SettingsNavGroupModel {
  id: string
  label: string
  icon: ComponentType<{ className?: string }>
  gapBefore?: boolean
  /** Sub-tabs shown indented under the group when it's active (e.g. Providers →
   *  Accounts / API keys). Each child id is a `/settings/:child.id` route. */
  children?: SettingsNavChild[]
}

// Desktop-parity nav groups for the settings overlay side menu: the 8 schema
// config sections, then notifications / providers / gateway / keys / sessions /
// about — matching apps/desktop's order + gapBefore breaks. `providers` is a
// placeholder until its page lands; `sessions` renders the archived list for now.
export function useSettingsNavGroups(): SettingsNavGroupModel[] {
  const { t } = useI18n()
  const sectionLabels = t.settings.sections as Record<string, string>

  const configGroups: SettingsNavGroupModel[] = SECTIONS.map(section => ({
    id: section.id,
    icon: section.icon,
    label: sectionLabels[section.id] ?? section.label
  }))

  const extra: SettingsNavGroupModel[] = [
    { id: 'notifications', icon: Bell, label: t.settings.nav.notifications },
    {
      id: 'providers',
      icon: Zap,
      label: t.settings.nav.providers,
      gapBefore: true,
      children: [
        { id: 'providers', icon: Key, label: t.settings.nav.providerAccounts },
        { id: 'providers/keys', icon: Key, label: t.settings.nav.providerApiKeys },
        { id: 'providers/custom-endpoints', icon: Globe, label: t.settings.nav.providerCustomEndpoints }
      ]
    },
    { id: 'gateway', icon: Globe, label: t.settings.nav.gateway },
    {
      id: 'keys',
      icon: Key,
      label: t.settings.nav.apiKeys,
      children: [
        { id: 'keys', icon: Wrench, label: t.settings.nav.keysTools },
        { id: 'keys/settings', icon: Settings, label: t.settings.nav.keysSettings }
      ]
    },
    { id: 'sessions', icon: Archive, label: t.settings.nav.archivedChats },
    { id: 'about', icon: Info, label: t.settings.nav.about, gapBefore: true }
  ]

  return [...configGroups, ...extra]
}
