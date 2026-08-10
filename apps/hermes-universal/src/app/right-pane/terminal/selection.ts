import { IS_MAC } from '@/lib/keybinds/combo'

export const isMacPlatform = (): boolean => IS_MAC

/**
 * Hand the terminal's selection to the OS by mirroring it into xterm's hidden
 * helper textarea (the same trick xterm uses for Linux middle-click paste,
 * CoreBrowserTerminal.ts:531). Without it the webview's own copy — the
 * right-click menu, and any platform copy that bypasses our key handler — finds
 * no DOM selection and copies nothing, because xterm's selection lives on a
 * canvas.
 *
 * `textarea.select()` REPLACES the document's live range, which is why the
 * guards below are the whole point of this function rather than defensive
 * padding. Only claim the range while the terminal owns focus AND nothing
 * outside the terminal is highlighted — otherwise a leftover terminal scrap wins
 * ⌘C over text the user just selected in the chat, which is exactly the
 * arbitration bug (a copy in chat silently yielding terminal output instead).
 * The terminal's own ⌘C handler still copies through `writeClipboardText` when
 * focus is genuinely on the canvas.
 */
export function mirrorSelection(host: HTMLElement, text: string) {
  const textarea = host.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')

  if (!textarea) {
    return
  }

  if (!text) {
    textarea.value = ''

    return
  }

  textarea.value = text

  if (!host.contains(document.activeElement)) {
    return
  }

  const live = window.getSelection()
  const foreign = live && !live.isCollapsed && live.anchorNode != null && !host.contains(live.anchorNode)

  if (foreign) {
    return
  }

  textarea.select()
}
