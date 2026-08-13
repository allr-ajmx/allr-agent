import { useStore } from '@nanostores/react'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { ErrorBanner } from '@/components/ui/error-state'
import { HighlightMatches } from '@/components/ui/highlight-matches'
import { releaseTypingFocus } from '@/components/ui/keyboard-first'
import { Skeleton } from '@/components/ui/skeleton'
import type { HermesGateway } from '@/hermes'
import { useI18n } from '@/i18n'
import { modelOptionsQueryKey, requestModelOptions } from '@/lib/model-options'
import { currentPickerSelection, modelDisplayParts } from '@/lib/model-status-label'
import { cn } from '@/lib/utils'
import {
  $visibleModels,
  curatedFamilies,
  effectiveVisibleKeys,
  type ModelFamily,
  setModelVisibilityOpen
} from '@/store/model-visibility'
import type { ModelOptionProvider, ModelOptionsResponse, ModelPricing } from '@/types/hermes'

export interface ModelPickerSelection {
  model: string
  provider: string
}

interface ModelPickerDialogProps {
  /** Optional class for DialogContent — lets a caller lift the picker onto a
   *  higher rung of the overlay ladder when it opens over another fixed
   *  overlay, where the default modal rung would render underneath it. */
  contentClassName?: string
  currentModel: string
  currentProvider: string
  gw?: HermesGateway
  onOpenChange: (open: boolean) => void
  /** Hand-off to the provider setup surface, from the footer. */
  onOpenProviders?: () => void
  onSelect: (selection: ModelPickerSelection) => void
  open: boolean
  profile?: string
  sessionId?: null | string
}

/**
 * The shared model picker: a cmdk command palette over the profile's model
 * catalog, in a dialog. Keyboard-first — the search box takes focus on open and
 * ↑/↓/Enter move and commit without ever touching the mouse.
 *
 * Curation is NOT decided here. `curatedFamilies` (store/model-visibility) says
 * which families a surface shows, so the composer dropdown, this dialog and Edit
 * Models all agree on the featured shortlist and on what typing widens it to.
 * Anything past the shortlist is one keystroke away in the search box.
 */
export function ModelPickerDialog({
  contentClassName,
  currentModel,
  currentProvider,
  gw,
  onOpenChange,
  onOpenProviders,
  onSelect,
  open,
  profile = 'default',
  sessionId
}: ModelPickerDialogProps) {
  const { t } = useI18n()
  const copy = t.modelPicker
  // We own the search term and filter manually. cmdk's built-in shouldFilter
  // reorders items by its fuzzy-match score (≈alphabetical with an empty
  // query), which destroys the backend's curated order. Disable it and let
  // `curatedFamilies` do a plain in-order substring filter, matching the
  // `hermes model` CLI picker, which shows the curated list verbatim.
  const [search, setSearch] = useState('')
  const storedVisible = useStore($visibleModels)

  const modelOptions = useQuery({
    queryKey: modelOptionsQueryKey(profile, sessionId),
    queryFn: (): Promise<ModelOptionsResponse> => requestModelOptions({ gateway: gw, sessionId }),
    enabled: open
  })

  const providers = modelOptions.data?.providers ?? []

  const { model: optionsModel, provider: optionsProvider } = currentPickerSelection(
    !!sessionId,
    { model: currentModel, provider: currentProvider },
    modelOptions.data
  )

  const loading = modelOptions.isPending && !modelOptions.data

  const error = modelOptions.error
    ? modelOptions.error instanceof Error
      ? modelOptions.error.message
      : String(modelOptions.error)
    : null

  // Every exit from the picker goes through here. Radix returns focus to the
  // TRIGGER on close — a composer pill or a toolbar button — so committing with
  // Enter would otherwise leave the next keystroke going nowhere instead of into
  // the message being written. releaseTypingFocus hands the keyboard back.
  const close = () => {
    onOpenChange(false)
    releaseTypingFocus()
  }

  const selectModel = (provider: ModelOptionProvider, model: string) => {
    onSelect({ model, provider: provider.slug })
    close()
  }

  return (
    <Dialog onOpenChange={next => (next ? onOpenChange(true) : close())} open={open}>
      <DialogContent className={cn('max-h-[85vh] max-w-2xl gap-0 overflow-hidden p-0', contentClassName)}>
        <DialogHeader className="border-b border-border px-4 py-3">
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription className="font-mono text-xs leading-relaxed">
            {copy.current} {optionsModel || currentModel || copy.unknown}
            {optionsProvider || currentProvider ? ` · ${optionsProvider || currentProvider}` : ''}
          </DialogDescription>
        </DialogHeader>

        <Command className="rounded-none bg-card" shouldFilter={false}>
          <CommandInput autoFocus onValueChange={setSearch} placeholder={copy.search} value={search} />
          <CommandList className="max-h-96">
            {!loading && !error && <CommandEmpty>{copy.noModels}</CommandEmpty>}
            <ModelResults
              currentModel={optionsModel || currentModel}
              currentProvider={optionsProvider || currentProvider}
              error={error}
              loading={loading}
              onSelectModel={selectModel}
              providers={providers}
              search={search}
              visible={effectiveVisibleKeys(storedVisible, providers)}
            />
          </CommandList>
        </Command>

        <DialogFooter className="flex-row items-center justify-end gap-2 bg-card p-3">
          <Button
            className="me-auto text-(--ui-text-tertiary)"
            onClick={() => {
              close()
              setModelVisibilityOpen(true)
            }}
            size="sm"
            variant="text"
          >
            {t.shell.modelMenu.editModels}
          </Button>
          {onOpenProviders && (
            <Button
              onClick={() => {
                close()
                onOpenProviders()
              }}
              size="sm"
              variant="ghost"
            >
              {copy.addProvider}
            </Button>
          )}
          <Button onClick={close} size="sm" variant="outline">
            {t.common.cancel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ModelResults({
  currentModel,
  currentProvider,
  error,
  loading,
  onSelectModel,
  providers,
  search,
  visible
}: {
  currentModel: string
  currentProvider: string
  error: null | string
  loading: boolean
  onSelectModel: (provider: ModelOptionProvider, model: string) => void
  providers: ModelOptionProvider[]
  search: string
  visible: Set<string>
}) {
  const { t } = useI18n()
  const copy = t.modelPicker

  if (loading) {
    return <LoadingResults />
  }

  if (error) {
    return (
      <div className="px-3 py-3">
        <ErrorBanner>{`${copy.loadFailed}: ${error}`}</ErrorBanner>
      </div>
    )
  }

  // Only configured providers (those with curated models) are selectable here.
  // Switching to a NOT-yet-configured provider goes through the footer's
  // "Add provider", which hands off to the provider setup surface.
  const configured = providers.filter(provider => (provider.models ?? []).length > 0)

  if (configured.length === 0) {
    return <div className="px-4 py-6 text-sm text-muted-foreground">{copy.noAuthenticatedProviders}</div>
  }

  return (
    <>
      {configured.map(provider => {
        const activeModel = provider.slug === currentProvider ? currentModel : undefined
        const families = curatedFamilies(provider, { activeModel, search, visible })

        if (families.length === 0) {
          return null
        }

        const unavailable = new Set(provider.unavailable_models ?? [])

        return (
          <CommandGroup heading={<ProviderHeading provider={provider} />} key={provider.slug}>
            {provider.warning && (
              <div className="px-2 pb-2">
                <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-200">
                  {provider.warning}
                </div>
              </div>
            )}
            {families.map(family => (
              <ModelRow
                family={family}
                isCurrent={provider.slug === currentProvider && currentModel === family.id}
                key={`${provider.slug}:${family.id}`}
                locked={unavailable.has(family.id)}
                onSelect={() => onSelectModel(provider, family.id)}
                price={provider.pricing?.[family.id]}
                providerSlug={provider.slug}
                search={search}
              />
            ))}
            {unavailable.size > 0 && (
              <div className="px-6 pb-2 pt-1 text-[0.62rem] leading-relaxed text-muted-foreground">
                {copy.proNeedsSubscription}
              </div>
            )}
          </CommandGroup>
        )
      })}
    </>
  )
}

function ModelRow({
  family,
  isCurrent,
  locked,
  onSelect,
  price,
  providerSlug,
  search
}: {
  family: ModelFamily
  isCurrent: boolean
  locked: boolean
  onSelect: () => void
  price?: ModelPricing
  providerSlug: string
  search: string
}) {
  const copy = useI18n().t.modelPicker
  const { tag } = modelDisplayParts(family.id)

  return (
    <CommandItem
      className={cn(
        'flex items-center gap-2 ps-6 font-mono',
        isCurrent &&
          'bg-primary text-primary-foreground data-[selected=true]:bg-primary data-[selected=true]:text-primary-foreground',
        locked && 'cursor-not-allowed opacity-45'
      )}
      disabled={locked}
      onSelect={() => {
        if (!locked) {
          onSelect()
        }
      }}
      value={`${providerSlug}:${family.id}`}
    >
      <span className="min-w-0 flex-1 truncate">
        <HighlightMatches query={search} text={family.id} />
        {tag ? <span className="text-(--ui-text-tertiary)"> {tag}</span> : null}
      </span>
      {locked && <span className="shrink-0 text-[0.62rem] uppercase tracking-wide opacity-80">{copy.pro}</span>}
      <ModelPrice isCurrent={isCurrent} price={price} />
    </CommandItem>
  )
}

// Compact In/Out $/Mtok price tag, mirroring the CLI picker's price columns.
// Renders nothing when pricing is unavailable for the model.
function ModelPrice({ isCurrent, price }: { isCurrent: boolean; price?: ModelPricing }) {
  const copy = useI18n().t.modelPicker

  if (!price || (!price.input && !price.output)) {
    return null
  }

  if (price.free) {
    return (
      <span
        className={cn(
          'shrink-0 rounded-sm px-1 py-0.5 text-[0.62rem] font-semibold uppercase tracking-wide',
          isCurrent ? 'bg-primary-foreground/20' : 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
        )}
      >
        {copy.free}
      </span>
    )
  }

  return (
    <span
      className={cn(
        'shrink-0 text-[0.66rem] tabular-nums',
        isCurrent ? 'text-primary-foreground/80' : 'text-muted-foreground'
      )}
      title={copy.priceTitle}
    >
      {price.input || '?'} / {price.output || '?'}
    </span>
  )
}

function LoadingResults() {
  return (
    <CommandGroup heading={<Skeleton className="h-3 w-32" />}>
      {Array.from({ length: 4 }, (_, rowIndex) => (
        <div className="rounded-sm py-1.5 ps-6 pe-2" key={rowIndex}>
          <Skeleton className={cn('h-5', rowIndex % 3 === 0 ? 'w-3/5' : rowIndex % 3 === 1 ? 'w-4/5' : 'w-1/2')} />
        </div>
      ))}
    </CommandGroup>
  )
}

function ProviderHeading({ provider }: { provider: ModelOptionProvider }) {
  const copy = useI18n().t.modelPicker

  // free_tier is only set for Nous. true → "Free tier", false → "Pro".
  const tierBadge =
    provider.free_tier === true ? (
      <span className="rounded-sm bg-emerald-500/15 px-1 py-0.5 text-[0.6rem] font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
        {copy.freeTier}
      </span>
    ) : provider.free_tier === false ? (
      <span className="rounded-sm bg-primary/15 px-1 py-0.5 text-[0.6rem] font-semibold uppercase tracking-wide text-primary">
        {copy.pro}
      </span>
    ) : null

  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="truncate">{provider.name}</span>
      <span className="font-mono text-xs font-normal normal-case tracking-normal text-muted-foreground">
        {provider.slug} · {provider.total_models ?? provider.models?.length ?? 0}
      </span>
      {tierBadge}
    </span>
  )
}
