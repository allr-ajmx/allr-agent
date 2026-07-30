import { createProfile, deleteProfile, getProfiles, renameProfile, setApiRequestProfile } from '@/hermes'
import { Codecs, persistentAtom } from '@/lib/persisted'
import { queryClient } from '@/lib/query-client'
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
  void queryClient.invalidateQueries()
}

// Rail order, rail colors, the all-profiles browse scope, and the hotkey-driven
// rail navigation live in `@/store/profile` (singular), which imports this file.
// Keep the dependency one-way: nothing here may import `@/store/profile`.

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
