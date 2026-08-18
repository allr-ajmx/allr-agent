import { useEffect, useState } from 'react'

import { GatewayConfigurator } from '@/app/gateway/gateway-configurator'
import { LanguageSwitcher } from '@/components/language-switcher'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { getAppFlag, setAppFlag } from '@/lib/app-flags'
import { useStore } from '@/store/atom'
import { $connectionError } from '@/store/connection'

// First-run connect flow, as a three-step wizard:
//
//   welcome  →  choose a gateway  →  configure it + sign in
//
// This screen owns the WELCOME step only. The other two live inside
// GatewayConfigurator (`variant="onboarding"`), because splitting them means
// splitting its render tree — it owns the mode grid, every per-mode panel and
// the connect footer. Welcome has no gateway coupling at all, so it stays here.
//
// Shown only on a genuine first run or a failed restore; an in-session reconnect
// uses GatewayConnectingScreen instead (see MobileController).
type Step = 'connect' | 'unknown' | 'welcome'

export function ConnectScreen() {
  const connectError = useStore($connectionError)
  const { t } = useI18n()

  // 'unknown' is the pre-resolution state, not a default. The flag lives in the
  // native store (lib/app-flags) so it survives a webview data reset, and that
  // read is async — defaulting to 'welcome' would flash the welcome screen at
  // every returning user for a frame before it resolved.
  const [step, setStep] = useState<Step>('unknown')

  useEffect(() => {
    let cancelled = false

    void getAppFlag('connectWelcomed').then(seen => {
      if (!cancelled) {
        setStep(seen ? 'connect' : 'welcome')
      }
    })

    return () => {
      cancelled = true
    }
  }, [])

  // Advance first, persist second: a slow or failing disk write must not stall
  // the transition. Showing the welcome twice is a far cheaper failure than a
  // button that appears not to respond.
  const start = () => {
    setStep('connect')
    void setAppFlag('connectWelcomed', true).catch(() => {})
  }

  return (
    <main className="connect">
      <div className="connect-card">
        <div className="connect-head">
          <div className="brand">Allr</div>
          {/* Language belongs on the FIRST screen: every later step is prose the
              user has to read to make a choice. Offered here only — past this
              point Settings owns it. */}
          {step === 'welcome' ? <LanguageSwitcher /> : null}
        </div>

        {step === 'welcome' ? (
          <div className="connect-welcome">
            <h1 className="connect-title">{t.connect.welcomeTitle}</h1>
            <p className="connect-body">{t.connect.welcomeBody}</p>
            <Button className="w-full" onClick={start} size="lg">
              {t.connect.getStarted}
            </Button>
          </div>
        ) : null}

        {step === 'connect' ? (
          <>
            {connectError && <div className="text-[0.8125rem] text-destructive">{connectError}</div>}
            <GatewayConfigurator variant="onboarding" />
          </>
        ) : null}
      </div>
    </main>
  )
}
