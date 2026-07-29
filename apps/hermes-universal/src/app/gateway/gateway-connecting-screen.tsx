import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { Loader2 } from '@/lib/icons'
import { useStore } from '@/store/atom'
import { $connectionError } from '@/store/connection'
import { cancelRestore, loadGatewayTarget } from '@/store/gateway-restore'

// Full-screen "reconnecting to the last gateway" screen (D8). Shown by
// MobileController while the boot-time auto-connect dials, and while an in-session
// reconnect (dropped socket / settings "Save & reconnect") is re-homing — instead
// of bouncing to the connect picker. Mirrors desktop's gateway-connecting overlay.
// The escape hatch ("Use a different gateway") abandons the restore and drops to
// the connect picker.

/** Human label for the gateway being (re)connected to, for the status line. */
function targetLabel(): string {
  const target = loadGatewayTarget()

  if (!target) {
    return 'Hermes'
  }

  if (target.mode === 'local') {
    return 'the local backend'
  }

  if (target.mode === 'ssh') {
    // The saved host, not the baseUrl: an ssh connection's baseUrl is a loopback
    // port that means nothing to the user.
    return target.ssh?.host || 'the SSH host'
  }

  if (target.mode === 'cloud') {
    if (target.cloudAgentName) {
      return target.cloudAgentName
    }

    return hostOf(target.cloudBaseUrl) ?? 'Hermes Cloud'
  }

  return hostOf(target.url) ?? 'the remote gateway'
}

function hostOf(url?: string): null | string {
  if (!url) {
    return null
  }

  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `http://${url}`).host
  } catch {
    return url.replace(/^https?:\/\//i, '').replace(/\/.*$/, '') || null
  }
}

export function GatewayConnectingScreen() {
  const { t } = useI18n()
  const g = t.settings.gateway
  const error = useStore($connectionError)

  return (
    <main className="connect">
      <div className="connect-card items-center text-center">
        <div className="brand">Hermes</div>
        <h1 className="connect-title">{g.connectingTitle}</h1>

        <div className="mt-2 flex items-center gap-2 text-[length:var(--conversation-caption-font-size)] text-(--ui-text-secondary)">
          <Loader2 className="size-4 animate-spin" />
          {g.reconnectingTo(targetLabel())}
        </div>

        {error ? <div className="mt-1 text-[0.8125rem] text-destructive">{error}</div> : null}

        <Button className="mt-4" onClick={() => cancelRestore()} size="sm" type="button" variant="text">
          {g.useDifferentGateway}
        </Button>
      </div>
    </main>
  )
}
