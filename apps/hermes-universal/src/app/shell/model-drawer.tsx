import { useStore } from '@nanostores/react'
import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { HighlightMatches } from '@/components/ui/highlight-matches'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import type { HermesGateway } from '@/hermes'
import { useI18n } from '@/i18n'
import { ChevronLeft, ChevronRight, X } from '@/lib/icons'
import { modelOptionsQueryKey, requestModelOptions } from '@/lib/model-options'
import { modelDisplayParts, reasoningEffortLabel } from '@/lib/model-status-label'
import { cn } from '@/lib/utils'
import { $visibleModels, effectiveVisibleKeys, type ModelFamily } from '@/store/model-visibility'
import { $activeGatewayProfile } from '@/store/profile'
import type { ModelOptionProvider, ModelOptionsResponse } from '@/types/hermes'

import { groupModels, type ModelMenuController } from './model-catalog-menu'
import { DEFAULT_REASONING_EFFORT, REASONING_EFFORTS, resolveFastControl } from './model-edit-submenu'

/**
 * The model picker as a bottom DRAWER, for touch.
 *
 * WHY THIS EXISTS RATHER THAN REUSING THE MENU. `ModelCatalogMenu` is built out
 * of Radix `DropdownMenu*` primitives, which only work inside a menu root, and
 * it reaches thinking depth through a HOVER submenu. Neither survives a
 * fingertip: there is no hover, and a popover anchored to a 48px pill on a
 * 390px screen is the bug this replaces. So the ROWS are native here.
 *
 * WHAT IS NOT REBUILT. Everything that decides WHICH models you see and what
 * picking one MEANS is imported, not copied — `groupModels` (curation, search
 * widening, provider ordering), `effectiveVisibleKeys` (the Edit Models
 * shortlist), `resolveFastControl`, `REASONING_EFFORTS`, and the caller's
 * `ModelMenuController`. A second implementation of any of those is how this
 * drawer and the desktop menu would start disagreeing about the same catalog.
 *
 * TWO PAGES, NOT A NESTED MENU. The list is page one; tapping a row's chevron
 * slides to that model's thinking levels. Nesting is what made the desktop
 * version untouchable, and a full-width row is the only shape that reliably
 * clears `--touch-target-min`.
 */

interface ModelDrawerProps {
  controller: ModelMenuController
  gateway?: HermesGateway
  onOpenChange: (open: boolean) => void
  open: boolean
  profile?: null | string
  sessionId?: null | string
}

/** Which model's thinking levels are showing, or null for the model list. */
interface EffortPage {
  family: ModelFamily
  provider: ModelOptionProvider
}

const ROW = cn(
  'flex w-full items-center gap-3 px-4 text-start',
  // Height comes from the touch token, not from the text. Rows are the whole
  // interaction here, so this is the one measurement that must not be padding.
  'min-h-(--touch-target-min)',
  'hover:bg-(--ui-row-hover-background) active:bg-(--ui-row-hover-background)'
)

export function ModelDrawer({ controller, gateway, onOpenChange, open, profile, sessionId = null }: ModelDrawerProps) {
  const { t } = useI18n()
  const copy = t.shell.modelMenu
  const [search, setSearch] = useState('')
  const [effortPage, setEffortPage] = useState<EffortPage | null>(null)
  const activeProfile = useStore($activeGatewayProfile)
  const visibleModels = useStore($visibleModels)

  const modelOptions = useQuery({
    queryKey: modelOptionsQueryKey(profile ?? activeProfile, sessionId),
    queryFn: (): Promise<ModelOptionsResponse> => requestModelOptions({ gateway, sessionId })
  })

  const pickerProviders = useMemo(
    () => modelOptions.data?.providers?.filter(provider => provider.slug.toLowerCase() !== 'moa') ?? [],
    [modelOptions.data]
  )

  const current = controller.current

  const groups = useMemo(
    () =>
      groupModels(
        pickerProviders,
        search,
        { model: current.model, provider: current.provider },
        effectiveVisibleKeys(visibleModels, pickerProviders)
      ),
    [pickerProviders, search, current.model, current.provider, visibleModels]
  )

  // Same restore-the-remembered-preset rule the desktop menu applies on select,
  // so picking a model in either place lands on the same settings.
  const selectFamily = async (family: ModelFamily, provider: ModelOptionProvider) => {
    const caps = provider.capabilities?.[family.id]
    const preset = controller.presetFor(provider.slug, family.id)
    const variantFast = !(caps?.fast ?? false) && !!family.fastId
    const targetId = variantFast && preset.fast === true ? family.fastId! : family.id

    if ((await controller.select(targetId, provider.slug)) === false) {
      return
    }

    controller.applyPreset(
      {
        effort: (caps?.reasoning ?? true) ? (preset.effort ?? DEFAULT_REASONING_EFFORT) : undefined,
        fast: (caps?.fast ?? false) ? (preset.fast ?? false) : undefined
      },
      { model: family.id, provider: provider.slug }
    )

    onOpenChange(false)
  }

  const close = () => {
    onOpenChange(false)
    // Reset to page one on the way out: reopening into a submenu you left behind
    // reads as the drawer having remembered the wrong thing.
    setEffortPage(null)
    setSearch('')
  }

  return (
    <Sheet
      onOpenChange={next => {
        if (!next) {
          close()

          return
        }

        onOpenChange(true)
      }}
      open={open}
    >
      {/* `showCloseButton={false}`: SheetContent floats its own close in the
          corner, which would sit on top of the header's — two controls for one
          action, and the floating one is 27px, under the touch floor. */}
      <SheetContent
        className="flex max-h-[calc(var(--visual-viewport-height,100vh)-4rem)] flex-col gap-0 p-0"
        showCloseButton={false}
        side="bottom"
      >
        {effortPage ? (
          <EffortHeader
            model={modelDisplayParts(effortPage.family.id).name}
            onBack={() => setEffortPage(null)}
            onClose={close}
          />
        ) : (
          <SearchHeader onChange={setSearch} onClose={close} placeholder={copy.search} value={search} />
        )}

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-(--safe-area-inset-bottom)">
          {effortPage ? (
            <EffortList controller={controller} current={current} page={effortPage} />
          ) : modelOptions.isPending && !modelOptions.data ? (
            <div className="space-y-2 p-4">
              {[0, 1, 2].map(i => (
                <Skeleton className="h-(--touch-target-min) w-full" key={i} />
              ))}
            </div>
          ) : (
            <ModelList
              controller={controller}
              current={current}
              groups={groups}
              onOpenEffort={setEffortPage}
              onSelect={selectFamily}
              search={search}
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function SearchHeader({
  onChange,
  onClose,
  placeholder,
  value
}: {
  onChange: (next: string) => void
  onClose: () => void
  placeholder: string
  value: string
}) {
  const close = useI18n().t.common.close

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border/65 p-3">
      {/* `SheetTitle` is required for the dialog's accessible name; visually it
          is the search field that reads as the header, so the title is
          screen-reader only. */}
      <SheetTitle className="sr-only">{placeholder}</SheetTitle>
      <Input
        aria-label={placeholder}
        autoComplete="off"
        className="h-(--touch-target-min) flex-1"
        onChange={event => onChange(event.target.value)}
        placeholder={placeholder}
        value={value}
      />
      <Button aria-label={close} className="shrink-0" onClick={onClose} size="icon" type="button" variant="ghost">
        <X className="size-5" />
      </Button>
    </div>
  )
}

function EffortHeader({ model, onBack, onClose }: { model: string; onBack: () => void; onClose: () => void }) {
  const common = useI18n().t.common

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border/65 p-3">
      <Button aria-label={common.back} className="shrink-0" onClick={onBack} size="icon" type="button" variant="ghost">
        <ChevronLeft className="size-5" />
      </Button>
      <SheetTitle className="min-w-0 flex-1 truncate text-sm font-medium">{model}</SheetTitle>
      <Button aria-label={common.close} className="shrink-0" onClick={onClose} size="icon" type="button" variant="ghost">
        <X className="size-5" />
      </Button>
    </div>
  )
}

function ModelList({
  controller,
  current,
  groups,
  onOpenEffort,
  onSelect,
  search
}: {
  controller: ModelMenuController
  current: ModelMenuController['current']
  groups: ReturnType<typeof groupModels>
  onOpenEffort: (page: EffortPage) => void
  onSelect: (family: ModelFamily, provider: ModelOptionProvider) => void
  search: string
}) {
  const { t } = useI18n()
  const copy = t.shell.modelMenu
  const options = t.shell.modelOptions

  if (groups.length === 0) {
    return <p className="p-4 text-center text-sm text-(--ui-text-tertiary)">{copy.noModels}</p>
  }

  return (
    <>
      {groups.map(group => (
        <div key={group.provider.slug}>
          <p className="px-4 pt-3 pb-1 text-xs font-medium tracking-wide text-(--ui-text-tertiary) uppercase">
            {group.provider.name}
          </p>
          {group.families.map(family => {
            const isCurrent =
              group.provider.slug === current.provider &&
              (current.model === family.id || current.model === family.fastId)

            const caps = group.provider.capabilities?.[family.id]
            const preset = controller.presetFor(group.provider.slug, family.id)
            const effEffort = isCurrent ? current.effort : (preset.effort ?? '')
            const effFast = isCurrent ? current.fast : (preset.fast ?? false)

            const fastControl = resolveFastControl(
              isCurrent ? current.model : family.id,
              group.provider.models ?? [],
              caps?.fast ?? false,
              effFast
            )

            const reasoning = caps?.reasoning ?? true

            const meta = [
              fastControl.kind !== 'none' && fastControl.on ? copy.fast : null,
              reasoning ? reasoningEffortLabel(effEffort) || copy.medium : null
            ]
              .filter(Boolean)
              .join(' ')

            return (
              <div className="flex items-stretch" key={`${group.provider.slug}:${family.id}`}>
                {/* The row commits the model. The chevron is a SEPARATE button
                    so a tap that means "change the thinking level" cannot also
                    switch the model out from under you — on a pointer those are
                    click vs hover, and touch has only the one gesture. */}
                <button className={cn(ROW, 'min-w-0 flex-1')} onClick={() => onSelect(family, group.provider)} type="button">
                  <span className="w-4 shrink-0">
                    {isCurrent ? <Codicon className="text-foreground" name="check" size="0.875rem" /> : null}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm">
                    <HighlightMatches query={search} text={modelDisplayParts(family.id).name} />
                  </span>
                </button>
                {reasoning ? (
                  <button
                    aria-label={`${modelDisplayParts(family.id).name} — ${options.thinking}`}
                    className={cn(
                      'flex shrink-0 items-center gap-1 px-4 text-xs text-(--ui-text-tertiary)',
                      'min-h-(--touch-target-min) hover:bg-(--ui-row-hover-background) active:bg-(--ui-row-hover-background)'
                    )}
                    onClick={() => onOpenEffort({ family, provider: group.provider })}
                    type="button"
                  >
                    {meta ? <span className="truncate">{meta}</span> : null}
                    <ChevronRight className="size-4 shrink-0 opacity-60" />
                  </button>
                ) : null}
              </div>
            )
          })}
        </div>
      ))}
    </>
  )
}

function EffortList({
  controller,
  current,
  page
}: {
  controller: ModelMenuController
  current: ModelMenuController['current']
  page: EffortPage
}) {
  const { t } = useI18n()
  const options = t.shell.modelOptions

  const isActive =
    page.provider.slug === current.provider &&
    (current.model === page.family.id || current.model === page.family.fastId)

  const preset = controller.presetFor(page.provider.slug, page.family.id)
  const effort = isActive ? current.effort : (preset.effort ?? '')

  // `none` is Allr' "thinking off" and is not one of the real levels, so it is
  // prepended rather than living in REASONING_EFFORTS.
  const levels = ['none', ...REASONING_EFFORTS]

  return (
    <>
      {levels.map(level => {
        const selected = (effort || DEFAULT_REASONING_EFFORT) === level

        return (
          <button
            className={ROW}
            key={level}
            onClick={() =>
              controller.setOptions(
                { effort: level },
                { isActive, model: page.family.id, provider: page.provider.slug }
              )
            }
            type="button"
          >
            <span className="w-4 shrink-0">
              {selected ? <Codicon className="text-foreground" name="check" size="0.875rem" /> : null}
            </span>
            <span className="flex-1 text-sm">{reasoningEffortLabel(level) || options.medium}</span>
          </button>
        )
      })}
    </>
  )
}
