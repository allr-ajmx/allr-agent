import { useEffect, useState } from 'react'

import { ListRow } from '@/app/settings/primitives'
import { Button } from '@/components/ui/button'
import { LogView } from '@/components/ui/log-view'
import { getLogs, getStatus } from '@/hermes'
import { useI18n } from '@/i18n'
import { AlertCircle, Loader2, RefreshCw } from '@/lib/icons'
import { LOG_NOISE_RE, trimLogLine } from '@/lib/log-format'
import { openSystemScreen } from '@/store/windows'
import type { StatusResponse } from '@/types/hermes'

// Settings → Gateway diagnostics. Desktop reveals a local desktop.log in the file
// manager; universal has no local logfile, so this is the faithful analogue built
// on the gateway's own APIs: a status readout (getStatus) + a recent-logs tail
// (getLogs, the same source the statusbar gateway-menu tails), with a link to the
// full System panel. Rendered only in the settings variant while connected.

const LOG_LINES = 120
const LOG_VISIBLE = 40

/**
 * The oldest config schema the backend still auto-migrates
 * (`hermes_cli/config_migrations.py` `SUPPORT_FLOOR_VERSION`). Below it the
 * v4/v5/v9 migration steps are gone: the config loads byte-for-byte untouched
 * and the only warning goes to the backend's stderr, which nobody running the
 * GUI will ever read. Things then quietly do not work, with no explanation.
 *
 * Only a FALLBACK for a gateway that predates `status.config_floor_warning` —
 * a current gateway reports its own floor, so this literal never decides.
 */
const CONFIG_SUPPORT_FLOOR_FALLBACK = 12

/**
 * The floor verdict, preferring the gateway's own.
 *
 * The gateway can tell an ancient config from a fresh minimal one, because it
 * reads the raw file: a MISSING `_config_version` key coerces to 0 and is
 * deliberately exempt (a cloned or hand-written config is not an ancient
 * install). Over HTTP the two are indistinguishable — both arrive as
 * `config_version: 0` — so the legacy fallback treats 0 as "no explicit
 * version" and never warns. A false alarm on every hand-written config would be
 * worse than missing a literal `_config_version: 0`, which nobody writes.
 *
 * The fallback mirrors the backend's `below_support_floor()` in full — BOTH
 * clauses, `current < floor` AND `current < latest`. Dropping the second one
 * warned about a config a gateway considers current: the only gateways that
 * reach this branch are ones predating the field, and one whose own
 * `latest_config_version` is itself below 12 has nothing to migrate to.
 */
export function configFloorVerdict(status: StatusResponse): { below: boolean; floor: number } {
  const reported = status.config_floor_warning

  if (reported) {
    return { below: reported.below_floor, floor: reported.support_floor_version }
  }

  return {
    below:
      status.config_version > 0 &&
      status.config_version < CONFIG_SUPPORT_FLOOR_FALLBACK &&
      status.config_version < status.latest_config_version,
    floor: CONFIG_SUPPORT_FLOOR_FALLBACK
  }
}

export function GatewayDiagnostics() {
  const { t } = useI18n()
  const g = t.settings.gateway
  const cc = t.commandCenter

  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [logs, setLogs] = useState<string[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = async () => {
    setLoading(true)

    try {
      const [nextStatus, nextLogs] = await Promise.all([
        getStatus(),
        getLogs({ file: 'gui', lines: LOG_LINES }).catch(() => ({ lines: [] as string[] }))
      ])

      setStatus(nextStatus)
      setLogs(
        nextLogs.lines
          .map(line => line.trim())
          .filter(line => line && !LOG_NOISE_RE.test(line))
          .slice(-LOG_VISIBLE)
          .map(trimLogLine)
      )
    } catch {
      /* leave the last snapshot in place */
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => void refresh(), [])

  const floor = status ? configFloorVerdict(status) : null

  return (
    <div className="mt-6 grid gap-1 border-t border-(--ui-stroke-tertiary) pt-5">
      <ListRow
        action={
          <Button disabled={loading} onClick={() => void refresh()} size="sm" variant="text">
            {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            {g.cloudRefresh}
          </Button>
        }
        description={g.diagnosticsDesc}
        title={g.diagnostics}
      />

      {status ? (
        <div className="text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
          <div>
            {cc.hermesActiveSessions(status.version, status.active_sessions)}
            {status.gateway_state ? ` · ${status.gateway_state}` : ''}
          </div>
          {/* `hermes_home` is one of the absolute host paths /api/status only
              surfaces on a loopback / --insecure bind — a gated (OAuth, cloud
              portal) gateway withholds it. JSX renders the absent value as
              nothing, so this line came out as a headless " · config v34".
              Drop the separator with the segment. */}
          <div className="mt-1 font-mono text-[0.68rem] text-muted-foreground/60">
            {status.hermes_home ? `${status.hermes_home} · ` : ''}config v{status.config_version}
          </div>
          {floor?.below ? (
            <div className="mt-2 flex items-start gap-2 rounded-md bg-(--ui-warning-bg) px-3 py-2 text-xs text-(--ui-warning-text)">
              <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
              <span>{g.configFloorWarning(status.config_version, floor.floor)}</span>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="mt-3">
        <div className="mb-1.5 flex items-center justify-between">
          <div className="text-[length:var(--conversation-caption-font-size)] font-medium text-(--ui-text-secondary)">
            {cc.recentLogs}
          </div>
          <Button className="-me-2" onClick={() => void openSystemScreen()} size="xs" variant="text">
            {t.shell.gatewayMenu.viewAllLogs}
          </Button>
        </div>
        {logs.length === 0 ? (
          <p className="py-3 text-center text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
            {cc.noLogs}
          </p>
        ) : (
          <LogView className="max-h-56">{logs.join('\n')}</LogView>
        )}
      </div>
    </div>
  )
}
