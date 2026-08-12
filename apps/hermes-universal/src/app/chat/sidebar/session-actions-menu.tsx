import type * as React from 'react'
import { useEffect, useRef, useState } from 'react'

import {
  type ActionItemSpec,
  CONTEXT_KIT,
  DROPDOWN_KIT,
  type MenuKit,
  renderActionItem
} from '@/components/ui/actions-menu'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { ColorSwatches } from '@/components/ui/color-swatches'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { type PaneTabCloseItemsOptions, paneTabCloseSpecs } from '@/components/ui/pane-tab'
import { useI18n } from '@/i18n'
import { writeClipboardText } from '@/lib/clipboard'
import { triggerHaptic } from '@/lib/haptics'
import { IS_MOBILE } from '@/lib/platform'
import { PROFILE_SWATCHES } from '@/lib/profile-color'
import { useStore } from '@/store/atom'
import { addBubble } from '@/store/chat-bubbles'
import { notify, notifyError } from '@/store/notifications'
import { $projects, moveSessionToProject } from '@/store/projects'
import { $activeStoredSessionId, renameSessionLocal } from '@/store/session'
import { $sessionColorOverrides, setSessionColorOverride } from '@/store/session-color'
import { useSessionRowScalars } from '@/store/session-lookup'
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
  /** TAB verbs — set only for a tile/workspace tab (a sidebar row is not a tab).
   *  Present, this menu grows Reload plus the shared four-verb close group from
   *  `paneTabCloseSpecs`, so a session tab answers a right-click with the same
   *  rows, in the same order, disabled the same way, as every other tab in the
   *  app. Before MJXHRM-409 this file hand-rolled its own copy of that group. */
  tab?: {
    close: PaneTabCloseItemsOptions
    /** Re-mount what is IN the tab — the zone menu's Reload, reachable from the
     *  tab itself. Right-clicking a session tab opens THIS menu, not the zone's
     *  (the tab is wrapped in its own trigger), so without it Reload was
     *  unreachable from the one surface it names. */
    onReload: () => void
  }
}

// The color picker inside the session menu's Appearance submenu. Its own
// component so only an OPEN submenu subscribes to the stores (not every row's
// menu). Reads/writes the override keyed by the DURABLE id so a color survives
// compression; clearing falls back to the inherited project color.
function SessionColorSwatches({ sessionId }: { sessionId: string }) {
  const { t } = useI18n()
  const overrides = useStore($sessionColorOverrides)
  // The WIDE lookup, not `$sessions` alone (MJXHRM-386). `$sessions` is the
  // paginated recents page, so for a session that had aged out of it the
  // durable id fell back to the RAW id the caller was holding — while
  // `resolveSessionColor` reads the override under `sessionPinId(session)`, the
  // lineage root. For a conversation that has been auto-compacted those are
  // DIFFERENT ids, so a colour picked for an older chat landed under a key
  // nothing reads: the swatch showed nothing selected, the colour never
  // appeared on any dot, and the dead entry persisted to disk forever.
  //
  // The same widening `tileTitle`, `TileTabLead` and the tab menu already took
  // — and it is what makes "a colour is a function of a stable identity" true
  // on the WRITE side, not only the read side.
  //
  // `useSessionRowScalars`, not `useSessionRow`: this needs one string, and one
  // of these lives inside every open session menu. `pinId` is that string
  // already, computed by the same rule the pin verbs use.
  const durableId = useSessionRowScalars(sessionId).pinId

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

/** A submenu entry in the otherwise-flat spec list, so its position stays
 *  declarative alongside the plain items rather than hard-coded in the render. */
interface SubSpec {
  disabled: boolean
  icon: string
  kind: 'sub'
  label: string
  /** Padding for the submenu body — a swatch GRID wants it, a list of menu
   *  items must not have it or the rows inset away from the trigger. */
  contentClassName?: string
  /** Handed the kit so a submenu can render real menu items (the project list)
   *  rather than only custom chrome (the color swatches). */
  render: (kit: MenuKit) => React.ReactNode
}

// The plain rows are `ActionItemSpec`, the same shape `paneTabCloseSpecs`
// returns and `renderActionItem` consumes — so the shared close verbs drop
// straight into this list instead of being retyped into a local lookalike.
type MenuSpec = ActionItemSpec | SubSpec

const isSub = (spec: MenuSpec): spec is SubSpec => 'kind' in spec

/** Every row in this menu buzzes before it acts; `paneTabCloseSpecs` knows
 *  nothing about haptics, so the callbacks are wrapped on the way in. */
const haptic = (run: () => void) => () => {
  void triggerHaptic('selection')
  run()
}

function useSessionActions({
  sessionId,
  title,
  pinned = false,
  onPin,
  onArchive,
  onDelete,
  onBranch,
  tab
}: SessionActions) {
  const { t } = useI18n()
  const r = t.sidebar.row
  const activeStoredId = useStore($activeStoredSessionId)
  const projects = useStore($projects)
  const [renameOpen, setRenameOpen] = useState(false)

  // Destinations for a move: a project's primary folder, else its first. A
  // project with no folder has no directory to adopt, so it is not offered.
  const moveTargets = projects
    .filter(project => !project.archived)
    .map(project => ({
      name: project.name,
      path: project.primary_path ?? project.folders?.[0]?.path ?? ''
    }))
    .filter(target => target.path)

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
        void writeClipboardText(sessionId).catch(err => notifyError(err, r.copyIdFailed))
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
      contentClassName: 'p-2',
      label: t.sidebar.projects.menuAppearance,
      render: () => <SessionColorSwatches sessionId={sessionId} />
    },
    // Move to another project — a chat created in the wrong directory is
    // re-homed rather than recreated, so it keeps its history. Only offered when
    // there is somewhere to move it TO: a folderless project has no cwd to
    // adopt, so it is not a destination.
    ...(moveTargets.length > 0
      ? [
          {
            disabled: !sessionId,
            icon: 'folder-library',
            kind: 'sub' as const,
            label: t.sidebar.row.moveToProject,
            render: (kit: MenuKit) => (
              <>
                {moveTargets.map(target => (
                  <kit.Item
                    key={target.path}
                    onSelect={() => {
                      void triggerHaptic('selection')
                      void moveSessionToProject(sessionId, target.path)
                    }}
                  >
                    <Codicon name="folder" size="0.875rem" />
                    <span className="truncate">{target.name}</span>
                  </kit.Item>
                ))}
              </>
            )
          }
        ]
      : []),
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
    // TAB verbs — only when this menu wraps a tab (a tile/workspace), so the
    // sidebar-row menu never grows a Close it can't honor. Reload first (it
    // recovers a wedged surface, and the zone menu puts it first too), then the
    // SHARED close group, which disables the verbs that would close nothing
    // rather than dropping their rows.
    ...(tab
      ? [
          { icon: 'refresh', label: t.zones.reload, onSelect: haptic(tab.onReload) },
          ...paneTabCloseSpecs({
            counts: tab.close.counts,
            onClose: tab.close.onClose && haptic(tab.close.onClose),
            onCloseAll: haptic(tab.close.onCloseAll),
            onCloseOthers: haptic(tab.close.onCloseOthers),
            onCloseToRight: haptic(tab.close.onCloseToRight)
          })
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
            <kit.SubContent className={spec.contentClassName}>{spec.render(kit)}</kit.SubContent>
          </kit.Sub>
        ) : (
          renderActionItem(kit, spec)
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
