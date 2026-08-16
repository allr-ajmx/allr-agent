import { getVersion } from '@tauri-apps/api/app'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { type Translations, useI18n } from '@/i18n'
import { openExternalLink } from '@/lib/external-link'
import { CheckCircle2, Download, ExternalLink, Loader2, RefreshCw } from '@/lib/icons'
import { IS_ANDROID, IS_IOS } from '@/lib/platform'
import { openAppDownload } from '@/lib/updates'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import { $status } from '@/store/connection'
import { $appUpdate, $appUpdateChecking, $appUpdateFailed, runUpdateCheck } from '@/store/updates'

import { ListRow, SectionHeading, SettingsContent } from './primitives'

const RELEASE_NOTES_URL = 'https://github.com/NousResearch/hermes-agent/releases'

// About (Jc12 / MJX-16): app version + backend version + release notes, plus the
// update check (MJX-6). Where an update comes from is the native side's problem
// — GitHub Releases on desktop, the Play/App Store listing on mobile — so this
// only renders whatever `$appUpdate` reports and opens `downloadUrl`. A build
// without the `update-checks` cargo feature reports source 'disabled', and the
// whole Updates block is hidden.

// Ported from apps/desktop/src/app/settings/about-settings.tsx.
function relativeTime(ms: number | undefined, a: Translations['settings']['about']) {
  if (!ms) {
    return a.never
  }

  const diff = Date.now() - ms

  if (diff < 60_000) {
    return a.justNow
  }

  if (diff < 3_600_000) {
    return a.minAgo(Math.round(diff / 60_000))
  }

  if (diff < 86_400_000) {
    return a.hoursAgo(Math.round(diff / 3_600_000))
  }

  return a.daysAgo(Math.round(diff / 86_400_000))
}

export function AboutSection() {
  const { t } = useI18n()
  const a = t.settings.about
  const status = useStore($status)
  const update = useStore($appUpdate)
  const checking = useStore($appUpdateChecking)
  const failed = useStore($appUpdateFailed)
  const [appVersion, setAppVersion] = useState<null | string>(null)

  useEffect(() => {
    let cancelled = false
    void getVersion()
      .then(v => !cancelled && setAppVersion(v))
      .catch(() => !cancelled && setAppVersion(null))

    return () => void (cancelled = true)
  }, [])

  // Cheap: the native side answers from a 6h cache unless forced.
  useEffect(() => {
    void runUpdateCheck()
  }, [])

  // No update surface at all when the checks were compiled out (or the command
  // isn't there) — the page falls back to exactly its pre-MJX-6 form.
  const showUpdates = Boolean(update) && update?.source !== 'disabled'

  const downloadLabel = IS_ANDROID ? a.openInPlayStore : IS_IOS ? a.openInAppStore : a.downloadUpdate

  let statusLine: string
  let statusTone: 'available' | 'error' | 'idle' = 'idle'

  if (checking) {
    statusLine = a.checking
  } else if (failed || update?.reason === 'unreachable') {
    statusLine = a.cantReach
    statusTone = 'error'
  } else if (update?.reason === 'unparsed') {
    statusLine = a.cantRead
    statusTone = 'error'
  } else if (update?.updateAvailable) {
    statusLine = update.latestVersion ? a.newVersion(update.latestVersion) : a.updateReady(1)
    statusTone = 'available'
  } else if (update) {
    statusLine = a.onLatest
  } else {
    statusLine = a.tapCheck
  }

  return (
    <SettingsContent>
      <div className="flex flex-col items-center gap-1 pt-8 pb-4 text-center">
        <div className="text-lg font-bold tracking-[0.18em] text-primary uppercase">{a.heading}</div>
        <div className="text-sm text-muted-foreground">{appVersion ? a.version(appVersion) : a.versionUnavailable}</div>
      </div>

      {status?.version && <ListRow description={String(status.version)} title="Gateway" />}

      {showUpdates && (
        <div className="mt-2">
          <SectionHeading icon={RefreshCw} title={a.updates} />

          <div
            className={cn(
              'rounded-xl border px-4 py-3 text-sm',
              statusTone === 'available' && 'border-primary/30 bg-primary/5 text-foreground',
              statusTone === 'error' && 'border-destructive/35 bg-destructive/5 text-destructive',
              statusTone === 'idle' && 'border-border/70 bg-muted/20 text-foreground'
            )}
          >
            <div className="flex items-start gap-2">
              {statusTone === 'available' ? (
                <Download className="mt-0.5 size-4 shrink-0 text-primary" />
              ) : statusTone === 'error' ? null : (
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-(--ui-green)" />
              )}
              <div className="min-w-0">
                <p className="font-medium">{statusLine}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {a.lastChecked(relativeTime(update?.checkedAtMs, a))}
                </p>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button disabled={checking} onClick={() => void runUpdateCheck(true)} size="sm" variant="outline">
                {checking ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
                {checking ? a.checking : a.checkNow}
              </Button>

              {update?.updateAvailable && update.downloadUrl && (
                <Button onClick={() => void openAppDownload(update.downloadUrl!, update.notesUrl)} size="sm">
                  <Download className="size-3" />
                  {downloadLabel}
                </Button>
              )}

              {update?.notesUrl && (
                <Button onClick={() => void openExternalLink(update.notesUrl!)} size="sm" variant="ghost">
                  <ExternalLink className="size-3" />
                  {a.seeWhatsNew}
                </Button>
              )}
            </div>
          </div>
        </div>
      )}

      <Button className="mt-4 w-full" onClick={() => void openExternalLink(RELEASE_NOTES_URL)} variant="outline">
        {a.releaseNotes}
      </Button>
    </SettingsContent>
  )
}
