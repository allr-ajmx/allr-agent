import { IS_TAURI } from '@/lib/platform'
import { broadcastToPeers, onPeerBroadcast, type PeerBroadcast } from '@/lib/webview-broadcast'

import { $mode, $skin } from './context'

// Cross-WebView appearance repaint.
//
// Skin and mode are persisted localStorage prefs read ONCE at module load (see
// `persistentAtom` — it seeds from storage and then lives in memory). Every
// surface the app opens is its own WebView running its own copy of this bundle:
// the main shell, a detached tile / chat pop-out (`?win=tile`), the HUD
// (`?win=hud`), Quick Entry (`?win=quick`), and the mobile activity screens
// (`?win=activity`). So switching the skin in one of them repainted THAT one and
// left every other surface holding its startup appearance until it was reopened.
//
// Desktop hit the same bug with the same shape and fixed it by listening for
// `storage`, which fires in the other renderers of an origin
// (67518a2adf "fix(desktop): repaint peer windows when the appearance changes").
// Universal cannot borrow that: its surfaces are Tauri WebViews, not Chromium
// renderers, and cross-process `storage` delivery is a WebKit/Android WebView
// implementation detail we would be betting the feature on. The portable
// equivalent already exists here and is proven in production — the Tauri event
// bus, reached through lib/webview-broadcast.ts. This is its appearance twin.
//
// Wired by a side-effect import in main.tsx, like the gateway sync it mirrors.

export const APPEARANCE_EVENT = 'appearance://changed'

export interface AppearanceChangedPayload extends PeerBroadcast {
  /** Skin NAME, not a palette. Every WebView resolves it against its own registry. */
  skin: string
  /** Raw `light` / `dark` / `system` — normalized by the ThemeProvider, not here. */
  mode: string
}

let started = false

// True only while a peer's appearance is being written into the atoms below, so
// the change listeners don't bounce it straight back out. Structural, not a
// heuristic: a receiver never re-broadcasts, so an event cannot circulate.
let applyingRemote = false

/**
 * Announce this WebView's appearance to every other one, and adopt theirs.
 *
 * Hooks the ATOMS rather than `useTheme()`'s setters, because the setters are not
 * the only writers — `store/profile-share.ts` assigns `$skin`/`$mode` directly
 * when a shared profile bundle is imported, and that has to repaint peers too.
 * One choke point covers the theme picker, ⌘K, Appearance settings, `/skin`, the
 * `appearance.toggleMode` keybind, a backend skin drained through
 * `$pendingSkinApply`, and a profile import alike.
 *
 * Idempotent — main.tsx imports this module for its side effect, and a re-import
 * (HMR, a test) must not stack receivers or announcers.
 */
export function initAppearanceSync(): void {
  if (started || !IS_TAURI) {
    return
  }

  started = true

  const announce = (): void => {
    if (applyingRemote) {
      return
    }

    broadcastToPeers<AppearanceChangedPayload>(APPEARANCE_EVENT, { mode: $mode.get(), skin: $skin.get() })
  }

  // `listen`, not `subscribe`: nanostores calls a subscriber immediately, which
  // would broadcast this WebView's startup appearance at every boot and have a
  // freshly opened satellite shout its own defaults over the live one.
  $skin.listen(announce)
  $mode.listen(announce)

  onPeerBroadcast<AppearanceChangedPayload>(APPEARANCE_EVENT, payload => {
    applyingRemote = true

    try {
      // Set the raw name. Resolving it here would be wrong: a peer may hold a
      // backend skin this WebView has not been pushed yet, and normalizing would
      // silently downgrade it to the default forever. The ThemeProvider
      // normalizes for PAINT on every render, so the moment the registry catches
      // up the real palette lands on its own.
      if (typeof payload.skin === 'string' && payload.skin) {
        $skin.set(payload.skin)
      }

      if (typeof payload.mode === 'string' && payload.mode) {
        $mode.set(payload.mode)
      }
    } finally {
      applyingRemote = false
    }
  })
}

initAppearanceSync()
