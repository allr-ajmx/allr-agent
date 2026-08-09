import { useEffect } from 'react'

import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import { $activeTerminalId, $terminals, ensureTerminal } from '@/store/terminals'

import { TerminalRail } from './terminal-rail'
import { TerminalView } from './terminal-view'

// The terminal area for the bottom-row pane (spans the whole right side). The
// terminal content fills the left; the vertical tab rail sits on the right. All
// open shells stay mounted (kept alive across tab switches); only the active one
// is visible (`invisible` keeps layout so xterm's fit stays correct off-screen).
export function TerminalArea() {
  const terminals = useStore($terminals)
  const activeId = useStore($activeTerminalId)

  // Opening the area spawns a first terminal if none exists.
  useEffect(() => {
    ensureTerminal()
  }, [])

  return (
    <div className="flex h-full min-h-0 bg-(--ui-editor-surface-background) border-r">
      <div className="relative min-w-0 flex-1">
        {terminals.map(term => (
          <div className={cn('absolute inset-0', term.id !== activeId && 'invisible')} key={term.id}>
            <TerminalView id={term.id} />
          </div>
        ))}
      </div>
      <TerminalRail />
    </div>
  )
}
