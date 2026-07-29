import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import { $commandMenuOpen, closeCommandMenu } from '@/store/command-menu'

import { useNavItems } from './nav-items'

// Reaches every view not on the 4-item sidebar rail. Global (mounted once in the
// controller): ⌘K / Ctrl+K toggles it, the titlebar + in-drawer buttons open it.
// A deliberately lean cmdk substitute — a filtered nav list, no extra dependency.
export function CommandMenu() {
  const open = useStore($commandMenuOpen)
  const { t } = useI18n()
  const navItems = useNavItems()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')

  // ⌘K is no longer bound here: it's the rebindable `nav.commandPalette` action,
  // dispatched by the global listener in `app/hooks/use-keybinds.ts`.

  const needle = query.trim().toLowerCase()
  const filtered = needle ? navItems.filter(item => item.label.toLowerCase().includes(needle)) : navItems

  const go = (path: string) => {
    navigate(path)
    setQuery('')
    closeCommandMenu()
  }

  return (
    <Dialog
      onOpenChange={next => {
        $commandMenuOpen.set(next)

        if (!next) {
          setQuery('')
        }
      }}
      open={open}
    >
      <DialogContent className="max-w-md gap-2 p-3">
        <DialogHeader>
          <DialogTitle className="text-sm">{t.titlebar.searchTitle}</DialogTitle>
        </DialogHeader>

        <Input
          autoFocus
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && filtered.length > 0) {
              e.preventDefault()
              go(filtered[0].path)
            }
          }}
          placeholder={t.titlebar.search}
          value={query}
        />

        <div className="flex max-h-72 flex-col gap-px overflow-y-auto">
          {filtered.map(item => {
            const Icon = item.icon

            return (
              <button
                className={cn(
                  'flex h-9 w-full items-center gap-3 rounded-md px-2.5 text-left text-sm text-muted-foreground',
                  'transition-colors hover:bg-accent hover:text-foreground'
                )}
                key={item.view}
                onClick={() => go(item.path)}
                type="button"
              >
                <Icon className="size-4 shrink-0" />
                <span className="truncate">{item.label}</span>
              </button>
            )
          })}
        </div>
      </DialogContent>
    </Dialog>
  )
}
