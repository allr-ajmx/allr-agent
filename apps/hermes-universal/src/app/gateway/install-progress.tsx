import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { AlertCircle, Check, Loader2, X } from '@/lib/icons'
import { cn } from '@/lib/utils'
import type { LocalInstallState, LogLine, InstallProgress as Progress, StageState } from '@/store/local-install'

// The install ladder, shared by the local and the remote (SSH) install.
//
// Both drive the same staged protocol from `scripts/install.sh` and emit the
// same events, so they must look and behave identically — a copy per surface
// would drift the moment one gained a fix. Only the transport differs, and that
// is entirely behind the store.
//
// Copy comes from `t.install.*`, which already existed fully translated as a
// port of the desktop install overlay.

/** The icon carries the stage's state, so it also carries its label. */
function StageIcon({ label, state }: { label: string; state: StageState }) {
  if (state === 'running') {
    return <Loader2 aria-label={label} className="size-3.5 shrink-0 animate-spin text-primary" />
  }

  if (state === 'failed') {
    return <X aria-label={label} className="size-3.5 shrink-0 text-destructive" />
  }

  if (state === 'succeeded' || state === 'skipped') {
    return <Check aria-label={label} className="size-3.5 shrink-0 text-primary" />
  }

  return <span aria-label={label} className="size-3.5 shrink-0" role="img" />
}

/**
 * mm:ss since `startedAt`.
 *
 * Not decoration: the heaviest stage pulls a Playwright Chromium and runs for
 * minutes with no output of its own. A ticking clock is the difference between
 * "working" and "hung" for the user.
 */
function Elapsed({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)

    return () => window.clearInterval(id)
  }, [])

  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000))
  const mm = String(Math.floor(seconds / 60)).padStart(2, '0')
  const ss = String(seconds % 60).padStart(2, '0')

  return <span className="font-mono text-[0.6875rem] text-(--ui-text-tertiary)">{`${mm}:${ss}`}</span>
}

function LogPane({ expanded, log }: { expanded: boolean; log: LogLine[] }) {
  const bottom = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (expanded) {
      bottom.current?.scrollIntoView({ block: 'end' })
    }
  }, [expanded, log.length])

  if (!expanded) {
    return null
  }

  return (
    <div className="local-install-log">
      {log.map((entry, index) => (
        <div
          // Append-only, and lines repeat verbatim (progress bars), so the index
          // is the only stable identity available.
          className={cn('whitespace-pre-wrap', entry.stream === 'stderr' && 'text-(--ui-text-tertiary)')}
          key={index}
        >
          {entry.line}
        </div>
      ))}
      <div ref={bottom} />
    </div>
  )
}

export function InstallProgress({
  onCancel,
  onRetry,
  progress,
  state
}: {
  onCancel: () => void
  onRetry: () => void
  progress: Progress
  state: LocalInstallState
}) {
  const { t } = useI18n()
  const i = t.install
  const [logOpen, setLogOpen] = useState(false)
  const failed = state.phase === 'failed'

  // A failure is the one time the log is worth more than the summary.
  useEffect(() => {
    if (failed) {
      setLogOpen(true)
    }
  }, [failed])

  return (
    <div className="local-install-block">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          {failed ? (
            <AlertCircle className="size-4 shrink-0 text-destructive" />
          ) : (
            <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
          )}
          <span className="truncate text-[length:var(--conversation-text-font-size)] font-medium">
            {failed ? i.failedTitle : i.settingUpTitle}
          </span>
        </div>
        {state.startedAt ? <Elapsed startedAt={state.startedAt} /> : null}
      </div>

      {failed && state.error ? <p className="text-[0.8125rem] text-destructive">{state.error}</p> : null}

      {state.stageOrder.length > 0 ? (
        <>
          <p className="connect-body">{i.progress(progress.done, progress.total)}</p>
          <div className="local-install-bar">
            <div
              className="local-install-bar-fill"
              style={{ width: `${Math.max(2, Math.round(progress.fraction * 100))}%` }}
            />
          </div>
          <ol className="local-install-stages">
            {state.stageOrder.map(name => {
              const stage = state.stages[name]

              return (
                <li className={cn('local-install-stage', stage?.state === 'pending' && 'opacity-50')} key={name}>
                  <StageIcon label={i.stageStates[stage?.state ?? 'pending']} state={stage?.state ?? 'pending'} />
                  {/* Titles come from the installer's own manifest — the stage
                      list belongs to the script, so translating it here would
                      drift the moment the script gained a step. Only the STATE
                      labels are ours. */}
                  <span className="min-w-0 flex-1 truncate">{stage?.title ?? name}</span>
                </li>
              )
            })}
          </ol>
        </>
      ) : null}

      <div className="flex items-center gap-2">
        <Button onClick={() => setLogOpen(open => !open)} size="sm" variant="text">
          {logOpen ? i.hideOutput : i.showOutput}
        </Button>
        {failed ? (
          <Button className="ms-auto" onClick={onRetry} size="sm">
            {t.connect.local.retry}
          </Button>
        ) : (
          <Button className="ms-auto" onClick={onCancel} size="sm" variant="outline">
            {i.cancelInstall}
          </Button>
        )}
      </div>

      <LogPane expanded={logOpen} log={state.log} />
    </div>
  )
}
