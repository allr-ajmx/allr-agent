import { useStore } from '@nanostores/react'
import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useRef, useState } from 'react'

import { CONTEXT_KIT, DROPDOWN_KIT, type MenuKit } from '@/components/ui/actions-menu'
import { Codicon } from '@/components/ui/codicon'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { translateNow, useI18n } from '@/i18n'
import { isDesktopFsRemoteMode } from '@/lib/desktop-fs'
import { IS_MAC } from '@/lib/keybinds/combo'
import { cn } from '@/lib/utils'
import {
  $fileActionDialog,
  beginInlineRename,
  cancelInlineRename,
  closeFileActionDialog,
  copyFilePath,
  executeFileDelete,
  executeFileRename,
  type FileActionTarget,
  requestFileDelete,
  revealFile,
  toRelativePath
} from '@/store/file-actions'
import { notifyError } from '@/store/notifications'

const IS_WIN = typeof navigator !== 'undefined' && /win/i.test(navigator.platform || navigator.userAgent || '')

// F2 starts a rename anywhere; Enter starts one when a row is focused (VS Code).
export function isRenameShortcut(event: KeyboardEvent | ReactKeyboardEvent): boolean {
  return event.key === 'F2' || event.key === 'Enter'
}

/** The platform-appropriate "reveal in file manager" label (Finder / Explorer
 *  / containing folder). Shared so every file menu reads consistently. */
export function pickRevealLabel(finder: string, explorer: string, fileManager: string): string {
  return IS_MAC ? finder : IS_WIN ? explorer : fileManager
}

export interface FileEntryTarget {
  isDirectory: boolean
  /** Display name (basename). */
  name: string
  /** Absolute path on disk. */
  path: string
  /** Base dir for "Copy Relative Path" (the cwd / repo root). Omit to hide it. */
  relativeTo?: null | string
}

/**
 * The file entry's actions, as a render function both menu flavours can use.
 *
 * Right-click was the only way to reach any of this, which on a phone means
 * reveal / copy path / rename / delete simply did not exist. Defining the rows
 * once and handing them to both the context menu and the kebab is what keeps
 * the two provably identical instead of two lists that drift.
 */
export function fileEntryMenuItems(
  { isDirectory, name, path, relativeTo }: FileEntryTarget,
  m: ReturnType<typeof useI18n>['t']['fileMenu']
): (kit: MenuKit) => ReactNode {
  // Reveal / rename / delete need the local filesystem; hide them on a remote
  // backend (copy-path still works everywhere).
  const localFs = !isDesktopFsRemoteMode()
  const target: FileActionTarget = { isDirectory, name, path }
  const revealLabel = pickRevealLabel(m.revealFinder, m.revealExplorer, m.revealFileManager)

  return (kit: MenuKit) => (
    <>
      {localFs && (
        <>
          <kit.Item onSelect={() => void revealFile(path)}>{revealLabel}</kit.Item>
          <kit.Separator />
        </>
      )}
      <kit.Item onSelect={() => void copyFilePath(path)}>{m.copyPath}</kit.Item>
      {relativeTo && (
        <kit.Item onSelect={() => void copyFilePath(toRelativePath(path, relativeTo))}>{m.copyRelativePath}</kit.Item>
      )}
      {localFs && (
        <>
          <kit.Separator />
          <kit.Item onSelect={() => beginInlineRename(path)}>{m.rename}</kit.Item>
          <kit.Item onSelect={() => requestFileDelete(target)} variant="destructive">
            {m.delete}
          </kit.Item>
        </>
      )}
    </>
  )
}

interface FileEntryContextMenuProps extends FileEntryTarget {
  children: ReactNode
}

/** Right-click menu shared by both file trees (browser + review/git). */
export function FileEntryContextMenu({ children, ...target }: FileEntryContextMenuProps) {
  const { t } = useI18n()
  const items = fileEntryMenuItems(target, t.fileMenu)

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      {/* Don't restore focus to the row on close: "Rename" mounts an autofocused
          inline input, and the default focus-return would blur it immediately. */}
      <ContextMenuContent onCloseAutoFocus={event => event.preventDefault()}>{items(CONTEXT_KIT)}</ContextMenuContent>
    </ContextMenu>
  )
}

/**
 * The same actions as a kebab button, for pointers that cannot right-click.
 *
 * Hidden until the row is hovered on a fine pointer — a permanent ⋯ on every
 * row of a dense desktop tree is noise — and simply present on a coarse one,
 * where it is the only door to these actions.
 *
 * Deliberately NOT built on `ActionsMenu`: that wrapper does not forward
 * `onCloseAutoFocus`, and without it "Rename" mounts its autofocused input and
 * the menu's focus-return blurs it on the same tick. The shared `items` above
 * is what keeps this and the context menu in step, not a shared container.
 */
export function FileEntryActionsMenu({ className, ...target }: FileEntryTarget & { className?: string }) {
  const { t } = useI18n()
  const items = fileEntryMenuItems(target, t.fileMenu)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label={t.fileMenu.actions}
          className={cn(
            'grid size-5 shrink-0 place-items-center rounded-sm text-(--ui-text-tertiary) transition-opacity hover:bg-(--ui-control-hover-background) hover:text-foreground',
            // A 20px target is a mouse target. On a coarse pointer this is the
            // ONLY door to rename/delete/reveal, and it swallows the row's own
            // press — so it has to be a deliberate target, not an accidental
            // one. `size-11` is 44px; the glyph inside keeps its size.
            'coarse:size-11',
            'fine:opacity-0 fine:group-hover/row:opacity-100 fine:group-focus-within/row:opacity-100 fine:data-[state=open]:opacity-100',
            className
          )}
          // The tree row navigates on click and starts a drag on pointerdown;
          // neither should happen because the kebab was pressed.
          onClick={event => event.stopPropagation()}
          onPointerDown={event => event.stopPropagation()}
          type="button"
        >
          <Codicon name="kebab-vertical" size="0.875rem" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onCloseAutoFocus={event => event.preventDefault()} sideOffset={4}>
        {items(DROPDOWN_KIT)}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Mounted once near the app root: the delete confirm dialog for shared file
 *  actions. Rename is inline (see {@link InlineRenameInput}). */
export function FileActionDialogs() {
  const { t } = useI18n()
  const dialog = useStore($fileActionDialog)
  const deleting = dialog?.kind === 'delete'

  return (
    <ConfirmDialog
      confirmLabel={t.fileMenu.delete}
      description={t.fileMenu.deleteBody}
      destructive
      onClose={closeFileActionDialog}
      onConfirm={() => {
        if (deleting) {
          return executeFileDelete(dialog.path)
        }
      }}
      open={deleting}
      title={deleting ? t.fileMenu.deleteTitle(dialog.name) : ''}
    />
  )
}

interface InlineRenameInputProps {
  className?: string
  /** Display name (basename) to seed the editor. */
  name: string
  /** Absolute path being renamed. */
  path: string
}

/** The in-row rename editor (VS Code style): seeded with the name (stem
 *  pre-selected), commits on Enter/blur, cancels on Esc. Render it in place of a
 *  row's label when `$renamingPath === path`. */
export function InlineRenameInput({ className, name, path }: InlineRenameInputProps) {
  const [value, setValue] = useState(name)
  // Enter then the resulting blur must not both commit; latch on first finish.
  const done = useRef(false)
  // Focus churn right after mount (context-menu close, arborist refocus, the
  // fall-through click on the row) would blur→commit→cancel instantly; ignore
  // blurs in this window and grab focus back instead.
  const mountedAt = useRef(Date.now())

  const finish = async (commit: boolean) => {
    if (done.current) {
      return
    }

    done.current = true
    const next = value.trim()

    if (commit && next && next !== name) {
      try {
        await executeFileRename(path, next)
      } catch (error) {
        notifyError(error, translateNow('errors.genericFailure'))
      }
    }

    cancelInlineRename()
  }

  return (
    <input
      aria-label={translateNow('fileMenu.renameLabel')}
      autoCapitalize="off"
      autoComplete="off"
      autoCorrect="off"
      autoFocus
      className={cn(
        'min-w-0 flex-1 rounded-sm border border-[color-mix(in_srgb,var(--dt-composer-ring)_55%,transparent)] bg-(--ui-bg-elevated) px-1 py-0 text-xs text-foreground outline-none',
        className
      )}
      onBlur={event => {
        if (Date.now() - mountedAt.current < 250) {
          event.currentTarget.focus()

          return
        }

        void finish(true)
      }}
      onChange={event => setValue(event.target.value)}
      onClick={event => event.stopPropagation()}
      onDoubleClick={event => event.stopPropagation()}
      onFocus={event => {
        const dot = event.currentTarget.value.lastIndexOf('.')
        event.currentTarget.setSelectionRange(0, dot > 0 ? dot : event.currentTarget.value.length)
      }}
      onKeyDown={event => {
        event.stopPropagation()

        if (event.key === 'Enter') {
          event.preventDefault()
          void finish(true)
        } else if (event.key === 'Escape') {
          event.preventDefault()
          void finish(false)
        }
      }}
      spellCheck={false}
      value={value}
    />
  )
}
