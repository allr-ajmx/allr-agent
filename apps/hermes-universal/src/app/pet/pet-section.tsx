import { useEffect, useState } from 'react'

import { EmptyState, ListRow, Pill, SectionHeading, SettingsContent } from '@/app/settings/primitives'
import { Button } from '@/components/ui/button'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Skeleton } from '@/components/ui/skeleton'
import { useI18n } from '@/i18n'
import { Loader2, Paw } from '@/lib/icons'
import { selectableCardClass } from '@/lib/selectable-card'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import { $gatewayState } from '@/store/gateway'
import { $petInfo, $petRoam, setPetRoam } from '@/store/pet'
import {
  $petBusy,
  $petGallery,
  $petGalleryStatus,
  adoptPet,
  loadPetGallery,
  PET_SCALE_DEFAULT,
  PET_SCALE_MAX,
  PET_SCALE_MIN,
  rankedGalleryPets,
  setPetEnabled,
  setPetScale
} from '@/store/pet-gallery'
import { $petGenOpen } from '@/store/pet-generate'

import { PetGenerateSheet } from './pet-generate-sheet'
import { PetSprite } from './pet-sprite'
import { PetThumb } from './pet-thumb'

// Shared search-input chrome (matches the theme grid's search on Appearance).
const SEARCH_CHROME =
  'w-full rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-bg-quinary) px-3 py-1.5 text-[length:var(--conversation-caption-font-size)] outline-none placeholder:text-(--ui-text-tertiary) focus:border-(--ui-stroke-secondary)'

// The petdex catalog is thousands of entries and each card loads a thumbnail over
// the gateway, so rank them and render a page at a time (desktop caps at 60 and
// leaves the rest to search; here the cap also grows on demand).
const RENDER_CAP = 60
const RENDER_PAGE = 60

// A live mascot at the chosen size, sitting under the size slider.
//
// On a phone the pet is unmounted for as long as a settings surface is up — it
// patrols an overlay ledge that a full-screen route surface doesn't have — so
// without this the slider has NO visible effect until you leave the screen,
// which is indistinguishable from "the size change didn't take". The box clips:
// past roughly half scale the pet outgrows it, which is itself the signal.
function PetScalePreview() {
  return (
    <div className="mt-2 flex h-24 items-center justify-center overflow-hidden rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-bg-quinary)">
      <PetSprite />
    </div>
  )
}

// Pet settings, laid out like the desktop `PetSettings` (nested at the bottom of
// Appearance): enable + choose-a-pet grid, size slider, roam toggle. `PetPanel`
// is chrome-free so it can nest inside another SettingsContent.
export function PetPanel() {
  const { t } = useI18n()
  const p = t.settings.appearance.pet
  const gallery = useStore($petGallery)
  const status = useStore($petGalleryStatus)
  const busy = useStore($petBusy)
  const petInfo = useStore($petInfo)
  const roam = useStore($petRoam)
  // Sheet open state lives in the store so `/hatch` can open it from the slash
  // dispatcher (which routes here first — the sheet only mounts on this page).
  const generateOpen = useStore($petGenOpen)
  const setGenerateOpen = (open: boolean) => $petGenOpen.set(open)
  const gatewayState = useStore($gatewayState)
  const [query, setQuery] = useState('')
  const [cap, setCap] = useState(RENDER_CAP)

  // The gallery RPC rejects outright before the socket is up, which would wedge
  // the status atom on 'loading' until the user navigated away and back.
  useEffect(() => {
    if (gatewayState === 'open') {
      void loadPetGallery()
    }
  }, [gatewayState])

  const enabled = gallery?.enabled ?? false
  const scale = petInfo.scale ?? PET_SCALE_DEFAULT
  const active = gallery?.active ?? ''
  const ranked = rankedGalleryPets(gallery, query)
  const shown = ranked.slice(0, cap)
  const q = query.trim()

  const search = (value: string) => {
    setQuery(value)
    setCap(RENDER_CAP)
  }

  const onOff = [
    { id: 'off', label: p.off },
    { id: 'on', label: p.on }
  ] as const

  return (
    <>
      <SectionHeading icon={Paw} title={p.title} />
      <p className="max-w-2xl text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ui-text-tertiary)">
        {p.intro}
      </p>
      {status === 'stale' && (
        <p className="mt-2 text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
          {p.restartHint}
        </p>
      )}

      <div className="mt-2">
        <ListRow
          below={
            <>
              <input
                className={cn('mt-3', SEARCH_CHROME)}
                onChange={event => search(event.target.value)}
                placeholder={p.searchPlaceholder}
                spellCheck={false}
                value={query}
              />
              <div className="mt-3 h-72 overflow-y-auto pr-1">
                {status === 'loading' && shown.length === 0 ? (
                  // First load keeps the grid's shape rather than flashing the
                  // "unreachable" copy before the gallery has even arrived.
                  <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                    {Array.from({ length: 6 }, (_, index) => (
                      <div className="flex items-center gap-2.5 px-2.5 py-2" key={index}>
                        <Skeleton className="size-10 shrink-0 rounded-md" />
                        <div className="min-w-0 flex-1 space-y-1.5">
                          <Skeleton className="h-3.5 w-24 max-w-full" />
                          <Skeleton className="h-3 w-16 max-w-full" />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : shown.length === 0 ? (
                  <p className="text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
                    {q ? p.noMatch(q) : p.unreachable}
                  </p>
                ) : (
                  <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                    {shown.map(pet => {
                      const isActive = enabled && active === pet.slug
                      const isBusy = busy === pet.slug

                      return (
                        <button
                          className={cn(
                            'flex w-full items-center gap-2.5 px-2.5 py-2 text-left disabled:opacity-50',
                            selectableCardClass({ active: isActive, prominent: pet.installed })
                          )}
                          disabled={isBusy}
                          key={pet.slug}
                          onClick={() => void adoptPet(pet.slug)}
                          type="button"
                        >
                          <PetThumb slug={pet.slug} url={pet.spritesheetUrl} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium text-foreground">
                              {pet.displayName}
                            </span>
                            {pet.generated && <Pill>{p.generatedTag}</Pill>}
                          </span>
                          {isBusy && <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />}
                        </button>
                      )
                    })}
                  </div>
                )}
                {ranked.length > shown.length && (
                  <div className="mt-3 flex items-center justify-between gap-3">
                    <span className="text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
                      {p.countCapped(shown.length, ranked.length)}
                    </span>
                    <Button onClick={() => setCap(c => c + RENDER_PAGE)} size="inline" variant="text">
                      {t.sidebar.loadMore}
                    </Button>
                  </div>
                )}
              </div>
              {/* <div className="mt-2"> */}
              {/*   <Button className="w-full" onClick={() => setGenerateOpen(true)} variant="outline"> */}
              {/*     <Sparkles className="size-4" /> */}
              {/*     {t.commandCenter.generatePet.title} */}
              {/*   </Button> */}
              {/* </div> */}
            </>
          }
          description={p.chooseDesc}
          title={
            <div className="flex items-center justify-between gap-3">
              <span>{p.chooseTitle}</span>
              <SegmentedControl
                onChange={id => void setPetEnabled(id === 'on')}
                options={onOff}
                value={enabled ? 'on' : 'off'}
              />
            </div>
          }
          wide
        />

        {enabled && (
          <ListRow
            action={
              <div className="flex items-center gap-3">
                <input
                  aria-label={p.scaleTitle}
                  className="h-1 w-40 cursor-pointer appearance-none rounded-full bg-(--ui-stroke-tertiary)"
                  max={PET_SCALE_MAX}
                  min={PET_SCALE_MIN}
                  onChange={event => setPetScale(Number(event.target.value))}
                  step={0.05}
                  style={{ accentColor: 'var(--dt-primary)' }}
                  type="range"
                  value={scale}
                />
                <span className="w-9 text-right text-[length:var(--conversation-caption-font-size)] tabular-nums text-(--ui-text-tertiary)">
                  {`${Math.round(scale * 100)}%`}
                </span>
              </div>
            }
            below={<PetScalePreview />}
            description={p.scaleDesc}
            title={p.scaleTitle}
          />
        )}

        {enabled && (
          <ListRow
            action={
              <SegmentedControl onChange={id => setPetRoam(id === 'on')} options={onOff} value={roam ? 'on' : 'off'} />
            }
            description={p.roamDesc}
            title={p.roamTitle}
          />
        )}
      </div>

      <PetGenerateSheet onOpenChange={setGenerateOpen} open={generateOpen} />
    </>
  )
}

// Standalone route wrapper (kept for the `/settings/pet` deep-link).
export function PetSection() {
  const { t } = useI18n()
  const status = useStore($petGalleryStatus)
  const gallery = useStore($petGallery)

  // No page-level spinner: the panel's gallery grid carries its own skeleton,
  // so the page keeps its heading, intro and controls while the pets land.
  if (status === 'error' && !gallery) {
    return (
      <SettingsContent>
        <EmptyState title={t.commandCenter.pets.error} />
      </SettingsContent>
    )
  }

  return (
    <SettingsContent>
      <PetPanel />
    </SettingsContent>
  )
}
