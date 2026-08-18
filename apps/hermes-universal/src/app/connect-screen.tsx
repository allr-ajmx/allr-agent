import { GatewayConfigurator } from '@/app/gateway/gateway-configurator'
import { BRAND } from '@/brand'
import { Wordmark } from '@/components/brand/wordmark'
import { useStore } from '@/store/atom'
import { $connectionError } from '@/store/connection'

// First-run / disconnected connect screen. The mode grid + per-mode connect
// surfaces come from the shared GatewayConfigurator (the same component Settings →
// Gateway uses), so first-run and settings are visually identical — desktop reuses
// one component for both. Shown only on a genuine first run or a failed restore;
// an in-session reconnect uses GatewayConnectingScreen instead (see MobileController).
export function ConnectScreen() {
  const connectError = useStore($connectionError)

  return (
    <main className="connect">
      <div className="connect-card">
        <Wordmark />
        <h1 className="connect-title">Connect to {BRAND}</h1>
        {connectError && <div className="text-[0.8125rem] text-destructive">{connectError}</div>}
        <GatewayConfigurator variant="onboarding" />
      </div>
    </main>
  )
}
