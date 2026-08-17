import { useEffect } from 'react'

import { InstallProgress } from '@/app/gateway/install-progress'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { Check, Cloud, Loader2, Monitor } from '@/lib/icons'
import { selectableCardClass } from '@/lib/selectable-card'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import {
  $installProgress,
  $localInstall,
  cancelLocalInstall,
  chooseRepo,
  detectLocalInstall,
  type Repo,
  startLocalInstall
} from '@/store/local-install'

// The Local gateway's configure step.
//
// Local is the one mode with nothing to type, and it used to render nothing at
// all — just the shared "Save & reconnect" button over a `hermes` binary that
// may not exist. This panel answers the question that button assumed: is Hermes
// installed here, and if not, which one should we install?

function RepoCard({
  active,
  description,
  onSelect,
  title
}: {
  active: boolean
  description: string
  onSelect: () => void
  title: string
}) {
  return (
    <button
      className={cn(
        'flex h-full w-full flex-col p-3 text-start',
        selectableCardClass({ active, prominent: true })
      )}
      onClick={onSelect}
      type="button"
    >
      <div className="flex items-center gap-1.5">
        <Cloud className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 text-[length:var(--conversation-text-font-size)] font-medium">{title}</span>
      </div>
      <p className="mt-1.5 text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ui-text-tertiary)">
        {description}
      </p>
    </button>
  )
}

export function LocalInstallPanel({ onContinue }: { onContinue: () => void }) {
  const { t } = useI18n()
  const l = t.connect.local
  const state = useStore($localInstall)
  const progress = useStore($installProgress)

  // Detect once per visit to the step. A stale "not installed" from a previous
  // visit would offer to reinstall something that is now present.
  useEffect(() => {
    void detectLocalInstall()
  }, [])

  const repos: { id: Repo; title: string; description: string }[] = [
    { description: l.upstreamDesc, id: 'upstream', title: l.upstreamTitle },
    { description: l.forkDesc, id: 'fork', title: l.forkTitle }
  ]

  if (state.phase === 'detecting') {
    return (
      <div className="local-install-status">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
        <span className="text-[length:var(--conversation-caption-font-size)] text-(--ui-text-secondary)">
          {l.detecting}
        </span>
      </div>
    )
  }

  if (state.phase === 'found') {
    return (
      <div className="local-install-block">
        <div className="flex items-center gap-1.5">
          <Check className="size-4 shrink-0 text-primary" />
          <span className="text-[length:var(--conversation-text-font-size)] font-medium">{l.foundTitle}</span>
        </div>
        {state.install?.command ? <p className="local-install-path">{state.install.command}</p> : null}
        {state.install?.version ? (
          <p className="connect-body">{l.foundVersion(state.install.version)}</p>
        ) : null}
        <Button className="w-full" onClick={onContinue}>
          {l.continue}
        </Button>
      </div>
    )
  }

  if (state.phase === 'missing') {
    return (
      <div className="local-install-block">
        <div className="flex items-center gap-1.5">
          <Monitor className="size-4 shrink-0 text-muted-foreground" />
          <span className="text-[length:var(--conversation-text-font-size)] font-medium">{l.missingTitle}</span>
        </div>
        <p className="connect-body">{l.missingBody}</p>
        <div className="grid auto-rows-fr grid-cols-1 gap-2">
          {repos.map(repo => (
            <RepoCard
              active={false}
              description={repo.description}
              key={repo.id}
              onSelect={() => chooseRepo(repo.id)}
              title={repo.title}
            />
          ))}
        </div>
      </div>
    )
  }

  if (state.phase === 'choosing') {
    const chosen = repos.find(repo => repo.id === state.repo)

    return (
      // No Back of its own: the wizard's step header already has one, and it
      // delegates here first (see `stepBackInLocalInstall`). Two stacked Back
      // buttons is what that replaced.
      <div className="local-install-block">
        <div className="text-[length:var(--conversation-text-font-size)] font-medium">{chosen?.title}</div>
        <p className="connect-body">{chosen?.description}</p>
        <Button className="w-full" onClick={() => void startLocalInstall()}>
          {l.install}
        </Button>
      </div>
    )
  }

  if (state.phase === 'done') {
    return (
      <div className="local-install-block">
        <div className="flex items-center gap-1.5">
          <Check className="size-4 shrink-0 text-primary" />
          <span className="text-[length:var(--conversation-text-font-size)] font-medium">{l.doneTitle}</span>
        </div>
        <p className="connect-body">{l.doneBody}</p>
        <Button className="w-full" onClick={onContinue}>
          {l.done}
        </Button>
      </div>
    )
  }

  // installing | failed — the ladder is shared with the SSH remote install.
  return (
    <InstallProgress
      onCancel={() => void cancelLocalInstall()}
      onRetry={() => void startLocalInstall()}
      progress={progress}
      state={state}
    />
  )
}
