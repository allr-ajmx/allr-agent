import type * as React from 'react'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import { IS_MOBILE } from '@/lib/platform'
import { useStore } from '@/store/atom'
import { addBubble } from '@/store/chat-bubbles'
import { notify, notifyError } from '@/store/notifications'
import { $activeStoredSessionId, renameSessionLocal } from '@/store/session'
import { openSessionTile } from '@/store/session-states'
import { canOpenSessionWindow, openSessionInNewWindow } from '@/store/windows'

// Row action set (ported/adapted from desktop `session-actions-menu.tsx`).
// Shared by the kebab DropdownMenu and the right-click ContextMenu.
// FIXME(sidebar): Export (H4) and Branch-from (H5) are intentionally omitted —
// gated to their tracks. Open-in-new-window (MJX-104) is wired below on desktop.

interface SessionActions {
  sessionId: string
  title: string
  pinned?: boolean
  onPin?: () => void
  onArchive?: () => void
  onDelete?: () => void
  /** Branch this conversation into a new chat. */
  onBranch?: () => void
  // TAB verbs — only present for a tile/tab (a sidebar row is not a tab). Their
  // presence adds the tab close group (Close / Close others / Close to the
  // right / Close all), mirroring desktop's `SessionTabMenu`.
  onClose?: () => void
  onCloseOthers?: () => void
  onCloseToRight?: () => void
  onCloseAll?: () => void
}

type MenuItemComponent = typeof DropdownMenuItem | typeof ContextMenuItem

interface ItemSpec {
  className?: string
  disabled: boolean
  icon: string
  label: string
  onSelect: (event: Event) => void
  variant?: 'destructive'
}

function useSessionActions({
  sessionId,
  title,
  pinned = false,
  onPin,
  onArchive,
  onDelete,
  onBranch,
  onClose,
  onCloseOthers,
  onCloseToRight,
  onCloseAll
}: SessionActions) {
  const { t } = useI18n()
  const r = t.sidebar.row
  const activeStoredId = useStore($activeStoredSessionId)
  const [renameOpen, setRenameOpen] = useState(false)

  // "Open in bubble" (mobile) / "Open in tile" (desktop) is meaningless for the
  // session already loaded in the workspace — hide it there.
  const isActiveSession = Boolean(sessionId) && sessionId === activeStoredId

  const specs: ItemSpec[] = [
    {
      disabled: !onPin,
      icon: 'pin',
      label: pinned ? r.unpin : r.pin,
      onSelect: () => {
        void triggerHaptic('selection')
        onPin?.()
      }
    },
    {
      disabled: !sessionId,
      icon: 'copy',
      label: r.copyId,
      onSelect: () => {
        void navigator.clipboard?.writeText(sessionId).catch(err => notifyError(err, r.copyIdFailed))
      }
    },
    // Open this conversation ALONGSIDE the main thread — a mobile "bubble" (a
    // parallel chat in the composer strip) or a desktop layout tile. Omitted for
    // the active session (it's already on screen).
    ...(isActiveSession
      ? []
      : [
          {
            disabled: !sessionId,
            icon: IS_MOBILE ? 'comment' : 'split-horizontal',
            label: IS_MOBILE ? r.openInBubble : r.openInTile,
            onSelect: () => {
              void triggerHaptic('selection')

              if (IS_MOBILE) {
                addBubble(sessionId)
              } else {
                openSessionTile(sessionId, 'right')
              }
            }
          }
        ]),
    // Pop this conversation out into its own native window (desktop only —
    // gated by canOpenSessionWindow; MJX-104).
    ...(canOpenSessionWindow()
      ? [
          {
            disabled: !sessionId,
            icon: 'link-external',
            label: r.newWindow,
            onSelect: () => {
              void triggerHaptic('selection')
              void openSessionInNewWindow(sessionId)
            }
          }
        ]
      : []),
    {
      disabled: !sessionId,
      icon: 'edit',
      label: r.rename,
      onSelect: () => {
        void triggerHaptic('selection')
        setRenameOpen(true)
      }
    },
    // Branch — only offered where a branch handler is wired (a tile tab). A
    // plain sidebar row doesn't pass one, so its menu is unchanged.
    ...(onBranch
      ? [
          {
            disabled: false,
            icon: 'git-branch',
            label: r.branchFrom,
            onSelect: () => {
              void triggerHaptic('selection')
              onBranch()
            }
          }
        ]
      : []),
    {
      disabled: !onArchive,
      icon: 'archive',
      label: r.archive,
      onSelect: () => {
        void triggerHaptic('selection')
        onArchive?.()
      }
    },
    {
      className: 'text-destructive focus:text-destructive',
      disabled: !onDelete,
      icon: 'trash',
      label: t.common.delete,
      onSelect: () => {
        void triggerHaptic('warning')
        onDelete?.()
      },
      variant: 'destructive'
    },
    // TAB close verbs — only when this menu wraps a tab (a tile/workspace), so
    // the sidebar-row menu never grows a Close it can't honor. Each verb appears
    // only where its handler is wired: the uncloseable workspace tab omits
    // `onClose`, so it keeps Close others / to the right / all without Close.
    ...(onClose
      ? [
          {
            disabled: false,
            icon: 'close',
            label: t.common.close,
            onSelect: () => {
              void triggerHaptic('selection')
              onClose()
            }
          }
        ]
      : []),
    ...(onCloseOthers
      ? [
          {
            disabled: false,
            icon: 'close-all',
            label: t.zones.closeOthers,
            onSelect: () => {
              void triggerHaptic('selection')
              onCloseOthers()
            }
          }
        ]
      : []),
    ...(onCloseToRight
      ? [
          {
            disabled: false,
            icon: 'arrow-right',
            label: t.zones.closeToRight,
            onSelect: () => {
              void triggerHaptic('selection')
              onCloseToRight()
            }
          }
        ]
      : []),
    ...(onCloseAll
      ? [
          {
            disabled: false,
            icon: 'clear-all',
            label: t.zones.closeAll,
            onSelect: () => {
              void triggerHaptic('selection')
              onCloseAll()
            }
          }
        ]
      : [])
  ]

  const renderItems = (Item: MenuItemComponent) => (
    <>
      {specs.map(({ className, disabled, icon, label, onSelect, variant }) => (
        <Item className={className} disabled={disabled} key={label} onSelect={onSelect} variant={variant}>
          <Codicon name={icon} size="0.875rem" />
          <span>{label}</span>
        </Item>
      ))}
    </>
  )

  const renameDialog = (
    <RenameSessionDialog currentTitle={title} onOpenChange={setRenameOpen} open={renameOpen} sessionId={sessionId} />
  )

  return { renameDialog, renderItems }
}

interface SessionActionsMenuProps extends SessionActions {
  children: React.ReactNode
}

export function SessionActionsMenu({ children, ...actions }: SessionActionsMenuProps) {
  const { t } = useI18n()
  const { renameDialog, renderItems } = useSessionActions(actions)

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
        <DropdownMenuContent align="end" aria-label={t.sidebar.row.actionsFor(actions.title)} className="w-40">
          {renderItems(DropdownMenuItem)}
        </DropdownMenuContent>
      </DropdownMenu>
      {renameDialog}
    </>
  )
}

interface SessionContextMenuProps extends SessionActions {
  children: React.ReactNode
}

export function SessionContextMenu({ children, ...actions }: SessionContextMenuProps) {
  const { t } = useI18n()
  const { renameDialog, renderItems } = useSessionActions(actions)

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent aria-label={t.sidebar.row.actionsFor(actions.title)} className="w-40">
          {renderItems(ContextMenuItem)}
        </ContextMenuContent>
      </ContextMenu>
      {renameDialog}
    </>
  )
}

interface RenameSessionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sessionId: string
  currentTitle: string
}

function RenameSessionDialog({ open, onOpenChange, sessionId, currentTitle }: RenameSessionDialogProps) {
  const { t } = useI18n()
  const r = t.sidebar.row
  const [value, setValue] = useState(currentTitle)
  const [submitting, setSubmitting] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setValue(currentTitle)
      window.setTimeout(() => inputRef.current?.select(), 0)
    }
  }, [currentTitle, open])

  const submit = async () => {
    const next = value.trim()

    if (!sessionId || submitting || next === currentTitle.trim()) {
      onOpenChange(false)

      return
    }

    setSubmitting(true)

    try {
      await renameSessionLocal(sessionId, next)
      notify({ durationMs: 2_000, kind: 'success', message: r.renamed })
      onOpenChange(false)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{r.renameTitle}</DialogTitle>
          <DialogDescription>{r.renameDesc}</DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          disabled={submitting}
          onChange={event => setValue(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void submit()
            } else if (event.key === 'Escape') {
              onOpenChange(false)
            }
          }}
          placeholder={r.untitledPlaceholder}
          ref={inputRef}
          value={value}
        />
        <DialogFooter>
          <Button disabled={submitting} onClick={() => onOpenChange(false)} type="button" variant="ghost">
            {t.common.cancel}
          </Button>
          <Button disabled={submitting} onClick={() => void submit()} type="button">
            {t.common.save}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
