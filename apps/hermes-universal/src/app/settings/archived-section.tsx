import { useCallback, useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Tip } from '@/components/ui/tooltip'
import { deleteSession, getDefaultCwd, listSessions, setSessionArchived } from '@/hermes'
import { useI18n } from '@/i18n'
import { Archive, ArchiveOff, FolderOpen, Loader2, Trash } from '@/lib/icons'
import { IS_DESKTOP } from '@/lib/platform'
import { workspaceLabel } from '@/lib/workspace-path'
import { useStore } from '@/store/atom'
import { $defaultProjectDir, setDefaultProjectDir } from '@/store/default-project-dir'
import { notify, notifyError } from '@/store/notifications'
import { pickProjectFolder } from '@/store/projects'
import { refreshSessions } from '@/store/session'
import type { SessionInfo } from '@/types/hermes'

import { EmptyState, ListRow, LoadingState, SectionHeading, SettingsContent } from './primitives'
import { useDeepLinkHighlight } from './use-deep-link-highlight'

// Shared by the row wrapper and the deep-link lookup so a palette jump can
// never drift from the id the row actually renders.
const archivedElementId = (id: string) => `archived-session-${id}`

// Settings → Archived Chats. Ported to desktop parity (apps/desktop/src/app/settings/
// sessions-settings.tsx): a Default Project Directory picker on top, then the
// archived-session list (unarchive + permanent delete). Self-contained fetch — the
// main session store only tracks the active list.

// title || preview || fallback (matches desktop lib/chat-runtime sessionTitle).
const sessionTitle = (session: SessionInfo): string =>
  session.title?.trim() || session.preview?.trim() || 'Untitled session'

// ── Default project directory (desktop-only: needs a local FS + folder picker) ──
function DefaultProjectDirSetting() {
  const { t } = useI18n()
  const s = t.settings.sessions
  const dir = useStore($defaultProjectDir)
  const [fallback, setFallback] = useState('~')
  const [busy, setBusy] = useState(false)

  // Best-effort backend cwd for the "Defaults to …" hint when unset.
  useEffect(() => {
    let alive = true
    void getDefaultCwd()
      .then(res => {
        if (alive && res.cwd) {
          setFallback(res.cwd)
        }
      })
      .catch(() => {})

    return () => void (alive = false)
  }, [])

  const choose = async () => {
    setBusy(true)

    try {
      const picked = await pickProjectFolder()

      if (!picked) {
        return
      }

      setDefaultProjectDir(picked)
      notify({ kind: 'success', message: s.defaultDirUpdated })
    } catch (err) {
      notifyError(err, s.updateDirFailed)
    } finally {
      setBusy(false)
    }
  }

  const clear = () => {
    try {
      setDefaultProjectDir(null)
    } catch (err) {
      notifyError(err, s.clearDirFailed)
    }
  }

  return (
    <div className="mb-6">
      <SectionHeading icon={FolderOpen} title={s.defaultDirTitle} />
      <p className="mb-2 text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
        {s.defaultDirDesc}
      </p>
      <ListRow
        action={
          <div className="flex items-center gap-3">
            <Button disabled={busy} onClick={() => void choose()} size="sm" type="button" variant="textStrong">
              <FolderOpen className="size-3.5" />
              <span>{dir ? s.change : s.choose}</span>
            </Button>
            {dir ? (
              <Button disabled={busy} onClick={clear} size="sm" type="button" variant="text">
                {s.clear}
              </Button>
            ) : null}
          </div>
        }
        description={dir || s.defaultsTo(fallback)}
        title={dir || s.notSet}
      />
    </div>
  )
}

export function ArchivedSection() {
  const { t } = useI18n()
  const s = t.settings.sessions
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState<null | string>(null)
  const [confirm, setConfirm] = useState<SessionInfo | null>(null)

  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        const res = await listSessions(200, 0, 'only', 'recent')

        if (!cancelled) {
          setSessions(res.sessions)
        }
      } catch (err) {
        if (!cancelled) {
          setFailed(true)
        }

        notifyError(err, s.failedLoad)
      }
    })()

    return () => void (cancelled = true)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once on mount
  }, [])

  // Deep-link target from the command palette (?session=<id>): the palette
  // searches archived chats and lands here on the matching row.
  const sessionReady = useCallback((id: string) => (sessions ?? []).some(session => session.id === id), [sessions])

  useDeepLinkHighlight({ elementId: archivedElementId, param: 'session', ready: sessionReady })

  const drop = (id: string) => setSessions(list => (list ? list.filter(x => x.id !== id) : list))

  const unarchive = async (id: string) => {
    setBusy(id)

    try {
      await setSessionArchived(id, false)
      drop(id)
      void refreshSessions() // re-show the restored chat in the sidebar
      notify({ kind: 'success', message: s.restored })
    } catch (err) {
      notifyError(err, s.unarchiveFailed)
    } finally {
      setBusy(null)
    }
  }

  const remove = async (id: string) => {
    setConfirm(null)
    setBusy(id)

    try {
      await deleteSession(id)
      drop(id)
    } catch (err) {
      notifyError(err, s.deleteFailed)
    } finally {
      setBusy(null)
    }
  }

  if (!sessions && !failed) {
    return <LoadingState label={s.loading} />
  }

  const list = sessions ?? []

  return (
    <SettingsContent>
      {IS_DESKTOP ? <DefaultProjectDirSetting /> : null}

      <SectionHeading icon={Archive} meta={list.length ? String(list.length) : undefined} title={s.archivedTitle} />
      <p className="mb-2 text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
        {s.archivedIntro}
      </p>

      {list.length === 0 ? (
        <EmptyState description={s.emptyArchivedDesc} title={s.emptyArchivedTitle} />
      ) : (
        <div className="grid gap-1">
          {list.map(session => {
            const label = workspaceLabel(session.cwd)
            const meta = label ? `${label} · ${s.messages(session.message_count)}` : s.messages(session.message_count)

            return (
              <div className="scroll-mt-6 rounded-lg" id={archivedElementId(session.id)} key={session.id}>
                <ListRow
                  action={
                    <div className="flex items-center gap-1.5">
                      <Button
                        disabled={busy === session.id}
                        onClick={() => void unarchive(session.id)}
                        size="sm"
                        type="button"
                        variant="textStrong"
                      >
                        {busy === session.id ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <ArchiveOff className="size-3.5" />
                        )}
                        <span>{s.unarchive}</span>
                      </Button>
                      <Tip label={s.deletePermanently}>
                        <Button
                          aria-label={s.deletePermanently}
                          className="text-muted-foreground hover:text-destructive"
                          disabled={busy === session.id}
                          onClick={() => setConfirm(session)}
                          size="icon-sm"
                          type="button"
                          variant="ghost"
                        >
                          <Trash className="size-3.5" />
                        </Button>
                      </Tip>
                    </div>
                  }
                  description={session.preview || undefined}
                  hint={meta}
                  title={sessionTitle(session)}
                />
              </div>
            )
          })}
        </div>
      )}

      <Dialog onOpenChange={open => !open && setConfirm(null)} open={confirm !== null}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{s.deletePermanently}</DialogTitle>
            <DialogDescription>{confirm ? s.deleteConfirm(sessionTitle(confirm)) : ''}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost">{t.common.cancel}</Button>
            </DialogClose>
            <Button onClick={() => confirm && void remove(confirm.id)} variant="destructive">
              {s.deletePermanently}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsContent>
  )
}
