import { createProfile, deleteProfile, getProfiles, renameProfile, setApiRequestProfile } from '@/hermes'
import { Codecs, persistentAtom } from '@/lib/persisted'
import { invalidateProfileScopedQueries } from '@/lib/query-client'
import { atom } from '@/store/atom'
import { notifyError } from '@/store/notifications'
import type { ProfileCreatePayload, ProfileInfo } from '@/types/hermes'

export const $profiles = atom<ProfileInfo[]>([])
export const $profilesLoading = atom(false)
export const $profilesError = atom<string | null>(null)

// The profile the app operates as (E7.b). Persisted; null = the gateway's own
// (primary) profile, so single-profile users are unaffected. Switching re-scopes
// all profileScoped() REST calls (config/skills/model/sessions…) via the
// hermes.ts _apiProfile, then invalidates cached queries so views refetch under
// the new scope — mirroring the dashboard's ?profile= re-scope. The live chat WS
// is NOT re-profiled on a shared remote/cloud gateway (backend limit); local mode
// applies it fully by respawning the backend (see the refresh prompt).
export const $activeProfile = persistentAtom<null | string>('hermes.activeProfile', null, Codecs.nullableText)

// Sync the REST scope to the persisted selection on load.
setApiRequestProfile($activeProfile.get())

/** Switch the active profile: re-scope REST + refetch. No-op if unchanged. Does
 *  NOT reconnect — the caller decides whether to prompt a session refresh. */
export function setActiveProfile(name: null | string): void {
  const next = name || null

  if (next === $activeProfile.get()) {
    return
  }

  setApiRequestProfile(next)
  $activeProfile.set(next)
  invalidateProfileScopedQueries()
}

// ── Hotkey-driven profile switching ────────────────────────────────────────
// Positional + relative navigation for the rail, used by the keybind runtime.
// Adapted from desktop `store/profile.ts` (switchToDefaultProfile /
// switchProfileToSlot / cycleProfile), minus the `$profileOrder` and
// `$showAllProfiles` state universal doesn't have: the rail order here is just
// the API's order, matching what `app/chat/sidebar/profile-switcher.tsx` renders.
// Universal spells the default profile `null`, not the name 'default'.

/** The named (non-default) profiles, in rail order. */
function namedProfiles(): ProfileInfo[] {
  return $profiles.get().filter(profile => !profile.is_default)
}

/** Switch to the default (root ~/.hermes) profile — bound to ⌘D. */
export function switchToDefaultProfile(): void {
  setActiveProfile(null)
}

/** Switch to the Nth named (non-default) profile in rail order (1-based). A
 *  no-op when the slot is empty, so unused ⌘N keys stay harmless. */
export function switchProfileToSlot(slot: number): void {
  const target = namedProfiles()[slot - 1]

  if (target) {
    setActiveProfile(target.name)
  }
}

/** Step to the next/previous profile in the rail, wrapping around. The ordered
 *  list is [default, ...named], with `null` standing in for the default. */
export function cycleProfile(direction: 1 | -1): void {
  const keys: (null | string)[] = [null, ...namedProfiles().map(profile => profile.name)]

  if (keys.length < 2) {
    return
  }

  const current = keys.indexOf($activeProfile.get())
  const start = current < 0 ? (direction === 1 ? -1 : 0) : current
  const next = (start + direction + keys.length) % keys.length

  setActiveProfile(keys[next])
}

export async function refreshProfiles(): Promise<void> {
  $profilesLoading.set(true)
  $profilesError.set(null)

  try {
    $profiles.set((await getProfiles()).profiles)
  } catch (err) {
    $profilesError.set(err instanceof Error ? err.message : 'Failed to load profiles')
  } finally {
    $profilesLoading.set(false)
  }
}

export async function createProfileLocal(payload: ProfileCreatePayload): Promise<boolean> {
  try {
    await createProfile(payload)
    await refreshProfiles()

    return true
  } catch (err) {
    notifyError(err, 'Failed to create profile')

    return false
  }
}

export async function renameProfileLocal(name: string, newName: string): Promise<boolean> {
  try {
    await renameProfile(name, newName)
    await refreshProfiles()

    return true
  } catch (err) {
    notifyError(err, 'Failed to rename profile')

    return false
  }
}

export async function removeProfile(name: string): Promise<void> {
  const prev = $profiles.get()
  $profiles.set(prev.filter(p => p.name !== name))

  try {
    await deleteProfile(name)
  } catch (err) {
    $profiles.set(prev)
    notifyError(err, 'Failed to delete profile')
  }
}

// Profile name rules (mirrors the desktop nameHint copy).
export const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/

export function isValidProfileName(name: string): boolean {
  return PROFILE_NAME_RE.test(name.trim())
}
