import './nav-contrib' // side-effect: registers the app's own destinations

import { useState } from 'react'

import { type PaletteRow, usePaletteContributions } from '@/app/command-palette/contrib'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n'
import { Plug } from '@/lib/icons'
import { useKeybindHint } from '@/lib/keybinds/use-keybind-hint'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import { $commandMenuOpen, closeCommandMenu } from '@/store/command-menu'

// Reaches every view not on the 4-item sidebar rail. Global (mounted once in the
// controller): ⌘K / Ctrl+K toggles it, the titlebar + in-drawer buttons open it.
// A deliberately lean cmdk substitute — a filtered list, no extra dependency.
//
// Every row is a `palette` contribution: the app's own destinations register in
// app/shell/nav-contrib.ts (negative order, so they lead), plugins append.
export function CommandMenu() {
  const open = useStore($commandMenuOpen)
  const { t } = useI18n()
  const rows = usePaletteContributions()
  const [query, setQuery] = useState('')

  // ⌘K is no longer bound here: it's the rebindable `nav.commandPalette` action,
  // dispatched by the global listener in `app/hooks/use-keybinds.ts`.

  const needle = query.trim().toLowerCase()

  const filtered = needle
    ? rows.filter(row =>
        [row.label, ...(row.keywords ?? [])].some(term => term.toLowerCase().includes(needle))
      )
    : rows

  const go = (row: PaletteRow) => {
    setQuery('')
    closeCommandMenu()

    // After closing, so a command that opens its own dialog isn't dismissed with
    // this one. A throwing plugin command must not take the menu down with it.
    try {
      row.run()
    } catch (error) {
      console.error('[plugins] palette command failed', row.key, error)
    }
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
              go(filtered[0])
            }
          }}
          placeholder={t.titlebar.search}
          value={query}
        />

        <div className="flex max-h-72 flex-col gap-px overflow-y-auto">
          {filtered.map(row => (
            <CommandMenuRow key={row.key} onSelect={go} row={row} />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** One row. Its own component so the keybind hint can subscribe to `$bindings`
 *  per row — a rebind repaints the hint without the menu tracking action ids. */
function CommandMenuRow({ onSelect, row }: { onSelect: (row: PaletteRow) => void; row: PaletteRow }) {
  const hint = useKeybindHint(row.action ?? '')
  const Icon = row.icon ?? Plug

  return (
    <button
      className={cn(
        'flex h-9 w-full items-center gap-3 rounded-md px-2.5 text-left text-sm text-muted-foreground',
        'transition-colors hover:bg-accent hover:text-foreground'
      )}
      onClick={() => onSelect(row)}
      type="button"
    >
      <Icon className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{row.label}</span>
      {hint && <span className="shrink-0 pl-2 text-xs text-(--ui-text-quaternary)">{hint}</span>}
    </button>
  )
}
