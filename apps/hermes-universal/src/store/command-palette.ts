import { releaseTypingFocus } from '@/components/ui/keyboard-first'
import { atom } from '@/store/atom'

// The global command palette (⌘K). Every view the 4-item sidebar rail doesn't
// carry — Agents, Starmap, Command Center, Settings… — is reached through here,
// opened by the keybind, the titlebar search button (desktop), or the in-drawer
// button (phones, where there is no titlebar).

/** Whether the global command palette (Cmd/Ctrl+K) is currently open. */
export const $commandPaletteOpen = atom(false)

/** Optional nested page to open when the palette next opens (e.g. `theme`). */
export const $commandPalettePage = atom<null | string>(null)

export function openCommandPalette(): void {
  $commandPaletteOpen.set(true)
}

/** Open the palette directly on a nested page (`theme`, `color-mode`, …). */
export function openCommandPalettePage(page: string): void {
  $commandPalettePage.set(page)
  $commandPaletteOpen.set(true)
}

// Closing hands the keyboard back to the composer — a hotkey-opened overlay
// owes typing focus to whatever the user was writing, not to its trigger.
// Skipped when the palette action itself moved focus (navigating to a route,
// opening a dialog): those surfaces claim focus after this runs.
function setOpen(open: boolean): void {
  const wasOpen = $commandPaletteOpen.get()

  $commandPaletteOpen.set(open)

  if (!open) {
    $commandPalettePage.set(null)

    if (wasOpen) {
      releaseTypingFocus()
    }
  }
}

export function closeCommandPalette(): void {
  setOpen(false)
}

export function setCommandPaletteOpen(open: boolean): void {
  setOpen(open)
}

export function toggleCommandPalette(): void {
  setOpen(!$commandPaletteOpen.get())
}
