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

// The read this handler performs lives in @/lib/clipboard (`readClipboardText`),
// next to the write half. It was defined here when the terminal was the only
// reader in the tree (MJXHRM-415) — which is part of why four other surfaces
// went on calling `navigator.clipboard` directly and silently doing nothing on
// WebKitGTK. Nothing about "read through the OS because the webview's own API is
// refused" is specific to a terminal.
