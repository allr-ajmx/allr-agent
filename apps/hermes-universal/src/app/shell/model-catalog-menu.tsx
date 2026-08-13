import { useStore } from '@nanostores/react'
import { useQuery } from '@tanstack/react-query'
import { createContext, type ReactNode, useContext, useMemo, useState } from 'react'

import { Codicon } from '@/components/ui/codicon'
import { DisclosureCaret } from '@/components/ui/disclosure-caret'
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  dropdownMenuRow,
  DropdownMenuSearch,
  dropdownMenuSectionLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { HighlightMatches } from '@/components/ui/highlight-matches'
import { Skeleton } from '@/components/ui/skeleton'
import type { HermesGateway } from '@/hermes'
import { useI18n } from '@/i18n'
import { modelOptionsQueryKey, requestModelOptions } from '@/lib/model-options'
import { modelDisplayParts, reasoningEffortLabel } from '@/lib/model-status-label'
import { cn } from '@/lib/utils'
import {
  $visibleModels,
  curatedFamilies,
  effectiveVisibleKeys,
  type ModelFamily,
  setModelVisibilityOpen
} from '@/store/model-visibility'
import { $activeGatewayProfile } from '@/store/profile'
import { $collapsedProviders, toggleCollapsedProvider } from '@/store/provider-collapse'
import type { ModelOptionProvider, ModelOptionsResponse } from '@/types/hermes'

import { ModelEditSubmenu, resolveFastControl } from './model-edit-submenu'

// Lets the host dropdown (the composer's model pill, a plugin's field trigger,
// …) hand the panel a way to dismiss itself so clicking a model row commits +
// closes, while the hover-revealed edit submenu (reasoning/fast) stays open to
// play with (its items preventDefault on select).
export const ModelMenuCloseContext = createContext<() => void>(() => {})

/** One model choice — everything a caller needs to act on a selection.
 *  `effort` is '' for "inherit the default" and 'none' for thinking off. */
export interface ModelChoice {
  effort: string
  fast: boolean
  model: string
  provider: string
}

/**
 * What a surface DOES with the catalog. The menu renders and navigates; the
 * controller owns meaning — the composer writes through to a live session, a
 * plugin's per-task override just holds a value in dialog state.
 *
 * `presetFor` supplies the remembered settings shown on a non-active row.
 * Returning `{}` is fine — the row then shows Hermes' defaults.
 */
export interface ModelMenuController {
  /** Restore a model's remembered settings after it is selected. Separate from
   *  `setOptions` because it is one atomic "apply this model's preset" write,
   *  not a user editing one control — surfaces that write through to a session
   *  need to batch it. Values are already capability-gated by the menu. */
  applyPreset: (preset: { effort?: string; fast?: boolean }, row: { model: string; provider: string }) => void
  current: ModelChoice
  presetFor: (provider: string, model: string) => { effort?: string; fast?: boolean }
  /** Commit a model row. Return false to abort (a failed session switch). */
  select: (model: string, provider: string) => Promise<boolean | void> | void
  /** Edit ONE option on a row. `isActive` says whether it's the current model. */
  setOptions: (
    patch: { effort?: string; fast?: boolean },
    row: { isActive: boolean; model: string; provider: string }
  ) => void
}

interface ModelCatalogMenuProps {
  controller: ModelMenuController
  /** Rows appended under the catalog (Refresh Models, …), above Edit Models. */
  footer?: ReactNode
  gateway?: HermesGateway
  /** Render the virtual `moa` provider's presets as a selectable section. Off
   *  for override surfaces, where a MoA preset isn't a worker model. */
  includeMoa?: boolean
  /** Gateway profile whose catalog to fetch. Omit to follow the active one —
   *  the right answer for every in-app surface, and the only answer a plugin
   *  can give without reaching into the app's stores. */
  profile?: string
  /** Session whose catalog to fetch. A live session's catalog can differ from
   *  the profile-global one, and the app invalidates the SESSION-scoped query
   *  key on model changes — a surface bound to a session must pass it or its
   *  menu goes stale. Detached surfaces (per-task overrides) omit it. */
  sessionId?: null | string
}

interface ProviderGroup {
  families: ModelFamily[]
  provider: ModelOptionProvider
}

/**
 * THE model catalog menu: searchable, provider-grouped, `-fast` families
 * collapsed to one row, and a per-row hover submenu for thinking depth / fast.
 * Shared verbatim by the composer's model pill and by plugin surfaces that pick
 * a model with no session behind it — so the two can never drift apart.
 *
 * Curation is NOT decided here: `curatedFamilies` (store/model-visibility) says
 * which families a surface shows, so this menu, the ⌘⇧M picker dialog and Edit
 * Models all agree on the shortlist and on what typing widens it to.
 */
export function ModelCatalogMenu({
  controller,
  footer,
  gateway,
  includeMoa = false,
  profile,
  sessionId = null
}: ModelCatalogMenuProps) {
  const { t } = useI18n()
  const copy = t.shell.modelMenu
  const closeMenu = useContext(ModelMenuCloseContext)
  const [search, setSearch] = useState('')
  const activeProfile = useStore($activeGatewayProfile)
  const collapsedProviders = useStore($collapsedProviders)
  // Which models the user curated in Edit Models. Read HERE rather than taken
  // as a prop: it is one global preference, so every surface that shows a
  // catalog shows the same shortlist. A per-caller opt-in is how a plugin and
  // the composer would end up disagreeing about what "my models" means.
  const visibleModels = useStore($visibleModels)

  const modelOptions = useQuery({
    queryKey: modelOptionsQueryKey(profile ?? activeProfile, sessionId),
    // Gateway-first even with no session: a connected (possibly remote)
    // gateway owns the model catalog, including virtual providers like `moa`
    // that the local REST fallback can't know about (#53817).
    queryFn: (): Promise<ModelOptionsResponse> => requestModelOptions({ gateway, sessionId })
  })

  const loading = modelOptions.isPending && !modelOptions.data

  const error = modelOptions.error
    ? modelOptions.error instanceof Error
      ? modelOptions.error.message
      : String(modelOptions.error)
    : null

  const providers = modelOptions.data?.providers

  // The catalog carries MoA presets as a virtual `moa` provider row. Keep it
  // out of the main groups so presets never show up twice.
  const moaPresets = useMemo(
    () => (includeMoa ? (providers?.find(provider => provider.slug.toLowerCase() === 'moa')?.models ?? []) : []),
    [providers, includeMoa]
  )

  const pickerProviders = useMemo(
    () => providers?.filter(provider => provider.slug.toLowerCase() !== 'moa') ?? [],
    [providers]
  )

  const current = controller.current

  const effectiveVisibleModels = useMemo(
    () => effectiveVisibleKeys(visibleModels, pickerProviders),
    [visibleModels, pickerProviders]
  )

  const groups = useMemo(
    () =>
      groupModels(
        pickerProviders,
        search,
        { model: current.model, provider: current.provider },
        effectiveVisibleModels
      ),
    [pickerProviders, search, current.model, current.provider, effectiveVisibleModels]
  )

  // Selecting a model row restores that model's remembered preset (effort/fast),
  // capability-gated. What "restore" MEANS is the controller's call.
  const selectFamily = async (family: ModelFamily, provider: ModelOptionProvider) => {
    const caps = provider.capabilities?.[family.id]
    const preset = controller.presetFor(provider.slug, family.id)

    // Variant-fast models (no speed param) express "fast" as a separate `-fast`
    // id, so honor the remembered preset by selecting that sibling. Param-fast
    // is applied through applyPreset below instead.
    const variantFast = !(caps?.fast ?? false) && !!family.fastId
    const targetId = variantFast && preset.fast === true ? family.fastId! : family.id

    if ((await controller.select(targetId, provider.slug)) === false) {
      return
    }

    controller.applyPreset(
      {
        effort: (caps?.reasoning ?? true) ? (preset.effort ?? 'medium') : undefined,
        fast: (caps?.fast ?? false) ? (preset.fast ?? false) : undefined
      },
      { model: family.id, provider: provider.slug }
    )
  }

  const selectMoaPreset = async (preset: string) => {
    if ((await controller.select(preset, 'moa')) === false) {
      return
    }

    closeMenu()
  }

  return (
    <>
      <DropdownMenuSearch aria-label={copy.search} onValueChange={setSearch} placeholder={copy.search} value={search} />

      <DropdownMenuSeparator className="mx-0" />

      {loading ? (
        <DropdownMenuGroup className="py-1">
          {Array.from({ length: 4 }, (_, index) => (
            <DropdownMenuItem
              className={dropdownMenuRow}
              disabled
              key={index}
              onSelect={event => event.preventDefault()}
            >
              <Skeleton className="h-4 w-full" />
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      ) : error ? (
        <DropdownMenuItem className={dropdownMenuRow} disabled>
          {error}
        </DropdownMenuItem>
      ) : groups.length === 0 && moaPresets.length === 0 ? (
        <DropdownMenuItem className={dropdownMenuRow} disabled>
          {copy.noModels}
        </DropdownMenuItem>
      ) : (
        <div className="max-h-[max(150px,30dvh)] overflow-y-auto py-0.5">
          {groups.map(group => {
            const slug = group.provider.slug

            // Collapsed when the user stored it (and not while searching, which
            // spans every model regardless of collapse state).
            const collapsed = collapsedProviders.includes(slug) && !search

            return (
              <DropdownMenuGroup className="py-0.5" key={slug}>
                <DropdownMenuItem
                  className="group/label flex w-full cursor-pointer items-center gap-1 !bg-transparent px-2 pb-0.5 pt-0.5 text-[0.625rem] font-semibold uppercase tracking-wider text-(--ui-text-tertiary) focus:!bg-transparent"
                  onSelect={event => {
                    event.preventDefault()
                    toggleCollapsedProvider(slug)
                  }}
                  textValue=""
                >
                  <span className="truncate">
                    <HighlightMatches query={search} text={group.provider.name} />
                  </span>
                  <DisclosureCaret
                    className="shrink-0 text-(--ui-text-tertiary) opacity-0 transition group-hover/label:opacity-100"
                    open={!collapsed}
                    size="0.625rem"
                  />
                </DropdownMenuItem>
                {!collapsed &&
                  group.families.map(family => {
                    // The active id may be the base or its -fast sibling; either
                    // way this one family row represents both.
                    const activeId =
                      group.provider.slug === current.provider &&
                      (current.model === family.id || current.model === family.fastId)
                        ? current.model
                        : null

                    const isCurrent = activeId !== null
                    const name = modelDisplayParts(family.id).name
                    // Capabilities are looked up against the active/base id; the
                    // -fast variant carries the same param support as its base.
                    const caps = group.provider.capabilities?.[family.id]

                    // Effective settings for this row: the live choice when it's
                    // the active model, otherwise its remembered preset (Hermes
                    // defaults when unset). Row label AND submenu read from these
                    // so they never disagree.
                    const preset = controller.presetFor(group.provider.slug, family.id)
                    const effEffort = isCurrent ? current.effort : (preset.effort ?? '')
                    const effFast = isCurrent ? current.fast : (preset.fast ?? false)

                    const fastControl = resolveFastControl(
                      activeId ?? family.id,
                      group.provider.models ?? [],
                      caps?.fast ?? false,
                      effFast
                    )

                    const meta = [
                      fastControl.kind !== 'none' && fastControl.on ? copy.fast : null,
                      (caps?.reasoning ?? true) ? reasoningEffortLabel(effEffort) || copy.medium : null
                    ]
                      .filter(Boolean)
                      .join(' ')

                    // Every row is a hover-Edit submenu trigger. Activating it
                    // (pointer or keyboard) switches to the family's base model and
                    // restores its preset; the Fast toggle inside swaps to the -fast
                    // sibling (or flips the speed param). The sub-trigger has no
                    // `onSelect`, so wire both click and Enter/Space for keyboard parity.
                    // Clicking the row commits the model and closes the picker; the
                    // edit submenu (reasoning/fast) is reached by HOVER, so you can
                    // still tweak those without the click dismissing everything.
                    const activate = () => {
                      if (!isCurrent) {
                        void selectFamily(family, group.provider)
                      }

                      closeMenu()
                    }

                    return (
                      <DropdownMenuSub key={`${group.provider.slug}:${family.id}`}>
                        <DropdownMenuSubTrigger
                          className={dropdownMenuRow}
                          hideChevron
                          onClick={activate}
                          onKeyDown={event => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              activate()
                            }
                          }}
                        >
                          <span className="min-w-0 flex-1 truncate">
                            <HighlightMatches query={search} text={name} />
                            {meta ? <span className="text-(--ui-text-tertiary)"> {meta}</span> : null}
                          </span>
                          {isCurrent ? (
                            <Codicon className="ms-auto text-foreground" name="check" size="0.75rem" />
                          ) : null}
                        </DropdownMenuSubTrigger>
                        <ModelEditSubmenu
                          effort={effEffort}
                          fastControl={fastControl}
                          isActive={isCurrent}
                          onSelectModel={nextModel => controller.select(nextModel, group.provider.slug)}
                          onSetOptions={patch =>
                            controller.setOptions(patch, {
                              isActive: isCurrent,
                              model: family.id,
                              provider: group.provider.slug
                            })
                          }
                          reasoning={caps?.reasoning ?? true}
                        />
                      </DropdownMenuSub>
                    )
                  })}
              </DropdownMenuGroup>
            )
          })}
        </div>
      )}

      <DropdownMenuSeparator className="mx-0" />

      {moaPresets.length > 0 ? (
        <>
          <DropdownMenuLabel className={dropdownMenuSectionLabel}>MoA presets</DropdownMenuLabel>
          {moaPresets.map(preset => {
            const isCurrentMoa = current.provider === 'moa' && current.model === preset

            return (
              <DropdownMenuItem
                className={dropdownMenuRow}
                key={`moa:${preset}`}
                onSelect={event => {
                  event.preventDefault()
                  void selectMoaPreset(preset)
                }}
              >
                <span className="min-w-0 flex-1 truncate">MoA: {preset}</span>
                {isCurrentMoa ? <Codicon className="ms-auto text-foreground" name="check" size="0.75rem" /> : null}
              </DropdownMenuItem>
            )
          })}
          <DropdownMenuSeparator className="mx-0" />
        </>
      ) : null}

      {footer}

      {/* Curation belongs to the catalog, not to one host: wherever you can pick
          a model you can say which models you want, and the shortlist is the
          same everywhere because it is one stored preference. */}
      <DropdownMenuItem
        className={cn(dropdownMenuRow, 'text-(--ui-text-tertiary)')}
        onSelect={() => setModelVisibilityOpen(true)}
      >
        <Codicon name="settings-gear" size="0.75rem" />
        {copy.editModels}
      </DropdownMenuItem>
    </>
  )
}

/** Re-exported so a caller building a footer row matches the catalog's rows. */
export { dropdownMenuRow }

// Which families each provider contributes is decided by `curatedFamilies` in
// store/model-visibility — the featured shortlist, the user's Edit Models
// choices and the search widening are all one implementation shared with the
// full picker and the Edit Models dialog. All this does is drop empty providers
// and put the groups in a stable order.

function groupModels(
  providers: ModelOptionProvider[],
  search: string,
  current: { model: string; provider: string },
  visible: Set<string>
): ProviderGroup[] {
  const groups: ProviderGroup[] = []

  for (const provider of providers) {
    const activeModel = provider.slug === current.provider ? current.model : undefined
    const families = curatedFamilies(provider, { activeModel, search, visible })

    if (families.length > 0) {
      groups.push({ families, provider })
    }
  }

  // Stable, logical group order: alphabetical by provider name. (The backend
  // floats the current provider first, which would reshuffle on every switch.)
  groups.sort((a, b) => a.provider.name.localeCompare(b.provider.name))

  return groups
}
