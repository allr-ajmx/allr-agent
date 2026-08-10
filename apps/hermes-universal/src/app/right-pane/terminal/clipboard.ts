// Clipboard keybindings for the integrated terminal.
//
// xterm renders to a canvas, so its selection is not a DOM selection and the
// platform's own copy command has nothing to grab. Two mechanisms fix that:
// this key map (explicit chords) and `mirrorSelection` in ./selection (which
// hands the selection to the OS through xterm's hidden helper textarea, so the
// webview's own copy and the right-click menu work too).
//
// The chords follow VS Code (terminal.clipboard.contribution.ts): ⌘C/⌘V on
// macOS, Ctrl+Shift+C/V elsewhere, plus plain Ctrl+C as copy ONLY when text is
// selected — the "intelligent Ctrl-C" of Windows Terminal and Tabby. With no
// selection Ctrl+C stays SIGINT, so interrupting a process never breaks.
//
// Pure logic on purpose: the transport differs from desktop's (universal's
// terminal is a gateway PTY over /api/shell-pty, desktop's is local), but which
// chord means copy is a property of the keyboard, not the pipe.

export type TerminalClipboardIntent = 'copy' | 'paste' | null

export function terminalClipboardIntent(
  event: KeyboardEvent,
  { hasSelection, isMac }: { hasSelection: boolean; isMac: boolean }
): TerminalClipboardIntent {
  if (event.type !== 'keydown' || event.altKey) {
    return null
  }

  const key = event.key.toLowerCase()

  if (isMac) {
    if (!event.metaKey || event.ctrlKey || event.shiftKey) {
      return null
    }

    // ⌘C with nothing selected falls through to the shell (⌘ isn't a terminal
    // modifier, so it's a no-op there rather than a lost keystroke).
    return key === 'c' ? (hasSelection ? 'copy' : null) : key === 'v' ? 'paste' : null
  }

  if (!event.ctrlKey || event.metaKey) {
    return null
  }

  if (event.shiftKey) {
    return key === 'c' ? (hasSelection ? 'copy' : null) : key === 'v' ? 'paste' : null
  }

  // Bare Ctrl+C: copy only when there's a selection to copy, else SIGINT.
  return key === 'c' && hasSelection ? 'copy' : null
}

/**
 * Read the clipboard for a terminal paste.
 *
 * NOTE (MJXHRM-47): this goes through the async Clipboard API, NOT the Tauri
 * clipboard-manager plugin the ticket asks for — that plugin is not installed in
 * this app (no npm dependency, no Cargo dependency, no capability entry), and
 * adding it changes the lockfile, which this wave forbids. `writeClipboardText`
 * (components/ui/copy-button) is the app's existing write seam and has the same
 * constraint; this is its read counterpart, deliberately placed beside it in
 * shape so both move together when the plugin does land.
 *
 * Returns '' rather than throwing: a paste that the engine refuses (WebKitGTK
 * gates `readText` more tightly than Chromium) must be a no-op, not an error
 * dialog over a shell prompt.
 */
export async function readClipboardText(): Promise<string> {
  try {
    return (await navigator.clipboard?.readText?.()) ?? ''
  } catch {
    return ''
  }
}
