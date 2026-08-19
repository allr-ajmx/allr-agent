import { InstallProgress } from '@/app/gateway/install-progress'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { Check, ChevronLeft, Cloud, Download } from '@/lib/icons'
import { selectableCardClass } from '@/lib/selectable-card'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import type { SshTarget } from '@/store/connection'
import type { Repo } from '@/store/local-install'
import {
  $sshInstall,
  $sshInstallProgress,
  cancelSshInstall,
  chooseSshRepo,
  dismissSshInstall,
  startSshInstall,
  stepBackInSshInstall
} from '@/store/ssh-install'

// Offering to install Allr on the remote host, shown after a connect failed
// with `hermes-not-found`.
//
// Deliberately AFTER the failure and behind an explicit button rather than
// something the connect does on its own: this writes to a machine that is not
// the user's own, and a mistyped hostname must not be enough to start it.
//
// Rendered beside SshPanel rather than inside it, so the panel's prop list stays
// about the SSH form.

function RepoCard({ description, onSelect, title }: { description: string; onSelect: () => void; title: string }) {
  return (
    <button
      className={cn('flex w-full flex-col p-3 text-start', selectableCardClass({ active: false, prominent: true }))}
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

export function SshInstallOffer({ target }: { target: SshTarget }) {
  const { t } = useI18n()
  const g = t.settings.gateway
  const l = t.connect.local
  const state = useStore($sshInstall)
  const progress = useStore($sshInstallProgress)

  if (!state) {
    return null
  }

  const repos: { id: Repo; title: string; description: string }[] = [
    { description: l.upstreamDesc, id: 'upstream', title: l.upstreamTitle },
    { description: l.forkDesc, id: 'fork', title: l.forkTitle }
  ]

  if (state.phase === 'installing' || state.phase === 'failed') {
    return (
      <div className="mt-3 rounded-md border border-(--ui-border) p-3">
        <InstallProgress
          onCancel={() => void cancelSshInstall()}
          onRetry={() => void startSshInstall(target)}
          progress={progress}
          state={state}
        />
      </div>
    )
  }

  if (state.phase === 'done') {
    return (
      <div className="mt-3 grid gap-2 rounded-md border border-(--ui-border) p-3">
        <div className="flex items-center gap-1.5">
          <Check className="size-4 shrink-0 text-primary" />
          <span className="text-sm font-medium">{g.sshInstallDoneTitle}</span>
        </div>
        {/* Deliberately does not auto-connect: the user asked to install, not to
            dial, and the connect is a separate deliberate action. */}
        <p className="text-xs text-(--ui-text-secondary)">{g.sshInstallDoneBody}</p>
        <div className="flex justify-end">
          <Button onClick={dismissSshInstall} size="sm">
            {l.done}
          </Button>
        </div>
      </div>
    )
  }

  if (state.phase === 'choosing') {
    const chosen = repos.find(repo => repo.id === state.repo)

    return (
      <div className="mt-3 grid gap-2 rounded-md border border-(--ui-border) p-3">
        {/* `justify-self-start`, not `self-start`: the parent is a grid, where
            `self-*` is the block axis. A grid item defaults to stretching across
            the column, and the Button centres its own label inside that — which
            put Back in the middle of the card. */}
        <Button className="-ms-1 justify-self-start" onClick={stepBackInSshInstall} size="sm" variant="text">
          <ChevronLeft className="size-4 rtl:rotate-180" />
          {t.connect.back}
        </Button>
        <div className="text-sm font-medium">{chosen?.title}</div>
        <p className="text-xs text-(--ui-text-secondary)">{chosen?.description}</p>
        <div className="flex justify-end">
          <Button onClick={() => void startSshInstall(target)} size="sm">
            <Download className="size-3.5" />
            {l.install}
          </Button>
        </div>
      </div>
    )
  }

  // 'missing' — the offer itself.
  return (
    <div className="mt-3 grid gap-2 rounded-md border border-(--ui-border) p-3">
      <div className="text-sm font-medium">{g.sshInstallTitle(state.host)}</div>
      {/* Says "no administrator access is needed" because it is true and it is
          the first question anyone asks: everything except git bootstraps into
          the user's own home directory. */}
      <p className="text-xs text-(--ui-text-secondary)">{g.sshInstallBody}</p>
      <div className="grid gap-2">
        {repos.map(repo => (
          <RepoCard
            description={repo.description}
            key={repo.id}
            onSelect={() => chooseSshRepo(repo.id)}
            title={repo.title}
          />
        ))}
      </div>
      <div className="flex justify-end">
        <Button onClick={dismissSshInstall} size="sm" variant="outline">
          {g.sshInstallCancel}
        </Button>
      </div>
    </div>
  )
}
