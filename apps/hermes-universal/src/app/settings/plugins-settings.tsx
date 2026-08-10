import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Switch } from '@/components/ui/switch'
import { Tip } from '@/components/ui/tooltip'
import { $restDoorEnabled, type PluginDisk, resolvePluginDisk } from '@/contrib/plugin-disk'
import { $pluginRecords, type PluginRecord, setPluginEnabled } from '@/contrib/plugins-store'
import { discoverRuntimePlugins } from '@/contrib/runtime-loader'
import { useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import { Package, Plug } from '@/lib/icons'
import { revealPathInFileManager } from '@/lib/reveal-path'
import { normalize } from '@/lib/text'
import {
  $agentPluginBusy,
  $agentPlugins,
  $agentPluginsError,
  $agentPluginsStatus,
  type AgentPluginRow,
  type GatewayRequest,
  loadAgentPlugins,
  toggleAgentPlugin
} from '@/store/agent-plugins'
import { useStore } from '@/store/atom'
import { $connection } from '@/store/connection'
import { $gatewayState, requestGateway } from '@/store/gateway'
import { modeIsRemoteLike } from '@/store/gateway-config'
import { notifyError } from '@/store/notifications'

import {
  EmptyState,
  ListRow,
  ListRowSkeleton,
  Pill,
  SectionHeading,
  SettingsContent,
  SettingsSection
} from './primitives'

// Ported from apps/desktop/src/app/settings/plugins-settings.tsx. Universal adds
// the dual-door surface: the active door and its root are always named, and the
// gateway door has an explicit switch — otherwise "where did this plugin come
// from" would be invisible magic.

const KIND_ORDER: Record<PluginRecord['kind'], number> = { disk: 0, runtime: 1, bundled: 2 }

// User-installed plugins first, bundled last — mirrors `hermes plugins list`.
const SOURCE_ORDER: Record<string, number> = { bundled: 3, entrypoint: 2, git: 0, project: 1, user: 0 }

// Plugin categories (by registry key prefix) that other surfaces own.
// dashboard_auth/* only matters to `hermes dashboard`; model-providers/* are
// configured in Settings ▸ Models; platforms/* are managed from Messaging. The
// plugin switch is not the user-facing control for any of them, so listing them
// here is noise.
const HIDDEN_KEY_PREFIXES = ['dashboard_auth/', 'model-providers/', 'platforms/']

const isClientRelevant = (row: AgentPluginRow) => !HIDDEN_KEY_PREFIXES.some(prefix => row.key.startsWith(prefix))

// Agent plugins live under the BACKEND's hermes home (profile-aware), so the
// path comes from the gateway — not from this device's HERMES_HOME. The caller
// gates on a local connection: revealing a path that belongs to a remote box
// would point this device's file manager at a directory that isn't there.
async function revealAgentPluginsDir(request: GatewayRequest, failTitle: string) {
  try {
    const result = await request<{ home?: string }>('config.get', { key: 'profile' })
    const home = (result?.home ?? '').trim()

    if (!home) {
      notifyError('The backend did not report its home directory', failTitle)

      return
    }

    await revealPathInFileManager(`${home}/plugins`)
  } catch (err) {
    notifyError(err, failTitle)
  }
}

/** One backend plugin: name + source pills, description, and its enable switch. */
function AgentPluginRowView({ row }: { row: AgentPluginRow }) {
  const { t } = useI18n()
  const p = t.settings.plugins
  const busy = useStore($agentPluginBusy)

  return (
    <ListRow
      action={
        <Switch
          aria-label={`${row.status === 'enabled' ? p.disable : p.enable} ${row.name}`}
          checked={row.status === 'enabled'}
          disabled={busy === row.key}
          onCheckedChange={on => {
            triggerHaptic('selection')
            void toggleAgentPlugin(requestGateway, row.key, on, p.agent.toggleFailed(row.name))
          }}
        />
      }
      description={row.description || (row.version ? `v${row.version}` : undefined)}
      title={
        <span className="flex items-center gap-2">
          {row.name}
          <Pill>{p.agent.sources[row.source] ?? row.source}</Pill>
          {row.portable && <Pill tone="primary">{p.agent.portable}</Pill>}
        </span>
      }
    />
  )
}

/**
 * The BACKEND half of the plugins page. The list above it is what runs in this
 * webview; this is what runs in the Hermes process on the other end of the
 * gateway — tools, skills, MCP servers, hooks, slash commands. Both belong on
 * one page because "my plugins" is one question to a user, however many
 * processes the answer spans.
 */
function AgentPluginsSection() {
  const { t } = useI18n()
  const p = t.settings.plugins
  const gatewayState = useStore($gatewayState)
  const connection = useStore($connection)
  const rows = useStore($agentPlugins)
  const status = useStore($agentPluginsStatus)
  const error = useStore($agentPluginsError)
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (gatewayState !== 'open') {
      return
    }

    void loadAgentPlugins(requestGateway)
  }, [gatewayState])

  const needle = normalize(query)

  const sorted = rows
    .filter(isClientRelevant)
    .filter(
      row =>
        !needle ||
        normalize(row.name).includes(needle) ||
        normalize(row.key).includes(needle) ||
        normalize(row.description).includes(needle)
    )
    .sort((a, b) => (SOURCE_ORDER[a.source] ?? 9) - (SOURCE_ORDER[b.source] ?? 9) || a.name.localeCompare(b.name))

  return (
    <SettingsSection icon={Plug} meta={status === 'ready' ? p.count(sorted.length) : undefined} title={p.agent.title}>
      <p className="mb-4 text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
        {p.agent.blurb}
      </p>

      {!modeIsRemoteLike(connection?.mode) && (
        <div className="mb-4 flex items-center gap-2">
          <Button onClick={() => void revealAgentPluginsDir(requestGateway, p.openFolder)} size="sm" variant="outline">
            <Codicon name="folder-opened" size="0.8rem" />
            {p.openFolder}
          </Button>
        </div>
      )}

      <input
        className="mb-2 w-full rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-bg-quinary) px-3 py-1.5 text-[length:var(--conversation-caption-font-size)] outline-none placeholder:text-(--ui-text-tertiary) focus:border-(--ui-stroke-secondary)"
        onChange={event => setQuery(event.target.value)}
        placeholder={p.agent.search}
        spellCheck={false}
        value={query}
      />

      {status === 'idle' || status === 'loading' ? (
        <div>
          <ListRowSkeleton />
          <ListRowSkeleton />
          <ListRowSkeleton />
        </div>
      ) : status === 'error' ? (
        <EmptyState description={error ?? undefined} title={p.agent.loadFailed} />
      ) : sorted.length === 0 ? (
        needle ? (
          <p className="text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
            {p.agent.noMatches}
          </p>
        ) : (
          <EmptyState title={p.agent.empty} />
        )
      ) : (
        <div className="divide-y divide-(--ui-stroke-tertiary)">
          {sorted.map(row => (
            <AgentPluginRowView key={row.key || row.name} row={row} />
          ))}
        </div>
      )}
    </SettingsSection>
  )
}

/** The live door + its resolved root, re-resolved when the gateway-door switch
 *  flips. `root` is null while unavailable (e.g. a backend that reports no
 *  hermes_home) so the page can say so instead of showing an empty list. */
function useActiveDoor(): { disk: null | PluginDisk; root: null | string; loading: boolean } {
  const restEnabled = useStore($restDoorEnabled)

  const [state, setState] = useState<{ disk: null | PluginDisk; root: null | string; loading: boolean }>({
    disk: null,
    loading: true,
    root: null
  })

  useEffect(() => {
    let live = true

    setState(prev => ({ ...prev, loading: true }))

    void (async () => {
      const disk = await resolvePluginDisk().catch(() => null)
      const root = disk ? await disk.root().catch(() => null) : null

      if (live) {
        setState({ disk, loading: false, root })
      }
    })()

    return () => {
      live = false
    }
  }, [restEnabled])

  return state
}

function PluginRow({ record, reveal }: { record: PluginRecord; reveal?: (path: string) => Promise<void> }) {
  const { t } = useI18n()
  const p = t.settings.plugins

  return (
    <ListRow
      action={
        <div className="flex items-center justify-end gap-2">
          {/* Only when the file is on THIS machine — a gateway path means nothing
              to this device's file manager. */}
          {record.file && reveal && (
            <Tip label={p.reveal}>
              <Button onClick={() => void reveal(record.file!).catch(() => undefined)} size="icon" variant="ghost">
                <Codicon name="folder-opened" size="0.85rem" />
              </Button>
            </Tip>
          )}
          <Switch
            aria-label={`${record.status === 'disabled' ? p.enable : p.disable} ${record.name}`}
            checked={record.status !== 'disabled'}
            onCheckedChange={on => {
              triggerHaptic('selection')
              void setPluginEnabled(record.id, on)
            }}
          />
        </div>
      }
      description={
        record.status === 'error' ? (
          <span className="text-(--ui-danger,#f87171)">{record.error}</span>
        ) : record.description ? (
          // What the plugin DOES, when its manifest says — the id/path below it
          // answers "which one is this", which is a different question.
          <span className="flex flex-col">
            <span>{record.description}</span>
            <span className="opacity-70">{record.file ?? record.id}</span>
          </span>
        ) : (
          (record.file ?? record.id)
        )
      }
      title={
        <span className="flex items-center gap-2">
          {record.name}
          <Pill>{p.kinds[record.kind]}</Pill>
          {record.status === 'error' && <Pill tone="primary">{p.failed}</Pill>}
        </span>
      }
    />
  )
}

export function PluginsSettings() {
  const { t } = useI18n()
  const p = t.settings.plugins
  const records = useStore($pluginRecords)
  const restEnabled = useStore($restDoorEnabled)
  const { disk, loading, root } = useActiveDoor()

  const rows = Object.values(records).sort(
    (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name)
  )

  const sourceLabel = disk ? (disk.kind === 'local' ? p.sourceLocal : p.sourceGateway) : p.sourceNone

  const openFolder = async () => {
    if (!disk?.reveal || !root) {
      notifyError(p.sourceNone, p.openFolder)

      return
    }

    // The Rust `plugins_root` creates the directory on demand, so this always has
    // somewhere to go — no need for desktop's openDir-vs-reveal dance.
    await disk.reveal(root).catch(err => notifyError(err, p.openFolder))
  }

  return (
    <SettingsContent>
      <SectionHeading icon={Package} meta={p.count(rows.length)} title={p.title} />
      <p className="mb-4 text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">{p.blurb}</p>

      <div className="mb-4 flex items-center gap-2">
        {/* Reveal only makes sense for the local door. */}
        {disk?.reveal && (
          <Button onClick={() => void openFolder()} size="sm" variant="outline">
            <Codicon name="folder-opened" size="0.8rem" />
            {p.openFolder}
          </Button>
        )}
        <Button
          onClick={() => {
            triggerHaptic('selection')
            discoverRuntimePlugins()
          }}
          size="sm"
          variant="outline"
        >
          <Codicon name="refresh" size="0.8rem" />
          {p.rescan}
        </Button>
      </div>

      {/* Which filesystem is in force, and where. Without this the dual door is
          invisible: two machines' plugin folders look identical in the list. */}
      {!loading && (
        <p className="mb-4 text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
          {sourceLabel}
          {root && <span className="ml-1 font-mono opacity-70">{root}</span>}
        </p>
      )}

      <div className="mb-4">
        <ListRow
          action={
            <Switch
              aria-label={p.gatewayDoor}
              checked={restEnabled}
              onCheckedChange={on => {
                triggerHaptic('selection')
                $restDoorEnabled.set(on)
              }}
            />
          }
          description={restEnabled && !loading && !disk ? p.gatewayDoorUnavailable : p.gatewayDoorHint}
          title={p.gatewayDoor}
        />
      </div>

      {/* Until the active door reports in, `rows` is legitimately empty — show
          the list's shape rather than flashing "no plugins" at someone who has
          plenty. */}
      {loading ? (
        <div>
          <ListRowSkeleton />
          <ListRowSkeleton />
          <ListRowSkeleton />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState title={p.empty} />
      ) : (
        <div className="divide-y divide-(--ui-stroke-tertiary)">
          {rows.map(record => (
            <PluginRow key={record.id} record={record} reveal={disk?.reveal} />
          ))}
        </div>
      )}

      <div className="mt-8">
        <AgentPluginsSection />
      </div>
    </SettingsContent>
  )
}
