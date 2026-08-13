import { emit, listen } from '@tauri-apps/api/event'

import { IS_TAURI } from '@/lib/platform'
import { WEBVIEW_ID } from '@/lib/webview-id'

// One webview telling the others that something global changed.
//
// Every surface the app opens is its own WebView running its own copy of the
// bundle with its own module state: the main shell, a detached tile or chat
// pop-out (`?win=tile`), the HUD (`?win=hud`), Quick Entry (`?win=quick`), and
// the mobile activity screens (`?win=activity`, MJXHRM-141). So anything held in
// memory — the skin, the gateway client, the terminal font, the composer's draft
// map — exists once PER WEBVIEW, and a change made in one of them leaves the
// others holding whatever they read at boot.
//
// Electron's answer is the `storage` event, which fires in every other renderer
// of an origin. Universal cannot use it: its surfaces are Tauri WebViews rather
// than Chromium renderers, cross-process `storage` delivery is a WebKitGTK /
// WebView2 / Android-WebView implementation detail, and on Android the "windows"
// are activities in one process with no second renderer to notify. The portable
// equivalent is the Tauri event bus.
//
// Four features had independently written the same twelve lines around it — the
// IS_TAURI gate, the origin stamp, the self-echo drop, the swallowed failure —
// so they live here once. What each of them does NOT share is the payload and
// what to do with it, which stays at the call sites.

/** The field every broadcast on this bus carries. */
export interface PeerBroadcast {
  /** The sending WebView, so a receiver can drop its own echo (emit is global). */
  origin: string
}

/**
 * Tell every other WebView something, stamped with this one's identity.
 *
 * Best-effort by design: a broadcast that fails must never fail the change that
 * just worked locally. Callers that need to know whether anyone heard have to
 * ask for an answer — this returns nothing because there is nothing truthful to
 * return; `emit` resolves when the message left, not when it landed.
 *
 * Off Tauri this is a no-op, which is the honest shape: there are no peer
 * WebViews in a browser tab or a test.
 */
export function broadcastToPeers<T extends PeerBroadcast>(event: string, payload: Omit<T, 'origin'>): void {
  if (!IS_TAURI) {
    return
  }

  void emit(event, { ...payload, origin: WEBVIEW_ID }).catch(() => {})
}

/**
 * Hear what another WebView said, never what this one said.
 *
 * The echo drop is not an optimisation: `emit` delivers to the sender too, so a
 * receiver that acts on its own message either undoes the change it just made or
 * bounces it back out forever.
 *
 * Returns a stop function that is safe to call before the underlying
 * registration has resolved — it will unlisten as soon as it does, and the
 * handler stops firing immediately either way.
 */
export function onPeerBroadcast<T extends PeerBroadcast>(event: string, handle: (payload: T) => void): () => void {
  if (!IS_TAURI) {
    return () => undefined
  }

  let unlisten: (() => void) | undefined
  let stopped = false

  void listenToPeers<T>(event, handle)
    .then(stop => {
      unlisten = stop

      if (stopped) {
        stop()
      }
    })
    .catch(() => {})

  return () => {
    stopped = true
    unlisten?.()
  }
}

/**
 * The same, but resolving once the listener is actually registered.
 *
 * Registration is a round trip through Rust. A caller that emits a request and
 * then waits for an answer has to know the answer cannot outrun the listener —
 * so anything request/response shaped awaits this, while module-level wiring
 * that only ever receives uses the fire-and-forget form above.
 */
export async function listenToPeers<T extends PeerBroadcast>(
  event: string,
  handle: (payload: T) => void
): Promise<() => void> {
  if (!IS_TAURI) {
    return () => undefined
  }

  let stopped = false

  const unlisten = await listen<T>(event, received => {
    const payload = received.payload

    if (stopped || !payload?.origin || payload.origin === WEBVIEW_ID) {
      return
    }

    handle(payload)
  })

  return () => {
    stopped = true
    unlisten()
  }
}
