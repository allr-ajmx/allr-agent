import { loadInstallationId, saveInstallationId } from '@/lib/secure-store'
import { loadString, saveString } from '@/lib/persist'

// This install's stable identity (MJX-55).
//
// SSH gateway mode names its remote state directory after sha256(installationId,
// profile) and the remote backend echoes that back as an ownership proof. So the
// value has one hard requirement: it must be the SAME on every launch.
//
// Losing it is not a fresh start — it ORPHANS remote backends. The next connect
// computes a different ownership id, does not recognize the lockfile left on the
// remote, and therefore neither reuses that backend nor cleans it up. It just
// keeps running on someone else's machine with nothing pointing at it.
//
// Desktop has an installation-ID file for this (electron/desktop-installation.ts);
// universal has no main process, so it lives in the OS keyring with a
// localStorage mirror. The mirror is what makes a keyring that is merely
// *unavailable* (a Linux box with no Secret Service running, a browser dev
// session) non-destructive: we fall back to the mirror rather than minting a new
// identity and stranding whatever the old one owned.

const MIRROR_KEY = 'hermes.installation.id'

/** 32 lowercase hex characters — the shape Rust validates. */
const SHAPE = /^[0-9a-f]{32}$/

function isValid(value: string | null | undefined): value is string {
  return typeof value === 'string' && SHAPE.test(value)
}

/** Mint a new identity. Uses the platform CSPRNG — a collision would make two
 *  installs fight over one remote backend. */
export function mintInstallationId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)

  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

let cached: string | null = null

/**
 * The stable id for this install, creating one on first use.
 *
 * Read order is keyring → localStorage mirror → mint. The mirror is consulted
 * before minting precisely because an unavailable keyring must not look like a
 * new install.
 */
export async function getInstallationId(): Promise<string> {
  if (cached) {
    return cached
  }

  const stored = await loadInstallationId().catch(() => null)

  if (isValid(stored)) {
    cached = stored
    // Re-seed the mirror in case it was cleared; cheap and keeps the fallback warm.
    saveString(MIRROR_KEY, stored)

    return stored
  }

  const mirrored = loadString(MIRROR_KEY)

  if (isValid(mirrored)) {
    cached = mirrored
    // The keyring came back (or was repaired) — write it through so the mirror
    // stops being the only copy.
    void saveInstallationId(mirrored).catch(() => {})

    return mirrored
  }

  const minted = mintInstallationId()
  cached = minted
  saveString(MIRROR_KEY, minted)
  void saveInstallationId(minted).catch(() => {})

  return minted
}

/** Test seam: drop the in-process cache. */
export function resetInstallationIdCache(): void {
  cached = null
}
