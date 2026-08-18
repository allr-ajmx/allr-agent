import { atom } from 'nanostores'

import { Codecs, persistentAtom } from '@/lib/persisted'

const TAKEOVER_KEY = 'hermes.terminalTakeover'

// Seam: desktop pairs a plain atom with storedBoolean/persistBoolean from
// @/lib/storage; universal's persistentAtom does both in one.
export const $terminalTakeover = persistentAtom(TAKEOVER_KEY, false, Codecs.bool)

export const setTerminalTakeover = (active: boolean) => $terminalTakeover.set(active)

/** A command queued to run in the embedded terminal. The terminal pane flushes
 *  (and clears) it once its session is live, so a value set before the pane
 *  mounts still runs. Cleared after flush so a later remount can't replay it. */
export const $terminalInjection = atom<null | string>(null)

/** Open the terminal pane and run a command in it. Used to disconnect external
 *  (CLI-managed) providers, which Allr can't clear via the API — the user
 *  sees exactly what runs instead of Allr silently deleting their creds. */
export const runInTerminal = (command: string) => {
  const trimmed = command.trim()

  if (!trimmed) {
    return
  }

  setTerminalTakeover(true)
  $terminalInjection.set(trimmed)
}
