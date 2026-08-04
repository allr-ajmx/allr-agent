// The desktop-shaped profile store: rail order, rail colors, the sidebar browse
// scope, and the keyboard navigation over the rail. Ported code imports
// `@/store/profile` (singular) for these; universal's profile CRUD + REST
// re-scope primitive lives next door in `@/store/profiles` (plural).
//
// DEPENDENCY DIRECTION — `session.ts → profile.ts → profiles.ts`, never
// backwards. `profiles.ts` must not import this file, and anything here that
// would need `@/store/session` (e.g. "new chat in profile X") is exposed as a
// component prop instead, so the cycle stays impossible.
import { getProfiles } from '@/hermes'
import { Codecs, persistentAtom } from '@/lib/persisted'
import { arraysEqual } from '@/lib/storage'
import { atom, computed } from '@/store/atom'
import { $activeProfile, $profiles, setActiveProfile as setUniversalActiveProfile } from '@/store/profiles'
import type { ProfileInfo } from '@/types/hermes'

// Canonical key for a profile: trimmed, empty/null → "default". Verbatim from
// desktop store/profile.ts — used to key profile-scoped caches (analytics badges).
export function normalizeProfileKey(name: string | null | undefined): string {
  const value = (name ?? '').trim()

  return value || 'default'
}

// Desktop's `$activeGatewayProfile` is an atom<string> that names the profile the
// live backend is scoped to ('default' = root). Universal's `$activeProfile` is a
// nullable persisted atom (null = primary), so we derive the normalized key.
export const $activeGatewayProfile = computed($activeProfile, profile => normalizeProfileKey(profile))

// ── Rail order ─────────────────────────────────────────────────────────────
// User-defined order for the named (non-default) profile squares in the rail.
// Names absent from the list fall back to alphabetical, appended at the tail —
// so a freshly created profile lands at the end until the user drags it.
export const $profileOrder = persistentAtom<string[]>('hermes.profileOrder', [], Codecs.stringArray)

export function setProfileOrder(names: string[]): void {
  if (!arraysEqual($profileOrder.get(), names)) {
    $profileOrder.set(names)
  }
}

// Sort items by the stored order; unordered names alphabetise at the tail.
export function sortByProfileOrder<T extends { name: string }>(items: T[], order: string[]): T[] {
  const rank = new Map(order.map((name, index) => [name, index]))

  return [...items].sort((a, b) => {
    const ra = rank.get(a.name)
    const rb = rank.get(b.name)

    if (ra != null && rb != null) {
      return ra - rb
    }

    return ra != null ? -1 : rb != null ? 1 : a.name.localeCompare(b.name)
  })
}

// ── Rail colors ────────────────────────────────────────────────────────────
// Verbatim from desktop store/profile.ts, on universal's `persistentAtom` seam.
// Optional per-profile color override (long-press a rail square to pick). Absent
// names fall back to the deterministic hue from profileColor() in
// `@/lib/profile-color`; a local-only cosmetic preference, so single-profile
// users never touch it.
export const $profileColors = persistentAtom<Record<string, string>>('hermes.profileColors', {}, Codecs.stringRecord)

/** Set (or, with null, clear) a profile's color override. */
export function setProfileColor(name: string, color: null | string): void {
  const key = normalizeProfileKey(name)
  const next = { ...$profileColors.get() }

  if (color) {
    next[key] = color
  } else {
    delete next[key]
  }

  $profileColors.set(next)
}

// ── Sidebar profile scope (the "workspace switcher" model) ─────────────────
// Mirrors how Slack/VS Code/Linear do multi-context: you're "in" one profile at
// a time and the sidebar shows only that profile's sessions (clean rows, no
// per-row tags). The lone exception is an explicit "All profiles" mode that
// fans every profile's sessions into one grouped, browsable list.

export const ALL_PROFILES = '__all__'

// Opt-in unified view. When false, scope follows the active profile, so
// single-profile users (who never see the switcher) are completely unaffected.
export const $showAllProfiles = persistentAtom('hermes.showAllProfiles', false, Codecs.bool)

// The profile context the sidebar is currently showing: a concrete profile key,
// or ALL_PROFILES for the unified grouped view. Concrete scope is tied to the
// active profile, so selecting a profile (which re-scopes every REST call) moves
// the whole sidebar with it — a real context switch, not a separate filter to
// keep in sync.
export const $profileScope = computed([$showAllProfiles, $activeGatewayProfile], (showAll, gateway) =>
  showAll ? ALL_PROFILES : normalizeProfileKey(gateway)
)

export function setShowAllProfiles(value: boolean): void {
  $showAllProfiles.set(value)
}

export function toggleShowAllProfiles(): void {
  $showAllProfiles.set(!$showAllProfiles.get())
}

/** Desktop's signature — pull the profile list and return it (universal's
 *  `@/store/profiles` refreshProfiles() returns void and swallows errors, which
 *  the ported Profiles view needs to surface). */
export async function refreshProfiles(): Promise<ProfileInfo[]> {
  const { profiles } = await getProfiles()
  $profiles.set(profiles)

  return profiles
}

/** Desktop swaps the live gateway onto the profile's backend; universal re-scopes
 *  its REST calls and refetches instead (see `@/store/profiles`). Both land on
 *  "the app now operates as this profile", so the two desktop entry points map
 *  onto the one universal switch. Leaves the all-profiles browse view, like
 *  desktop — see `$showAllProfiles`. */
export function selectProfile(name: string): void {
  $showAllProfiles.set(false)
  setUniversalActiveProfile(normalizeProfileKey(name) === 'default' ? null : name)
}

export const setActiveProfile = selectProfile

// ── Hotkey-driven profile switching ────────────────────────────────────────
// Positional + relative navigation for the rail, used by the keybind runtime.
// The ordered list is [default, ...named-in-rail-order]; switching is a no-op
// when the slot is empty so unused ⌘N keys stay harmless.

/** The named (non-default) profiles, in rail order. */
function orderedNamedProfiles(): ProfileInfo[] {
  return sortByProfileOrder(
    $profiles.get().filter(profile => !profile.is_default),
    $profileOrder.get()
  )
}

function orderedProfileKeys(): string[] {
  const profiles = $profiles.get()
  const named = orderedNamedProfiles().map(profile => normalizeProfileKey(profile.name))
  const hasDefault = profiles.some(profile => profile.is_default)

  return hasDefault ? ['default', ...named] : named
}

/** Switch to the default (root ~/.hermes) profile — bound to ⌘D. */
export function switchToDefaultProfile(): void {
  selectProfile('default')
}

/** Switch to the Nth named (non-default) profile in rail order (1-based). A
 *  no-op when the slot is empty, so unused ⌘N keys stay harmless. */
export function switchProfileToSlot(slot: number): void {
  const target = orderedNamedProfiles()[slot - 1]

  if (target) {
    selectProfile(target.name)
  }
}

/** Step to the next/previous profile in the rail, wrapping around. The
 *  all-profiles browse view counts as index -1, so stepping forward from it
 *  lands on the first profile. */
export function cycleProfile(direction: 1 | -1): void {
  const keys = orderedProfileKeys()

  if (keys.length < 2) {
    return
  }

  const current = $showAllProfiles.get() ? -1 : keys.indexOf(normalizeProfileKey($activeProfile.get()))
  const start = current < 0 ? (direction === 1 ? -1 : 0) : current
  const next = (start + direction + keys.length) % keys.length

  selectProfile(keys[next])
}

// Bumped to ask the rail to open its "create profile" dialog (the dialog state
// is local to the rail component; this lets a global hotkey trigger it).
export const $profileCreateRequest = atom(0)

export function requestProfileCreate(): void {
  $profileCreateRequest.set($profileCreateRequest.get() + 1)
}
