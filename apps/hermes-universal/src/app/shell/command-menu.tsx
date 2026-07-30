import { useState } from 'react'

import { usePaletteContributions } from '@/app/command-palette/contrib'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n'
import { type IconComponent, Plug } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import { $commandMenuOpen, closeCommandMenu } from '@/store/command-menu'
import { openAppRoute } from '@/store/windows'

import { useNavItems } from './nav-items'

/** One menu row — a core nav destination or a contributed command. */
interface CommandRow {
  key: string
  label: string
  run: () => void
  icon?: IconComponent
  keywords?: string[]
}

// Reaches every view not on the 4-item sidebar rail. Global (mounted once in the
// controller): ⌘K / Ctrl+K toggles it, the titlebar + in-drawer buttons open it.
// A deliberately lean cmdk substitute — a filtered nav list, no extra dependency.
export function CommandMenu() {
  const open = useStore($commandMenuOpen)
  const { t } = useI18n()
  const navItems = useNavItems()
  const commandContributions = usePaletteContributions()
  const [query, setQuery] = useState('')

  // ⌘K is no longer bound here: it's the rebindable `nav.commandPalette` action,
  // dispatched by the global listener in `app/hooks/use-keybinds.ts`.

  // Core nav rows, then contributed `palette` commands. A nav row navigates; a
  // contributed row runs its own `run()` — both close the menu.
  const rows: CommandRow[] = [
    ...navItems.map(item => ({
      icon: item.icon,
      key: `nav:${item.view}`,
      label: item.label,
      run: () => {
        // Promote Settings / Command Center to their native activity on Android;
        // everything else navigates in-app (openAppRoute decides).
        openAppRoute(item.path)
      }
    })),
    ...commandContributions.map(item => ({
      icon: item.icon,
      key: item.key,
      keywords: item.keywords,
      label: item.label,
      run: item.run
    }))
  ]

  const needle = query.trim().toLowerCase()

  const filtered = needle
    ? rows.filter(row =>
        [row.label, ...(row.keywords ?? [])].some(term => term.toLowerCase().includes(needle))
      )
    : rows

  const go = (row: CommandRow) => {
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
          {filtered.map(row => {
            const Icon = row.icon ?? Plug

            return (
              <button
                className={cn(
                  'flex h-9 w-full items-center gap-3 rounded-md px-2.5 text-left text-sm text-muted-foreground',
                  'transition-colors hover:bg-accent hover:text-foreground'
                )}
                key={row.key}
                onClick={() => go(row)}
                type="button"
              >
                <Icon className="size-4 shrink-0" />
                <span className="truncate">{row.label}</span>
              </button>
            )
          })}
        </div>
      </DialogContent>
    </Dialog>
  )
}
