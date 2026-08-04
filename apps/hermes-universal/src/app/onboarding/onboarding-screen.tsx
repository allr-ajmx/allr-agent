import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n'
import { openExternalLink } from '@/lib/external-link'
import { ChevronLeft, ChevronRight, Terminal } from '@/lib/icons'
import { useStore } from '@/store/atom'
import {
  $onboarding,
  backToPicker,
  chooseLater,
  confirmModel,
  saveApiKey,
  selectApiKeyProvider,
  startProviderOAuth,
  submitOnboardingCode
} from '@/store/onboarding'

import { ExternalCliCommand, ExternalDocsButton, ExternalRecheckButton } from '../settings/external-signin-panel'
import { providerTitle } from '../settings/oauth-provider-display'

import { type ApiKeyOption, LOCAL_ENV_KEY, useApiKeyCatalog, useOAuthProviders } from './api-key-options'

export function OnboardingScreen() {
  const { t } = useI18n()
  const state = useStore($onboarding)

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-background">
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col px-5 py-[max(2rem,env(safe-area-inset-top))]">
        <h1 className="text-xl font-semibold text-foreground">{t.onboarding.headerTitle}</h1>
        <p className="mt-1 mb-6 text-sm text-muted-foreground">{t.onboarding.headerDesc}</p>

        {state.step === 'picker' ? (
          <Picker />
        ) : state.step === 'apikey' ? (
          <ApiKeyForm option={state.option} />
        ) : state.step === 'oauth' ? (
          <OAuthPanel />
        ) : (
          <ConfirmModel />
        )}
      </div>
    </div>
  )
}

function Picker() {
  const { t } = useI18n()
  const options = useApiKeyCatalog()
  const oauthProviders = useOAuthProviders()
  const copy = t.onboarding.apiKeyOptions as Record<string, { short: string; description: string }>

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex flex-col gap-2">
        {oauthProviders.map(provider => (
          <button
            className="flex items-center gap-3 rounded-lg border border-border bg-card p-3 text-left transition-colors hover:border-primary"
            key={provider.id}
            onClick={() => void startProviderOAuth(provider)}
            type="button"
          >
            <span className="min-w-0 flex-1">
              <span className="truncate text-sm font-medium text-foreground">
                {t.onboarding.signInWith(providerTitle(provider))}
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {t.onboarding.flowSubtitles[provider.flow]}
              </span>
            </span>
            {/* CLI-managed providers open a terminal command, not a browser. */}
            {provider.flow === 'external' ? (
              <Terminal className="size-4 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
            )}
          </button>
        ))}
        {options.map(option => (
          <button
            className="flex items-center gap-3 rounded-lg border border-border bg-card p-3 text-left transition-colors hover:border-primary"
            key={option.id}
            onClick={() => selectApiKeyProvider(option)}
            type="button"
          >
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="truncate text-sm font-medium text-foreground">{option.name}</span>
                {option.id === 'openrouter' && (
                  <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-[0.65rem] font-medium text-primary">
                    {t.onboarding.recommended}
                  </span>
                )}
              </span>
              {copy[option.id]?.description && (
                <span className="mt-0.5 block text-xs text-muted-foreground">{copy[option.id].description}</span>
              )}
            </span>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
          </button>
        ))}
      </div>

      <Button className="mt-6 w-full" onClick={() => chooseLater()} variant="ghost">
        {t.onboarding.chooseLater}
      </Button>
    </div>
  )
}

function ApiKeyForm({ option }: { option: ApiKeyOption | null }) {
  const { t } = useI18n()
  const state = useStore($onboarding)
  const [value, setValue] = useState('')
  const [localApiKey, setLocalApiKey] = useState('')

  if (!option) {
    return null
  }

  const isLocal = option.envKey === LOCAL_ENV_KEY

  const submit = () => void saveApiKey(option, value, isLocal ? localApiKey : undefined)

  return (
    <div className="flex flex-1 flex-col">
      <button
        className="-ml-1 mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground"
        onClick={() => backToPicker()}
        type="button"
      >
        <ChevronLeft className="size-4" />
        {t.onboarding.backToSignIn}
      </button>

      <div className="text-base font-medium text-foreground">{option.name}</div>

      <label className="mt-4 block">
        <Input
          autoFocus
          onChange={e => setValue(e.target.value)}
          placeholder={isLocal ? option.placeholder : t.onboarding.pasteApiKey}
          type={isLocal ? 'text' : 'password'}
          value={value}
        />
      </label>

      {isLocal && (
        <label className="mt-2 block">
          <Input
            onChange={e => setLocalApiKey(e.target.value)}
            placeholder={t.onboarding.localApiKeyPlaceholder}
            type="password"
            value={localApiKey}
          />
        </label>
      )}

      {state.error && <p className="mt-2 text-xs text-destructive">{state.error}</p>}

      {option.docsUrl && (
        <Button className="mt-3 w-fit" onClick={() => void openExternalLink(option.docsUrl!)} size="sm" variant="ghost">
          {t.onboarding.getKey}
        </Button>
      )}

      <Button className="mt-auto w-full" disabled={state.busy || !value.trim()} onClick={submit}>
        {state.busy ? t.onboarding.connecting : t.common.continue}
      </Button>
    </div>
  )
}

function OAuthPanel() {
  const { t } = useI18n()
  const state = useStore($onboarding)
  const [code, setCode] = useState('')
  const oauth = state.oauth

  if (!oauth) {
    return null
  }

  const providerName = providerTitle(oauth.provider)
  const copyCode = () => void navigator.clipboard?.writeText(oauth.userCode ?? '').catch(() => {})

  const backRow = (
    <button
      className="-ml-1 mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground"
      onClick={() => backToPicker()}
      type="button"
    >
      <ChevronLeft className="size-4" />
      {t.onboarding.pickDifferentProvider}
    </button>
  )

  // CLI-managed provider (Qwen / Copilot / Claude Code…): there is no auth URL to
  // reopen and no code to paste — show the command to run in a terminal, then
  // recheck. Same flow Settings → Providers drives via the connect overlay.
  if (oauth.flow === 'external') {
    return (
      <div className="flex flex-1 flex-col">
        {backRow}

        <div className="text-base font-medium text-foreground">{t.onboarding.signInWith(providerName)}</div>
        <p className="mt-3 text-sm text-muted-foreground">{t.onboarding.externalPending(providerName)}</p>

        <div className="mt-3">
          <ExternalCliCommand command={oauth.provider.cli_command} />
        </div>

        {state.error && <p className="mt-2 text-xs text-destructive">{state.error}</p>}

        <ExternalDocsButton className="mt-3 w-fit" provider={oauth.provider} />

        <ExternalRecheckButton className="mt-auto w-full" rechecking={oauth.status === 'rechecking'} />
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col">
      {backRow}

      <div className="text-base font-medium text-foreground">{t.onboarding.signInWith(providerName)}</div>

      {oauth.flow === 'device_code' ? (
        <>
          <p className="mt-3 text-sm text-muted-foreground">{t.onboarding.deviceCodeOpened(providerName)}</p>
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
          <p className="mt-3 text-xs text-muted-foreground">{t.onboarding.waitingAuthorize}</p>
        </>
      ) : (
        <>
          <p className="mt-3 text-sm text-muted-foreground">{t.onboarding.openedBrowser(providerName)}</p>
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

      <Button className="mt-3 w-fit" onClick={() => void openExternalLink(oauth.url)} size="sm" variant="ghost">
        {oauth.flow === 'device_code' ? t.onboarding.reopenVerification : t.onboarding.reopenAuthPage}
      </Button>

      {oauth.flow === 'pkce' && (
        <Button
          className="mt-auto w-full"
          disabled={state.busy || !code.trim()}
          onClick={() => void submitOnboardingCode(code)}
        >
          {state.busy ? t.onboarding.connecting : t.common.continue}
        </Button>
      )}
    </div>
  )
}

function ConfirmModel() {
  const { t } = useI18n()
  const state = useStore($onboarding)

  return (
    <div className="flex flex-1 flex-col">
      <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {t.onboarding.defaultModel}
      </div>
      <div className="mt-1 rounded-lg border border-border bg-card p-3">
        <div className="text-sm font-medium text-foreground">
          {state.recommended?.model ?? t.onboarding.recommended}
        </div>
        {state.recommended?.provider && (
          <div className="text-xs text-muted-foreground">{state.recommended.provider}</div>
        )}
      </div>

      {state.error && <p className="mt-2 text-xs text-destructive">{state.error}</p>}

      <Button className="mt-auto w-full" disabled={state.busy} onClick={() => void confirmModel()}>
        {state.busy ? t.onboarding.connecting : t.onboarding.startChatting}
      </Button>
    </div>
  )
}
