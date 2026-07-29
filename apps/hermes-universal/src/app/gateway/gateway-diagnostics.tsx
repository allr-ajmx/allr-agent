import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { COMMAND_CENTER_ROUTE } from '@/app/routes'
import { ListRow } from '@/app/settings/primitives'
import { Button } from '@/components/ui/button'
import { LogView } from '@/components/ui/log-view'
import { getLogs, getStatus } from '@/hermes'
import { useI18n } from '@/i18n'
import { Loader2, RefreshCw } from '@/lib/icons'
import { LOG_NOISE_RE, trimLogLine } from '@/lib/log-format'
import type { StatusResponse } from '@/types/hermes'

// Settings → Gateway diagnostics. Desktop reveals a local desktop.log in the file
// manager; universal has no local logfile, so this is the faithful analogue built
// on the gateway's own APIs: a status readout (getStatus) + a recent-logs tail
// (getLogs, the same source the statusbar gateway-menu tails), with a link to the
// full System panel. Rendered only in the settings variant while connected.

const LOG_LINES = 120
const LOG_VISIBLE = 40

export function GatewayDiagnostics() {
  const { t } = useI18n()
  const g = t.settings.gateway
  const cc = t.commandCenter
  const navigate = useNavigate()

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
          <div className="mt-1 font-mono text-[0.68rem] text-muted-foreground/60">
            {status.hermes_home} · config v{status.config_version}
          </div>
        </div>
      ) : null}

      <div className="mt-3">
        <div className="mb-1.5 flex items-center justify-between">
          <div className="text-[length:var(--conversation-caption-font-size)] font-medium text-(--ui-text-secondary)">
            {cc.recentLogs}
          </div>
          <Button className="-mr-2" onClick={() => navigate(COMMAND_CENTER_ROUTE)} size="xs" variant="text">
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
