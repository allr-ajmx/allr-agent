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
 * The Tauri clipboard-manager plugin comes first (MJXHRM-415). The webview's
 * `navigator.clipboard.readText` cannot be the primary here: it is
 * permission-gated and user-gesture-gated, and WebKitGTK — the engine on the
 * Linux desktop build, not Chromium — refuses it in cases Chromium allows. That
 * made Ctrl+Shift+V a silent no-op over a shell prompt. The plugin reads through
 * the OS, so no such gate applies.
 *
 * The web API stays as a fallback for any target where the plugin is
 * unavailable. Returns '' rather than throwing: a paste the platform refuses
 * must be a no-op, not an error dialog over a shell prompt.
 */
export async function readClipboardText(): Promise<string> {
  try {
    const { readText } = await import('@tauri-apps/plugin-clipboard-manager')

    return (await readText()) ?? ''
  } catch {
    // Plugin unavailable or refused — fall through to the webview's own API.
  }

  try {
    return (await navigator.clipboard?.readText?.()) ?? ''
  } catch {
    return ''
  }
}
