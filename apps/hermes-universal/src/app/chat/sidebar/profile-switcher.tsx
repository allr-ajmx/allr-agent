import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

import { PROFILES_ROUTE } from '@/app/routes'
import { Codicon } from '@/components/ui/codicon'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import { $activeProfile, $profiles, refreshProfiles, setActiveProfile } from '@/store/profiles'

// The bottom profile rail (Arc-Spaces-style strip), ported/adapted from desktop
// `profile-switcher.tsx`. Universal is single-profile-centric (E7), so this is a
// lean version: a default (home) toggle, the named-profile squares that switch
// the active profile, and add / manage entries into the Profiles screen.
// FIXME(MJX-108): drag-reorder, long-press recolor, and the "all profiles" scope
// are not ported. Recolor needs a color store first — see `colorForName` below,
// which derives the hue from the name and so has nothing to recolor into.

// Stable per-name hue so each profile square is visually distinct without a
// dedicated color store.
function colorForName(name: string): string {
  let hue = 0

  for (let i = 0; i < name.length; i++) {
    hue = (hue * 31 + name.charCodeAt(i)) % 360
  }

  return `hsl(${hue} 52% 48%)`
}

const ICON_BTN =
  'grid size-6 shrink-0 place-items-center rounded-md text-(--ui-text-tertiary) transition-colors hover:bg-(--ui-control-hover-background) hover:text-foreground'

export function ProfileRail() {
  const { t } = useI18n()
  const p = t.profiles
  const profiles = useStore($profiles)
  const active = useStore($activeProfile)
  const navigate = useNavigate()

  useEffect(() => {
    void refreshProfiles()
  }, [])

  const named = profiles.filter(profile => !profile.is_default)

  return (
    <div aria-label={p.title} className="flex items-center gap-0.5" role="tablist">
      {/* The default profile — always shown as a home icon, leftmost. */}
      <button
        aria-selected={active === null}
        className={cn(ICON_BTN, active === null && 'bg-(--ui-control-active-background) text-foreground')}
        onClick={() => setActiveProfile(null)}
        role="tab"
        title={p.default}
        type="button"
      >
        <Codicon name="home" size="0.875rem" />
      </button>

      {/* Add — to the right of the default. */}
      <button
        aria-label={p.newProfile}
        className={ICON_BTN}
        onClick={() => navigate(PROFILES_ROUTE)}
        title={p.newProfile}
        type="button"
      >
        <Codicon name="add" size="0.875rem" />
      </button>

      {/* Named profiles. */}
      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
        {named.map(profile => {
          const isActive = active === profile.name

          return (
            <button
              aria-selected={isActive}
              className={cn(
                'grid size-6 shrink-0 place-items-center rounded-md text-[0.625rem] font-semibold text-white transition',
                isActive
                  ? 'ring-2 ring-(--ui-accent) ring-offset-1 ring-offset-(--ui-sidebar-surface-background)'
                  : 'opacity-80 hover:opacity-100'
              )}
              key={profile.name}
              onClick={() => setActiveProfile(profile.name)}
              role="tab"
              style={{ backgroundColor: colorForName(profile.name) }}
              title={p.switchToProfile(profile.name)}
              type="button"
            >
              {profile.name.charAt(0).toUpperCase()}
            </button>
          )
        })}
      </div>

      {/* Manage — right. */}
      <button
        aria-label={p.manageProfiles}
        className={ICON_BTN}
        onClick={() => navigate(PROFILES_ROUTE)}
        title={p.manageProfiles}
        type="button"
      >
        <Codicon name="ellipsis" size="0.875rem" />
      </button>
    </div>
  )
}
