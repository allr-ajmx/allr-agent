import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Archive, MoreVertical, Pencil, Trash } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { archiveSessionLocal, deleteSessionLocal, openSession, renameSessionLocal } from '@/store/session'
import type { SessionInfo } from '@/types/hermes'

function relTime(value: number): string {
  if (!value) {
    return ''
  }

  const ms = value < 1e12 ? value * 1000 : value
  const diff = Date.now() - ms
  const minutes = Math.floor(diff / 60_000)

  if (minutes < 1) {
    return 'just now'
  }

  if (minutes < 60) {
    return `${minutes}m ago`
  }

  const hours = Math.floor(minutes / 60)

  if (hours < 24) {
    return `${hours}h ago`
  }

  return `${Math.floor(hours / 24)}d ago`
}

export function SessionRow({ session, active, onOpen }: { session: SessionInfo; active: boolean; onOpen: () => void }) {
  const [renaming, setRenaming] = useState(false)
  const [title, setTitle] = useState('')

  const open = () => {
    void openSession(session.id)
    onOpen()
  }

  return (
    <div className={cn('flex items-center gap-1 rounded-md pe-1 hover:bg-accent', active && 'bg-accent')}>
      <button className="min-w-0 flex-1 px-3 py-2.5 text-start" onClick={open} type="button">
        <div className="flex items-center gap-2">
          {session.is_active && <span className="size-2 shrink-0 rounded-full bg-[var(--ui-green)]" />}
          <span className="truncate text-sm font-medium text-foreground">{session.title || 'Untitled'}</span>
        </div>
        <div className="text-xs text-muted-foreground">
          {relTime(session.last_active)} · {session.message_count} msg
        </div>
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button aria-label="Session actions" size="icon-sm" variant="ghost">
            <MoreVertical className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem
            onSelect={() => {
              setTitle(session.title ?? '')
              setRenaming(true)
            }}
          >
            <Pencil className="size-4" />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void archiveSessionLocal(session.id)}>
            <Archive className="size-4" />
            Archive
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void deleteSessionLocal(session.id)} variant="destructive">
            <Trash className="size-4" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog onOpenChange={setRenaming} open={renaming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename session</DialogTitle>
          </DialogHeader>
          <Input autoFocus onChange={e => setTitle(e.target.value)} value={title} />
          <DialogFooter>
            <Button onClick={() => setRenaming(false)} variant="text">
              Cancel
            </Button>
            <Button
              disabled={!title.trim()}
              onClick={() => {
                void renameSessionLocal(session.id, title.trim())
                setRenaming(false)
              }}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
