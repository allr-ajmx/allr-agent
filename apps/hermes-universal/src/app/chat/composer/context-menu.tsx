import { useEffect, useState } from 'react'

import { composerPanelCard } from '@/components/chat/composer-dock'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Kbd } from '@/components/ui/kbd'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import {
  ChevronLeft,
  Clipboard,
  FileText,
  FolderOpen,
  Globe,
  type IconComponent,
  ImageIcon,
  Link,
  MessageSquareText,
  Monitor
} from '@/lib/icons'
import { cn } from '@/lib/utils'
import { setAttachmentMenuDropdownOpen } from '@/store/composer'

import { useComposerAttachmentProviders } from './contrib'
import { GHOST_ICON_BTN } from './controls'
import type { ChatBarState } from './types'

const SNIPPET_KEYS = ['codeReview', 'implementationPlan', 'explainThis']

/** What the root `Files…` / `Folder…` row does when clicked.
 *
 *  Both handlers present → fan out to the `← Back / Local… / Remote…` view.
 *  Exactly one → run it, no detour: a two-item choice with one item permanently
 *  greyed out reads as a bug, and it is a real state — off a local-mode gateway
 *  the composer withholds the LOCAL folder pick, because a local path is not the
 *  folder the backend would resolve (see chat-composer.tsx). */
export type AttachRoute = { kind: 'fan-out' } | { kind: 'none' } | { kind: 'run'; run: (event: Event) => void }

export function attachRoute(local?: (event: Event) => void, remote?: (event: Event) => void): AttachRoute {
  if (local && remote) {
    return { kind: 'fan-out' }
  }

  const only = local ?? remote

  return only ? { kind: 'run', run: only } : { kind: 'none' }
}

export function ContextMenu({
  state,
  onInsertText,
  onOpenUrlDialog,
  onPasteClipboardImage,
  onPickFiles,
  onPickFolders,
  onPickImages,
  onPickRemoteFiles,
  onPickRemoteFolders
}: ContextMenuProps) {
  const { t } = useI18n()
  const c = t.composer
  // Prompt snippets used to be a Radix submenu. That submenu didn't open
  // reliably when the parent menu was positioned at the bottom of the
  // window (composer "+" anchor), so we promoted it to a real Dialog —
  // easier to grow with search / descriptions, and no positioning math.
  const [snippetsOpen, setSnippetsOpen] = useState(false)
  // Files/Folder each fan out to Local (OS dialog) vs Remote (backend fs
  // browser). Same submenu-positioning bug as snippets, so instead of a Radix
  // sub the menu content swaps in place and Back returns to the root view.
  const [view, setView] = useState<'root' | 'files' | 'folder'>('root')
  const [open, setOpen] = useState(false)
  const isHud = typeof document !== 'undefined' && document.documentElement.hasAttribute('data-hud')

  useEffect(() => {
    return () => {
      setAttachmentMenuDropdownOpen(false)
    }
  }, [])

  // `composer.attachments` contributions — plugin/core-registered rows that
  // extend this menu through the same registry as every other surface.
  const attachmentProviders = useComposerAttachmentProviders()

  // Keep the dropdown open while stepping between views.
  const stay = (fn: () => void) => (event: Event) => {
    event.preventDefault()
    fn()
  }

  const filesRoute = attachRoute(onPickFiles, onPickRemoteFiles)
  const folderRoute = attachRoute(onPickFolders, onPickRemoteFolders)

  // The root row either steps into the Local/Remote view or runs the only pick
  // that exists. `stay` (preventDefault) is for the step; a real pick closes the
  // menu, exactly as `Images…`/`URL…` do.
  const rootSelect = (route: AttachRoute, view: 'files' | 'folder') =>
    route.kind === 'fan-out' ? stay(() => setView(view)) : route.kind === 'run' ? route.run : undefined

  return (
    <>
      <DropdownMenu
        onOpenChange={isOpen => {
          setOpen(isOpen)

          if (!isOpen) {
            setView('root')
          }

          setAttachmentMenuDropdownOpen(isOpen)
        }}
        open={open}
      >
        <Tip label={state.tools.label} side="top">
          <DropdownMenuTrigger asChild>
            <Button
              aria-label={state.tools.label}
              className={cn(
                GHOST_ICON_BTN,
                'data-[state=open]:bg-(--chrome-action-hover) data-[state=open]:text-foreground'
              )}
              disabled={!state.tools.enabled}
              size="icon"
              type="button"
              variant="ghost"
            >
              <Codicon name="add" size="0.875rem" />
            </Button>
          </DropdownMenuTrigger>
        </Tip>
        <DropdownMenuContent
          align="start"
          className={cn('w-60', composerPanelCard)}
          side={isHud ? 'bottom' : 'top'}
          sideOffset={isHud ? 8 : 6}
        >
          {view !== 'root' ? (
            <>
              <DropdownMenuLabel className="px-2 pb-0.5 pt-0.5 text-[0.625rem] font-semibold uppercase tracking-wider text-(--ui-text-tertiary)">
                {view === 'files' ? c.files : c.folder}
              </DropdownMenuLabel>
              <ContextMenuItem icon={ChevronLeft} onSelect={stay(() => setView('root'))}>
                {c.back}
              </ContextMenuItem>

              <DropdownMenuSeparator />

              <ContextMenuItem
                disabled={view === 'files' ? !onPickFiles : !onPickFolders}
                icon={Monitor}
                onSelect={view === 'files' ? onPickFiles : onPickFolders}
              >
                {c.local}
              </ContextMenuItem>
              <ContextMenuItem
                disabled={view === 'files' ? !onPickRemoteFiles : !onPickRemoteFolders}
                icon={Globe}
                onSelect={view === 'files' ? onPickRemoteFiles : onPickRemoteFolders}
              >
                {c.remote}
              </ContextMenuItem>
            </>
          ) : (
            <>
              <DropdownMenuLabel className="px-2 pb-0.5 pt-0.5 text-[0.625rem] font-semibold uppercase tracking-wider text-(--ui-text-tertiary)">
                {c.attachLabel}
              </DropdownMenuLabel>
              <ContextMenuItem
                disabled={filesRoute.kind === 'none'}
                icon={FileText}
                onSelect={rootSelect(filesRoute, 'files')}
              >
                {c.files}
              </ContextMenuItem>
              <ContextMenuItem
                disabled={folderRoute.kind === 'none'}
                icon={FolderOpen}
                onSelect={rootSelect(folderRoute, 'folder')}
              >
                {c.folder}
              </ContextMenuItem>
              <ContextMenuItem disabled={!onPickImages} icon={ImageIcon} onSelect={onPickImages}>
                {c.images}
              </ContextMenuItem>
              <ContextMenuItem
                disabled={!onPasteClipboardImage}
                icon={Clipboard}
                onSelect={onPasteClipboardImage ? () => void onPasteClipboardImage() : undefined}
              >
                {c.pasteImage}
              </ContextMenuItem>
              <ContextMenuItem icon={Link} onSelect={onOpenUrlDialog}>
                {c.url}
              </ContextMenuItem>

              <DropdownMenuSeparator />

              <ContextMenuItem icon={MessageSquareText} onSelect={() => setSnippetsOpen(true)}>
                {c.promptSnippets}
              </ContextMenuItem>

              {attachmentProviders.length > 0 && <DropdownMenuSeparator />}
              {attachmentProviders.map(provider => (
                <DropdownMenuItem
                  className="text-[length:var(--conversation-tool-font-size)] focus:bg-(--ui-bg-tertiary)"
                  key={provider.key}
                  onSelect={() => void provider.run({ insertText: onInsertText })}
                >
                  <Codicon name={provider.icon ?? 'plug'} size="0.875rem" />
                  <span>{provider.label}</span>
                </DropdownMenuItem>
              ))}

              <DropdownMenuSeparator />

              <div className="px-2 py-1 text-[0.7rem] text-muted-foreground/80">
                {c.tipPre}
                <Kbd size="sm">@</Kbd>
                {c.tipPost}
              </div>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <PromptSnippetsDialog onInsertText={onInsertText} onOpenChange={setSnippetsOpen} open={snippetsOpen} />
    </>
  )
}

function PromptSnippetsDialog({ onInsertText, onOpenChange, open }: PromptSnippetsDialogProps) {
  const { t } = useI18n()
  const c = t.composer

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-md gap-3">
        <DialogHeader>
          <DialogTitle>{c.snippetsTitle}</DialogTitle>
          <DialogDescription>{c.snippetsDesc}</DialogDescription>
        </DialogHeader>
        <ul className="grid gap-1">
          {SNIPPET_KEYS.map(key => {
            const snippet = c.snippets[key]

            return (
              <li key={key}>
                <button
                  className="group/snippet flex w-full cursor-pointer items-start gap-2.5 rounded-md border border-transparent px-2.5 py-2 text-start transition-colors hover:border-(--ui-stroke-tertiary) hover:bg-(--ui-control-hover-background) focus-visible:border-(--ui-stroke-tertiary) focus-visible:bg-(--ui-control-hover-background) focus-visible:outline-none"
                  onClick={() => {
                    onInsertText(snippet.text)
                    onOpenChange(false)
                  }}
                  type="button"
                >
                  <MessageSquareText className="mt-0.5 size-3.5 shrink-0 text-(--ui-text-tertiary) group-hover/snippet:text-foreground" />
                  <span className="grid min-w-0 gap-0.5">
                    <span className="text-sm font-medium text-foreground">{snippet.label}</span>
                    <span className="text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
                      {snippet.description}
                    </span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </DialogContent>
    </Dialog>
  )
}

export function ContextMenuItem({ children, disabled, icon: Icon, onSelect }: ContextMenuItemProps) {
  return (
    // Override font size + highlight to match the / · @ completion rows exactly.
    <DropdownMenuItem
      className="text-[length:var(--conversation-tool-font-size)] focus:bg-(--ui-bg-tertiary)"
      disabled={disabled}
      onSelect={onSelect}
    >
      <Icon />
      <span>{children}</span>
    </DropdownMenuItem>
  )
}

interface ContextMenuItemProps {
  children: string
  disabled?: boolean
  icon: IconComponent
  onSelect?: (event: Event) => void
}

interface ContextMenuProps {
  onInsertText: (text: string) => void
  onOpenUrlDialog: () => void
  onPasteClipboardImage?: (opts?: { silent?: boolean }) => Promise<boolean> | void
  onPickFiles?: () => void
  onPickFolders?: () => void
  onPickImages?: () => void
  onPickRemoteFiles?: () => void
  onPickRemoteFolders?: () => void
  state: ChatBarState
}

interface PromptSnippetsDialogProps {
  onInsertText: (text: string) => void
  onOpenChange: (open: boolean) => void
  open: boolean
}
