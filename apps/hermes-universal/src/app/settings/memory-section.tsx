import type { HermesConfigRecord } from '@/types/hermes'

import { ConfigSection } from './config-section'
import { getNested } from './helpers'
import { MemoryConnect } from './memory/connect'
import { ProviderConfigPanel } from './memory/provider-config-panel'

// Memory & Context config section: the generic schema fields plus, on the
// `memory.provider` row, an inline OAuth Connect affordance (in the description)
// and a collapsible per-provider config panel (below the row). Mirrors desktop's
// ConfigSettings memory wiring; both extras self-hide for providers the backend
// doesn't support (the status/config routes 404).
export function MemorySection() {
  const providerOf = (key: string, config: HermesConfigRecord): string | null =>
    key === 'memory.provider' && getNested(config, key) ? String(getNested(config, key)) : null

  return (
    <ConfigSection
      renderDescriptionExtra={(key, config) => {
        const provider = providerOf(key, config)

        return provider ? <MemoryConnect provider={provider} /> : undefined
      }}
      renderExtra={(key, config) => {
        const provider = providerOf(key, config)

        return provider ? <ProviderConfigPanel provider={provider} /> : null
      }}
      sectionId="memory"
    />
  )
}
