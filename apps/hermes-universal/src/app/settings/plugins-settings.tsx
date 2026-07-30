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
import { Package } from '@/lib/icons'
import { useStore } from '@/store/atom'
import { notifyError } from '@/store/notifications'

import { EmptyState, ListRow, Pill, SectionHeading, SettingsContent } from './primitives'

// Ported from apps/desktop/src/app/settings/plugins-settings.tsx. Universal adds
// the dual-door surface: the active door and its root are always named, and the
// gateway door has an explicit switch — otherwise "where did this plugin come
// from" would be invisible magic.

const KIND_ORDER: Record<PluginRecord['kind'], number> = { disk: 0, runtime: 1, bundled: 2 }

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

      {rows.length === 0 ? (
        <EmptyState title={p.empty} />
      ) : (
        <div className="divide-y divide-(--ui-stroke-tertiary)">
          {rows.map(record => (
            <PluginRow key={record.id} record={record} reveal={disk?.reveal} />
          ))}
        </div>
      )}
    </SettingsContent>
  )
}
