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
 * the one already stored. Writing it anyway is not free: on every platform but
 * macOS a keyring write is its own ACL check, separate from the read's. (On macOS
 * the write now lands in the sealed vault instead — see
 * src-tauri/src/secrets/vault.rs — so it no longer costs a dialog. Everywhere
 * else, and for the plain I/O either way, skipping an unchanged write is still
 * the right thing to do.)
 *
 * Compared here rather than in Rust deliberately. The serialized jar is already
 * in hand at this point, whereas a Rust-side comparison would have to READ the
 * stored value first — spending the very round trip this exists to avoid.
 *
 * Process-local, and only ever suppresses a write of the SAME bytes, so the worst
 * a stale value can do is let one redundant write through.
 */
let lastPersisted: string | null = null

/**
 * Set by sign-out, cleared by the next deliberate connect.
 *
 * Sign-out is not a single instant — the logout POST, the keyring wipe and the
 * socket teardown all resolve separately, and `flushSessionCookies()` fires on
 * the very next backgrounding. Without this latch that flush would export
 * whatever is left in the jar and write it straight back to the keyring the
 * sign-out had just cleared, signing the user back in on the following launch.
 * A user who signed out stays signed out until they ask to connect again.
 */
let suspended = false

/** Stop persisting the jar until the next deliberate connect. Sign-out only. */
export function suspendSessionCookiePersistence(): void {
  suspended = true
  forgetPersistedSessionCookies()
}

/** Re-arm persistence. Called from `armReconnect`, i.e. from every deliberate dial. */
export function resumeSessionCookiePersistence(): void {
  suspended = false
}

/** Empty the live Rust jar. Best-effort — see `cookies_clear` in transport.rs. */
export async function clearSessionJar(): Promise<void> {
  try {
    await invoke('cookies_clear')
  } catch {
    // No Tauri runtime, or a poisoned jar. The keyring entry is wiped either way.
  }
}

/** Serialize the live jar and stash it in the keyring. Call after a successful connect. */
export async function persistSessionCookies(): Promise<void> {
  if (suspended) {
    return
  }

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
