import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { openExternalLink } from '@/lib/external-link'
import { Loader2 } from '@/lib/icons'
import { recheckExternalSignin } from '@/store/onboarding'
import type { OAuthProvider } from '@/types/hermes'

import { providerTitle } from './oauth-provider-display'

// The three pieces of the external (CLI-managed) sign-in flow — Qwen / Copilot /
// Claude Code and friends mint their creds through a third-party CLI, so there is
// no in-app browser OAuth: we show the command to run and a recheck. Shared by the
// Settings connect overlay and the first-run onboarding panel, whose surrounding
// layouts differ (footer button row vs. full-width column), so each host composes
// these rather than consuming one fixed body.

/** The copyable `$ <cli_command>` block, with its own copied-for-1.5s state. */
export function ExternalCliCommand({ command }: { command: string }) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)

  const copy = () =>
    void navigator.clipboard
      ?.writeText(command)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {})

  return (
    <div className="flex items-center gap-2">
      <code className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-muted px-3 py-2 font-mono text-sm whitespace-nowrap text-foreground">
        <span className="text-muted-foreground">$ </span>
        {command}
      </code>
      <Button onClick={copy} size="sm" type="button" variant="outline">
        {copied ? t.common.copied : t.onboarding.copy}
      </Button>
    </div>
  )
}

/** "<Provider> docs" link — rendered only when the provider ships a docs URL. */
export function ExternalDocsButton({ className, provider }: { className?: string; provider: OAuthProvider }) {
  const { t } = useI18n()

  if (!provider.docs_url) {
    return null
  }

  return (
    <Button
      className={className}
      onClick={() => void openExternalLink(provider.docs_url)}
      size="sm"
      type="button"
      variant="ghost"
    >
      {t.onboarding.docs(providerTitle(provider))}
    </Button>
  )
}

/** "I've signed in" — re-lists providers and advances when the CLI creds landed. */
export function ExternalRecheckButton({ className, rechecking }: { className?: string; rechecking: boolean }) {
  const { t } = useI18n()

  return (
    <Button
      className={className}
      disabled={rechecking}
      onClick={() => void recheckExternalSignin()}
      size="sm"
      type="button"
    >
      {rechecking && <Loader2 className="size-3.5 animate-spin" />}
      {t.onboarding.signedIn}
    </Button>
  )
}
