import { useEffect } from 'react'

import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import { $activeTerminalId, $terminals, ensureTerminal, selectTerminalForCwd } from '@/store/terminals'
import { $effectiveCwd } from '@/store/workspace-events'

import { TerminalRail } from './terminal-rail'
import { TerminalView } from './terminal-view'

// The terminal area for the bottom-row pane (spans the whole right side). The
// terminal content fills the left; the vertical tab rail sits on the right. All
// open shells stay mounted (kept alive across tab switches); only the active one
// is visible (`invisible` keeps layout so xterm's fit stays correct off-screen).
export function TerminalArea() {
  const terminals = useStore($terminals)
  const activeId = useStore($activeTerminalId)
  const cwd = useStore($effectiveCwd)

  // Opening the area spawns a first terminal if none exists.
  useEffect(() => {
    ensureTerminal()
  }, [])

  // Following the FOCUSED chat's directory: switching to a chat in another
  // project fronts that project's terminal, if one is already open. It never
  // spawns one, and it leaves the current tab alone when nothing matches — a
  // chat with no shell of its own must not yank you off the one you were using.
  useEffect(() => selectTerminalForCwd(cwd), [cwd])

  return (
    <div className="flex h-full min-h-0 bg-(--ui-editor-surface-background) border-e">
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
