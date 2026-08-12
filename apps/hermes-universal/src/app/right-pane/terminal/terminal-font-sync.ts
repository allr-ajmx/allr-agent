import { emit, listen } from '@tauri-apps/api/event'

import { IS_TAURI } from '@/lib/platform'
import { WEBVIEW_ID } from '@/lib/webview-id'
import { $activeGatewayProfile } from '@/store/profile'

import { $terminalFontFamily, setTerminalFontFamilyFromConfig } from './terminal-font'

// Cross-WebView terminal font.
//
// `terminal.font_family` lives in the profile config, but the thing that RENDERS
// it is `$terminalFontFamily` — an in-memory atom, one copy per WebView, fed by
// whichever surface in that WebView happens to hold the shared config-record
// query. Every surface the app opens is its own WebView running its own copy of
// the bundle, and the two halves of this setting do not always land in the same
// one:
//
//   • On Android, Settings IS a separate WebView (`?win=activity`, MJX-141) while
//     the terminal lives in the chat activity. Typing a font there changed
//     nothing the user could see.
//   • A detached tile window (`?win=tile`) can host the terminal pane itself
//     (app/contrib/controller.tsx registers it), so the pane being re-faced is in
//     a different WebView from the picker doing the re-facing.
//   • The same window split also means an out-of-band `config.yaml` edit picked
//     up by ONE surface's revalidation never reached the others.
//
// So the writer announces and every other WebView adopts — the same shape, and
// the same reasoning, as themes/appearance-sync.ts (a `storage` listener is a
// Chromium-renderer trick universal cannot use; the Tauri event bus is the
// portable equivalent already proven here and in store/gateway-switch-sync.ts).
//
// Wired by a side-effect import in main.tsx, like the two syncs it mirrors.

export const TERMINAL_FONT_EVENT = 'terminal-font://changed'

export interface TerminalFontChangedPayload {
  /** The configured family verbatim — a friendly name OR an authored CSS stack.
   *  Each WebView resolves it against the bundled fallback itself. */
  family: string
  /** The sending WebView, so a receiver can drop its own echo (emit is global). */
  origin: string
  /** The profile the sender is scoped to. `$activeProfile` is a per-WebView
   *  persisted atom, so a satellite opened before a profile switch is still on
   *  the old one — and this is profile config, not a device preference. Without
   *  the stamp that satellite would push its profile's font onto everyone. */
  profile: string
}

let started = false

// True only while a peer's font is being written into the atom, so the change
// listener doesn't bounce it straight back out. Structural, not a heuristic: a
// receiver never re-broadcasts, so an event cannot circulate.
let applyingRemote = false

/**
 * Announce this WebView's terminal font to every other one, and adopt theirs.
 *
 * Hooks the ATOM rather than the Settings picker, because the picker is not the
 * only writer: `terminal-view.tsx` pushes the family in from every config-record
 * revalidation (a save elsewhere, a profile switch, opening Settings after a
 * hand-edit of `config.yaml`). One choke point covers all of them, and it fires
 * per keystroke exactly like the local live preview does — the point of the
 * setting is that an OPEN terminal re-faces, and "open" includes the ones in
 * other windows.
 *
 * Idempotent — main.tsx imports this module for its side effect, and a re-import
 * (HMR, a test) must not stack receivers or announcers.
 */
export function initTerminalFontSync(): void {
  if (started || !IS_TAURI) {
    return
  }

  started = true

  const announce = (family: string): void => {
    if (applyingRemote) {
      return
    }

    const payload: TerminalFontChangedPayload = {
      family,
      origin: WEBVIEW_ID,
      profile: $activeGatewayProfile.get()
    }

    // Best-effort: a failed broadcast must never break the change that just
    // worked in THIS window.
    void emit(TERMINAL_FONT_EVENT, payload).catch(() => {})
  }

  // `listen`, not `subscribe`: nanostores calls a subscriber immediately, which
  // would have every freshly opened satellite shout its own empty startup value
  // over a live one.
  $terminalFontFamily.listen(announce)

  void listen<TerminalFontChangedPayload>(TERMINAL_FONT_EVENT, event => {
    const payload = event.payload

    if (!payload?.origin || payload.origin === WEBVIEW_ID || typeof payload.family !== 'string') {
      return
    }

    // A peer on another profile is describing another config file's value.
    if (payload.profile !== $activeGatewayProfile.get()) {
      return
    }

    applyingRemote = true

    try {
      setTerminalFontFamilyFromConfig(payload.family)
    } finally {
      applyingRemote = false
    }
  })
}

initTerminalFontSync()
