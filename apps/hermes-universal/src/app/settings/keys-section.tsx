import { useEffect, useMemo, useState } from 'react'

import { useI18n } from '@/i18n'

import { CredentialKeyCard, credentialPlaceholder, credentialRowLabel } from './credential-key-ui'
import { useEnvCredentials } from './env-credentials'
import { SettingsContent, SettingsSkeleton } from './primitives'

// Settings → Tools & Keys. Ported to desktop parity (apps/desktop/src/app/settings/
// keys-settings.tsx): the Tools (tool API keys) and Settings (server / webhook /
// gateway env) split is surfaced as nav sub-entries (see settings-nav.ts), same as
// Providers → Accounts / API keys, so this renders one `view` at a time — a
// single-expand list of collapsible credential cards (status dot, description +
// "Get a key" docs link, set/replace/reveal/clear). Provider LLM keys live on the
// Providers page; messaging-platform creds (channel_managed) on the Messaging page.
// Reuses the shared credential UI (useEnvCredentials + CredentialKeyCard).

export type KeysView = 'settings' | 'tools'

// Backend env categories that surface under each sub-tab. Platform creds use the
// `messaging` category but are flagged channel_managed (Messaging page owns those);
// only gateway-wide messaging rows (e.g. GATEWAY_PROXY) appear here with `setting`.
const VIEW_CATEGORIES: Record<KeysView, readonly string[]> = {
  settings: ['setting', 'messaging'],
  tools: ['tool']
}

export function KeysSection({ view }: { view: KeysView }) {
  const { t } = useI18n()
  const { rowProps, vars } = useEnvCredentials()
  const [openKey, setOpenKey] = useState<null | string>(null)

  // Collapse any expanded card when the nav switches sub-tab (Tools ↔ Settings).
  useEffect(() => setOpenKey(null), [view])

  const entries = useMemo(() => {
    if (!vars) {
      return []
    }

    const cats = VIEW_CATEGORIES[view]

    return Object.entries(vars)
      .filter(([, info]) => !info.channel_managed && cats.includes(info.category))
      .sort(([a], [b]) => a.localeCompare(b))
  }, [vars, view])

  if (!vars) {
    return <SettingsSkeleton sections={[{ rows: 5 }]} />
  }

  return (
    <SettingsContent>
      {entries.length === 0 ? (
        <div className="mt-4 rounded-lg border border-dashed border-(--ui-stroke-tertiary) px-4 py-8 text-center text-[length:var(--conversation-caption-font-size)] text-muted-foreground">
          {t.settings.keys.empty}
        </div>
      ) : (
        <div className="mt-3 grid gap-2">
          {entries.map(([key, info]) => {
            const label = credentialRowLabel(key, info)

            return (
              <CredentialKeyCard
                expanded={openKey === key}
                info={info}
                key={key}
                label={label}
                onExpand={() => setOpenKey(key)}
                onToggle={() => setOpenKey(prev => (prev === key ? null : key))}
                placeholder={credentialPlaceholder(key, info, label)}
                rowProps={rowProps}
                varKey={key}
              />
            )
          })}
        </div>
      )}
    </SettingsContent>
  )
}
