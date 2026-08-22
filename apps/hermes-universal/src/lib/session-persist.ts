import { invoke } from '@tauri-apps/api/core'

import { loadSessionCookies, saveSessionCookies } from '@/lib/secure-store'

// Gateway-session persistence across launches (D4/R2b). The reqwest cookie jar
// that carries the OAuth/cloud session lives in Rust and is in-memory only, so
// without this the login is lost on every app restart. We serialize the jar out
// of Rust (`cookies_export`) into the OS keyring, and rehydrate it back in
// (`cookies_import`) once on launch before the first connect.
//
// Both directions are best-effort: a missing keyring (browser dev / non-mobile
// before the D6 desktop-gate flip) simply degrades to no-persistence — the user
// signs in again — never a crash.

/**
 * The jar as the keyring currently holds it, as far as this process knows.
 *
 * `persistSessionCookies` runs on every transition to `ready` — every reconnect,
 * every gateway switch, every resume — and the jar is usually byte-identical to
 * the one already stored. Writing it anyway is not free: a keyring write is its
 * own ACL check, separate from the read's, so on macOS an unchanged jar could
 * cost a password dialog on a build whose signature the ACL cannot match.
 *
 * Compared here rather than in Rust deliberately. The serialized jar is already
 * in hand at this point, whereas a Rust-side comparison would have to READ the
 * stored value first — spending the very round trip this exists to avoid.
 *
 * Process-local, and only ever suppresses a write of the SAME bytes, so the worst
 * a stale value can do is let one redundant write through.
 */
let lastPersisted: string | null = null

/** Serialize the live jar and stash it in the keyring. Call after a successful connect. */
export async function persistSessionCookies(): Promise<void> {
  try {
    const json = await invoke<string>('cookies_export')

    if (!json || !json.trim() || json === lastPersisted) {
      return
    }

    if (await saveSessionCookies(json)) {
      lastPersisted = json
    }
  } catch {
    // No Tauri runtime or empty jar — nothing to persist.
  }
}

/** Rehydrate the jar from the keyring. Call once at startup, before connecting. */
export async function restoreSessionCookies(): Promise<void> {
  try {
    const json = await loadSessionCookies()

    if (json && json.trim()) {
      // Seed the memo from what we just read, so the first connect of a launch
      // does not immediately write back the identical jar it restored.
      lastPersisted = json

      await invoke('cookies_import', { json })
    }
  } catch {
    // No saved session or no runtime — start with an empty jar.
  }
}

/**
 * Drop the memo above, so the next connect re-persists the jar unconditionally.
 *
 * Call this whenever the STORED jar is discarded behind our back — signing out
 * wipes the keyring entry, and without this the memo would still claim that
 * entry holds the current jar. A reconnect on a still-live in-memory session
 * would then serialize to the same bytes, match, skip the write, and leave the
 * user signed out at the next launch with nothing having reported a failure.
 */
export function forgetPersistedSessionCookies(): void {
  lastPersisted = null
}
