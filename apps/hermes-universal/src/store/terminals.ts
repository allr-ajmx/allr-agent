import { persistentAtom } from '@/lib/persisted'
import { atom } from '@/store/atom'
import { setTerminalOpen } from '@/store/layout'
import type { TerminalHostPreference } from '@/transport/terminal-transport'

// Multi-terminal state for the right pane (adapted, much simplified, from
// desktop's right-sidebar/terminal/terminals.ts). Each entry is just an id — the
// live shell + xterm live in the per-id TerminalView. Not persisted (shells don't
// survive an app restart). Closing the last one hides the terminal area.

/**
 * Which machine new terminals shell into: `auto` applies the gateway-mode rule
 * (see transport/terminal-transport.ts), `device`/`gateway` pin it. Persisted
 * because it's a standing preference, and read only at spawn — flipping it never
 * moves a running shell.
 */
export const $terminalHostPreference = persistentAtom<TerminalHostPreference>('hermes.terminalHost', 'auto', {
  decode: raw => (raw === 'device' || raw === 'gateway' ? raw : 'auto'),
  encode: value => value
})

export function setTerminalHostPreference(preference: TerminalHostPreference): void {
  $terminalHostPreference.set(preference)
}

export interface TerminalEntry {
  id: string
  title: string
}

let counter = 0

export const $terminals = atom<TerminalEntry[]>([])
export const $activeTerminalId = atom<string | null>(null)

export function createTerminal(): string {
  counter += 1
  const id = `term-${counter}`
  $terminals.set([...$terminals.get(), { id, title: `Terminal ${counter}` }])
  $activeTerminalId.set(id)

  return id
}

/** Ensure at least one terminal exists + is active (called when the area opens). */
export function ensureTerminal(): void {
  if ($terminals.get().length === 0) {
    createTerminal()
  } else if (!$activeTerminalId.get()) {
    $activeTerminalId.set($terminals.get()[0].id)
  }
}

export function selectTerminal(id: string): void {
  if ($terminals.get().some(term => term.id === id)) {
    $activeTerminalId.set(id)
  }
}

function afterRemoval(next: TerminalEntry[], removedActive: boolean): void {
  $terminals.set(next)

  if (removedActive) {
    $activeTerminalId.set(next.length ? next[next.length - 1].id : null)
  }

  if (next.length === 0) {
    setTerminalOpen(false)
  }
}

export function closeTerminal(id: string): void {
  afterRemoval(
    $terminals.get().filter(term => term.id !== id),
    $activeTerminalId.get() === id
  )
}

export function closeOtherTerminals(id: string): void {
  const keep = $terminals.get().filter(term => term.id === id)
  $terminals.set(keep)
  $activeTerminalId.set(keep.length ? id : null)
}

// ── Keybind entry points (view.nextTerminal / prevTerminal / closeTerminal) ──
// Desktop keeps these in right-sidebar/terminal/terminals.ts; here they sit with
// the rest of the terminal state. Both are no-ops with nothing open, so the
// hotkeys stay harmless when the terminal area is empty.

/** Step the active terminal by `direction`, wrapping at both ends. */
export function cycleTerminal(direction: 1 | -1): void {
  const terminals = $terminals.get()

  if (terminals.length < 2) {
    return
  }

  const current = terminals.findIndex(term => term.id === $activeTerminalId.get())
  const start = current === -1 ? 0 : current
  const next = (start + direction + terminals.length) % terminals.length

  $activeTerminalId.set(terminals[next].id)
}

export function closeActiveTerminal(): void {
  const id = $activeTerminalId.get()

  if (id) {
    closeTerminal(id)
  }
}

export function closeAllTerminals(): void {
  $terminals.set([])
  $activeTerminalId.set(null)
  setTerminalOpen(false)
}
