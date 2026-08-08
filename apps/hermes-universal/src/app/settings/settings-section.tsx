import { Link, useParams } from 'react-router-dom'

import { PetSection } from '@/app/pet/pet-section'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useI18n } from '@/i18n'
import { ChevronLeft } from '@/lib/icons'
import { useStore } from '@/store/atom'
import { $terminalHostPreference, setTerminalHostPreference } from '@/store/terminals'
import type { TerminalHostPreference } from '@/transport/terminal-transport'

import { AboutSection } from './about-section'
import { AppearanceSection } from './appearance-section'
import { ArchivedSection } from './archived-section'
import { BillingSettings } from './billing'
import { ConfigSection } from './config-section'
import { GatewaySection } from './gateway-section'
import { KeybindSettings } from './keybind-settings'
import { KeysSection } from './keys-section'
import { MemorySection } from './memory-section'
import { ModelSection } from './model-section'
import { NotificationsSection } from './notifications-section'
import { PluginsSettings } from './plugins-settings'
import { EmptyState, ListRow, SettingsContent } from './primitives'
import { ProvidersSection } from './providers-section'
import { useSettingsNav } from './settings-nav'
import { VoiceSection } from './voice-section'

// "Shell runs on" override for `resolveTerminalTransportKind` (transport/terminal-
// transport.ts) — a device-local preference, not a schema config field, so it's a
// headerSlot above the Workspace page's schema fields rather than a `SECTIONS` key.
function TerminalHostRow() {
  const { t } = useI18n()
  const copy = t.settings.workspace
  const preference = useStore($terminalHostPreference)

  const options = [
    { id: 'auto', label: copy.terminalHostAuto },
    { id: 'device', label: copy.terminalHostDevice },
    { id: 'gateway', label: copy.terminalHostGateway }
  ] as const satisfies readonly { id: TerminalHostPreference; label: string }[]

  return (
    <ListRow
      action={
        <Select onValueChange={value => setTerminalHostPreference(value as TerminalHostPreference)} value={preference}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map(option => (
              <SelectItem key={option.id} value={option.id}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
      description={copy.terminalHostDesc}
      title={copy.terminalHostTitle}
    />
  )
}

// The per-section body. Each Track-J chunk replaces its placeholder case with a
// real renderer (Jc8 appearance, Jc9 notifications, Jc10 keys, …). Exported so
// the desktop-style SettingsView overlay renders the active section here too.
export function SectionBody({ section }: { section: string }) {
  const { t } = useI18n()

  // `section` may carry a sub-tab (`providers/keys`); split so the switch keys off
  // the top-level group and sub-views read the second segment.
  const [group, sub] = section.split('/')

  switch (group) {
    // Schema-driven config sections (Jc4).
    case 'chat':

    case 'safety':

    case 'advanced':
      return <ConfigSection sectionId={group} />

    // Workspace: schema fields plus the "Shell runs on" device-local override,
    // which isn't a schema key (nothing to send to the gateway).
    case 'workspace':
      return <ConfigSection headerSlot={<TerminalHostRow />} sectionId={group} />

    // Providers: Accounts (OAuth sign-in) + API keys + custom-endpoints sub-tabs.
    case 'providers':
      return (
        <ProvidersSection
          view={sub === 'keys' ? 'keys' : sub === 'custom-endpoints' ? 'custom-endpoints' : 'accounts'}
        />
      )

    // Voice (Jc5): schema fields filtered to the active TTS/STT provider, plus a
    // live ElevenLabs voice dropdown (tts.elevenlabs.voice_id).
    case 'voice':
      return <VoiceSection />

    // Memory (Jc6): schema fields plus the memory-provider OAuth connect
    // affordance + per-provider config panel on the memory.provider row.
    case 'memory':
      return <MemorySection />

    // Model (Jc7): default-model picker, the model schema fields, MoA and
    // auxiliary. FIXME(MJX-105): local-endpoint onboarding is still missing —
    // desktop's `startManualLocalEndpoint` has no universal counterpart.
    case 'model':
      return <ModelSection />

    // Appearance (Jc8): theme mode + skin + language.
    case 'appearance':
      return <AppearanceSection />

    // Notifications (Jc9): native-notification prefs + haptics.
    case 'notifications':
      return <NotificationsSection />

    // Tools & Keys (Jc10): env-var credentials, split into Tools + Settings
    // sub-tabs surfaced as nav children (desktop parity). Provider OAuth is D2.
    case 'keys':
      return <KeysSection view={sub === 'settings' ? 'settings' : 'tools'} />

    // Billing (MJX-56): balance / plan / usage overview, the in-app plans
    // catalog (`?bview=plans`), top-up, auto-refill and the downgrade → undo
    // flow. Ported from apps/desktop/src/app/settings/billing.
    case 'billing':
      return <BillingSettings />

    // Gateway (J10): mode picker + current connection + disconnect/sign-out.
    case 'gateway':
      return <GatewaySection />

    // Keyboard shortcuts — the full rebindable panel, ported from desktop.
    case 'shortcuts':
      return <KeybindSettings />

    // Pet gallery.
    case 'pet':
      return <PetSection />

    // Plugins (MJX-53): the runtime plugin inventory + the disk-door switch.
    case 'plugins':
      return <PluginsSettings />

    // Archived chats (Jc11). `sessions` is the desktop nav id; until the full
    // Sessions page lands it renders the archived list (its current subset).
    case 'archived':

    case 'sessions':
      return <ArchivedSection />

    // About (Jc12): version + release notes. self-update/uninstall omitted.
    case 'about':
      return <AboutSection />

    default:
      // Unknown / deep-linked-only ids land here. Reachable today only for
      // desktop's `keybinds` nav id, which this switch spells `shortcuts` —
      // FIXME(MJX-105).
      return (
        <SettingsContent>
          <EmptyState description={t.settings.config.emptyDesc} title={t.settings.config.emptyTitle} />
        </SettingsContent>
      )
  }
}

export function SettingsSection() {
  const { section = '' } = useParams()
  const nav = useSettingsNav()
  const entry = nav.find(e => e.id === section)
  const title = entry?.label ?? section

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-1 border-b border-border p-3">
        <Link
          aria-label="Back"
          className="-ml-1 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          to="/settings"
        >
          <ChevronLeft className="size-5" />
        </Link>
        <h1 className="text-base font-semibold text-foreground">{title}</h1>
      </header>
      <SectionBody section={section} />
    </div>
  )
}
