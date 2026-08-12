import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useI18n } from '@/i18n'
import { sessionTitle } from '@/lib/chat-runtime'
import { useStore } from '@/store/atom'
import { $pendingClose, type PendingClose, resolvePendingClose } from '@/store/close-confirm'
import { $previewTabs } from '@/store/preview'
import { sessionRowFor } from '@/store/session-lookup'

/** Name the tab the question is about. A queue of prompts that all read "Close
 *  running tab?" says nothing about which tab is which. Plain lookups, not
 *  subscriptions — this re-renders whenever the pending close moves anyway. */
function labelFor(pending: PendingClose): string {
  if (pending.kind === 'file') {
    return $previewTabs.get().find(tab => tab.path === pending.id)?.name ?? pending.id
  }

  const row = sessionRowFor(pending.id)

  return row ? sessionTitle(row) : ''
}

/**
 * "Are you sure?" for every close that would drop live work — a chat mid-turn, a
 * file with unsaved edits.
 *
 * Mounted once per WINDOW from `app.tsx`, not from a shell. Its predecessor
 * (`SessionTileCloseConfirm`) lived inside `ContribController`, which only the
 * DOCKED TILE TREE renders: a phone takes the `MobileShell` branch and a narrow
 * window takes `AppShell`, so on both the gate could park a pending close and
 * nothing would ever draw the question. Closing a working chat from the mobile
 * bubble strip was unconfirmable by construction. Window level is the only level
 * where every shell, the detached tile window and the activity root all get it.
 */
export function CloseConfirm() {
  const { t } = useI18n()
  const pending = useStore($pendingClose)

  const copy =
    pending?.kind === 'file'
      ? {
          body: t.preview.closeDirtyBody,
          confirm: t.preview.closeDirtyConfirm,
          title: t.preview.closeDirtyTitle
        }
      : { body: t.zones.closeRunningBody, confirm: t.zones.closeRunningConfirm, title: t.zones.closeRunningTitle }

  const label = pending ? labelFor(pending) : ''

  return (
    <ConfirmDialog
      confirmLabel={copy.confirm}
      description={
        <>
          {label ? <span className="block font-medium text-foreground">{label}</span> : null}
          {copy.body}
        </>
      }
      destructive={pending?.kind === 'file'}
      // Dismiss the moment the answer lands: the default path holds the dialog
      // open for a 600ms "done" beat, and with a QUEUE behind it that beat would
      // be spent showing the next tab's question under the previous one's
      // resolved state.
      dismissOnConfirm
      // Both handlers fire on a confirm (ConfirmDialog closes itself after
      // onConfirm), so they answer by TOKEN — the second call finds the queue
      // already advanced and is ignored.
      onClose={() => pending && resolvePendingClose(pending.token, false)}
      onConfirm={() => pending && resolvePendingClose(pending.token, true)}
      open={Boolean(pending)}
      title={copy.title}
    />
  )
}
