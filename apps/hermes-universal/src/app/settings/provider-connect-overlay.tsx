import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n'
import { openExternalLink } from '@/lib/external-link'
import { Loader2, X } from '@/lib/icons'
import { useStore } from '@/store/atom'
import {
  $connectProvider,
  $onboarding,
  cancelProviderConnect,
  confirmModel,
  submitOnboardingCode
} from '@/store/onboarding'

import { ExternalCliCommand, ExternalDocsButton, ExternalRecheckButton } from './external-signin-panel'
import { providerTitle } from './oauth-provider-display'

// Focused per-provider connect overlay (Settings → Providers → Accounts). Floats
// over the still-mounted settings page (z-[70] > settings z-50 > pet z-60) and
// drives the shared OAuth state machine ($onboarding) for a single provider —
// skipping the picker/welcome. Mirrors desktop's manual-connect overlay.
export function ProviderConnectOverlay() {
  const provider = useStore($connectProvider)
  const state = useStore($onboarding)
  const { t } = useI18n()
  const [code, setCode] = useState('')

  if (!provider) {
    return null
  }

  const title = providerTitle(provider)
  const oauth = state.oauth

  const copyCode = () => void navigator.clipboard?.writeText(oauth?.userCode ?? '').catch(() => {})

  let body: React.ReactNode

  if (state.step === 'confirm') {
    body = (
      <div className="flex flex-col">
        <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {t.onboarding.defaultModel}
        </div>
        <div className="mt-1 rounded-lg border border-border bg-muted/40 p-3">
          <div className="text-sm font-medium text-foreground">
            {state.recommended?.model ?? t.onboarding.recommended}
          </div>
          {state.recommended?.provider && (
            <div className="text-xs text-muted-foreground">{state.recommended.provider}</div>
          )}
        </div>
        {state.error && <p className="mt-2 text-xs text-destructive">{state.error}</p>}
        <Button
          className="mt-4 w-full"
          disabled={state.busy}
          onClick={() => void confirmModel().then(ok => ok && $connectProvider.set(null))}
        >
          {state.busy ? t.onboarding.connecting : t.onboarding.startChatting}
        </Button>
      </div>
    )
  } else if (oauth?.flow === 'external') {
    // CLI-managed provider (Qwen / Copilot / Claude Code…): show the command to
    // run + a recheck, instead of an in-app browser flow.
    body = (
      <div className="flex flex-col">
        <p className="text-sm text-muted-foreground">{t.onboarding.externalPending(title)}</p>
        <div className="mt-3">
          <ExternalCliCommand command={provider.cli_command} />
        </div>

        {state.error && <p className="mt-2 text-xs text-destructive">{state.error}</p>}

        <div className="mt-3 flex items-center justify-between gap-2">
          {provider.docs_url ? <ExternalDocsButton provider={provider} /> : <span />}
          <div className="flex items-center gap-2">
            <Button onClick={() => cancelProviderConnect()} size="sm" type="button" variant="ghost">
              {t.common.cancel}
            </Button>
            <ExternalRecheckButton rechecking={oauth.status === 'rechecking'} />
          </div>
        </div>
      </div>
    )
  } else if (oauth) {
    body = (
      <div className="flex flex-col">
        {oauth.flow === 'device_code' ? (
          <>
            <p className="text-sm text-muted-foreground">{t.onboarding.deviceCodeOpened(title)}</p>
            {oauth.userCode && (
              <div className="mt-2 flex items-center gap-2">
                <code className="flex-1 rounded-lg bg-muted px-3 py-2 text-center font-mono text-lg tracking-widest text-foreground">
                  {oauth.userCode}
                </code>
                <Button onClick={copyCode} size="sm" variant="outline">
                  {t.onboarding.copy}
                </Button>
              </div>
            )}
            <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              {t.onboarding.waitingAuthorize}
            </p>
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">{t.onboarding.openedBrowser(title)}</p>
            <p className="text-sm text-muted-foreground">{t.onboarding.copyAuthCode}</p>
            <Input
              className="mt-3"
              onChange={e => setCode(e.target.value)}
              placeholder={t.onboarding.pasteAuthCode}
              value={code}
            />
          </>
        )}

        {state.error && <p className="mt-2 text-xs text-destructive">{state.error}</p>}

        <div className="mt-3 flex items-center justify-between gap-2">
          <Button onClick={() => void openExternalLink(oauth.url)} size="sm" variant="ghost">
            {oauth.flow === 'device_code' ? t.onboarding.reopenVerification : t.onboarding.reopenAuthPage}
          </Button>
          <div className="flex items-center gap-2">
            <Button onClick={() => cancelProviderConnect()} size="sm" type="button" variant="ghost">
              {t.common.cancel}
            </Button>
            {oauth.flow === 'pkce' && (
              <Button disabled={state.busy || !code.trim()} onClick={() => void submitOnboardingCode(code)} size="sm">
                {state.busy ? t.onboarding.connecting : t.common.continue}
              </Button>
            )}
          </div>
        </div>
      </div>
    )
  } else {
    // Starting (busy, no session yet) or a pre-session error.
    body = (
      <div className="flex flex-col items-center gap-3 py-6 text-center">
        {state.error ? (
          <p className="text-sm text-destructive">{state.error}</p>
        ) : (
          <>
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{t.onboarding.startingSignIn(title)}</p>
          </>
        )}
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm">
      <div className="relative w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-lg">
        <button
          aria-label={t.common.close}
          className="absolute right-3 top-3 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          onClick={() => cancelProviderConnect()}
          type="button"
        >
          <X className="size-4" />
        </button>

        <div className="mb-3 pr-6 text-base font-medium text-foreground">{t.onboarding.signInWith(title)}</div>
        {body}
      </div>
    </div>
  )
}
