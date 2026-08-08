import type * as React from 'react'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { ColorSwatches } from '@/components/ui/color-swatches'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import { IS_MOBILE } from '@/lib/platform'
import { PROFILE_SWATCHES } from '@/lib/profile-color'
import { useStore } from '@/store/atom'
import { addBubble } from '@/store/chat-bubbles'
import { notify, notifyError } from '@/store/notifications'
import {
  $activeStoredSessionId,
  $sessions,
  renameSessionLocal,
  sessionMatchesStoredId,
  sessionPinId
} from '@/store/session'
import { $sessionColorOverrides, setSessionColorOverride } from '@/store/session-color'
import { openSessionTile } from '@/store/session-states'
import { canOpenSessionWindow, openSessionInNewWindow } from '@/store/windows'

// Row action set (ported/adapted from desktop `session-actions-menu.tsx`).
// Shared by the kebab DropdownMenu and the right-click ContextMenu.
// Branch-from and open-in-new-window are wired below (the latter on desktop
// only). Export is reachable from the Command Center rather than this row menu
// (`lib/session-export.ts`) — see MJX-205 if it should be offered here too.

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

// The two menu surfaces this row menu renders on, reduced to the parts it uses.
// Universal wires Radix's DropdownMenu*/ContextMenu* directly (desktop has a
// MenuKit abstraction), so the kit is assembled at each call site below.
interface MenuKit {
  Item: typeof DropdownMenuItem | typeof ContextMenuItem
  Sub: typeof DropdownMenuSub | typeof ContextMenuSub
  SubContent: typeof DropdownMenuSubContent | typeof ContextMenuSubContent
  SubTrigger: typeof DropdownMenuSubTrigger | typeof ContextMenuSubTrigger
}

const DROPDOWN_KIT: MenuKit = {
  Item: DropdownMenuItem,
  Sub: DropdownMenuSub,
  SubContent: DropdownMenuSubContent,
  SubTrigger: DropdownMenuSubTrigger
}

const CONTEXT_KIT: MenuKit = {
  Item: ContextMenuItem,
  Sub: ContextMenuSub,
  SubContent: ContextMenuSubContent,
  SubTrigger: ContextMenuSubTrigger
}

// The color picker inside the session menu's Appearance submenu. Its own
// component so only an OPEN submenu subscribes to the stores (not every row's
// menu). Reads/writes the override keyed by the DURABLE id so a color survives
// compression; clearing falls back to the inherited project color.
function SessionColorSwatches({ sessionId }: { sessionId: string }) {
  const { t } = useI18n()
  const overrides = useStore($sessionColorOverrides)
  const session = useStore($sessions).find(s => sessionMatchesStoredId(s, sessionId))
  const durableId = session ? sessionPinId(session) : sessionId

  return (
    <ColorSwatches
      clearIcon="circle-slash"
      clearLabel={t.sidebar.projects.noColor}
      onChange={color => setSessionColorOverride(durableId, color)}
      swatches={PROFILE_SWATCHES}
      value={overrides[durableId] ?? null}
    />
  )
}

interface ItemSpec {
  className?: string
  disabled: boolean
  icon: string
  label: string
  onSelect: (event: Event) => void
  variant?: 'destructive'
}

/** A submenu entry in the otherwise-flat spec list, so its position stays
 *  declarative alongside the plain items rather than hard-coded in the render. */
interface SubSpec {
  disabled: boolean
  icon: string
  kind: 'sub'
  label: string
  render: () => React.ReactNode
}

type MenuSpec = ItemSpec | SubSpec

const isSub = (spec: MenuSpec): spec is SubSpec => 'kind' in spec

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

  const specs: MenuSpec[] = [
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
    // Appearance — the per-session color override. Sits with the identity verbs
    // (it names the session as much as its title does), same as desktop.
    {
      disabled: !sessionId,
      icon: 'symbol-color',
      kind: 'sub' as const,
      label: t.sidebar.projects.menuAppearance,
      render: () => <SessionColorSwatches sessionId={sessionId} />
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

  const renderItems = (kit: MenuKit) => (
    <>
      {specs.map(spec =>
        isSub(spec) ? (
          <kit.Sub key={spec.label}>
            <kit.SubTrigger disabled={spec.disabled}>
              <Codicon name={spec.icon} size="0.875rem" />
              <span>{spec.label}</span>
            </kit.SubTrigger>
            <kit.SubContent className="p-2">{spec.render()}</kit.SubContent>
          </kit.Sub>
        ) : (
          <kit.Item
            className={spec.className}
            disabled={spec.disabled}
            key={spec.label}
            onSelect={spec.onSelect}
            variant={spec.variant}
          >
            <Codicon name={spec.icon} size="0.875rem" />
            <span>{spec.label}</span>
          </kit.Item>
        )
      )}
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
          {renderItems(DROPDOWN_KIT)}
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
          {renderItems(CONTEXT_KIT)}
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
