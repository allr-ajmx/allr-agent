import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { PetPanel } from '@/app/pet/pet-section'
import { LanguageSwitcher } from '@/components/language-switcher'
import { Button } from '@/components/ui/button'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import { Check, Download, Loader2, Monitor, Moon, Palette, Sun, Trash } from '@/lib/icons'
import { IS_DESKTOP, IS_TAURI } from '@/lib/platform'
import { selectableCardClass } from '@/lib/selectable-card'
import { normalize } from '@/lib/text'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import { $backdrop, setBackdrop } from '@/store/backdrop'
import { $embedAllowed, $embedMode, clearEmbedAllowed, type EmbedMode, setEmbedMode } from '@/store/embed-consent'
import { installFromMarketplace, type MarketplaceSearchItem, searchMarketplace } from '@/store/marketplace'
import { $toolViewMode, setToolViewMode, type ToolViewMode } from '@/store/tool-view'
import { $translucency, setTranslucency } from '@/store/translucency'
import { $zoomPercent, setZoomPercent } from '@/store/zoom'
import { useTheme } from '@/themes'
import { getBaseColors } from '@/themes/context'
import type { DesktopTheme } from '@/themes/types'
import { $marketplaceInstalls, isUserTheme, removeUserTheme } from '@/themes/user-themes'

import { ListRow, SectionHeading, SettingsContent } from './primitives'

const MODE_OPTIONS = [
  { icon: Sun, id: 'light' },
  { icon: Moon, id: 'dark' },
  { icon: Monitor, id: 'system' }
] as const

const UI_SCALE_PRESETS = ['90', '100', '110', '125', '150', '175'] as const

const SEARCH_CHROME =
  'w-full rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-bg-quinary) px-3 py-1.5 text-[length:var(--conversation-caption-font-size)] outline-none placeholder:text-(--ui-text-tertiary) focus:border-(--ui-stroke-secondary)'

// A small chat mockup previewing a skin's seed palette in the current mode —
// ported from desktop AppearanceSettings.
function ThemePreview({ name, mode }: { name: string; mode: 'dark' | 'light' }) {
  const c = getBaseColors(name, mode)

  return (
    <div
      className="h-20 overflow-hidden rounded-xl border shadow-xs"
      style={{ backgroundColor: c.background, borderColor: c.border }}
    >
      <div className="flex h-full">
        <div
          className="w-12 border-r"
          style={{ backgroundColor: c.sidebarBackground ?? c.muted, borderColor: c.sidebarBorder ?? c.border }}
        />
        <div className="flex flex-1 flex-col gap-2 p-3">
          <div className="h-2.5 w-16 rounded-full" style={{ backgroundColor: c.foreground }} />
          <div className="h-2 w-24 rounded-full" style={{ backgroundColor: c.mutedForeground }} />
          <div className="mt-auto flex justify-end">
            <div
              className="h-5 w-16 rounded-full border"
              style={{ backgroundColor: c.userBubble ?? c.muted, borderColor: c.userBubbleBorder ?? c.border }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const handle = setTimeout(() => setDebounced(value), delayMs)

    return () => clearTimeout(handle)
  }, [value, delayMs])

  return debounced
}

const compactNumber = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1, notation: 'compact' })

// Live VS Code Marketplace theme search — ported from desktop AppearanceSettings.
// Renders below the local grid when there's a query: each row downloads +
// converts + installs via the native `marketplace_fetch` command and activates
// it. Extensions already imported locally are marked installed.
function MarketplaceThemeResults({
  query,
  installs,
  onInstalled
}: {
  query: string
  installs: ReadonlyMap<string, DesktopTheme>
  onInstalled: (name: string) => void
}) {
  const { t } = useI18n()
  const copy = t.commandCenter.installTheme
  const debounced = useDebounced(query.trim(), 300)
  const [installingId, setInstallingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const search = useQuery({
    enabled: debounced.length > 0,
    queryFn: () => searchMarketplace(debounced),
    queryKey: ['marketplace-themes-settings', debounced],
    staleTime: 5 * 60 * 1000
  })

  // Already installed → just re-activate it; never re-download what we have.
  const select = (item: MarketplaceSearchItem) => {
    const owned = installs.get(item.extensionId)

    if (owned) {
      triggerHaptic('selection')
      onInstalled(owned.name)

      return
    }

    void install(item)
  }

  const install = async (item: MarketplaceSearchItem) => {
    if (installingId) {
      return
    }

    setInstallingId(item.extensionId)
    setError(null)

    try {
      const theme = await installFromMarketplace(item.extensionId)

      triggerHaptic('selection')
      onInstalled(theme.name)
    } catch (e) {
      setError(e instanceof Error ? e.message : copy.error)
    } finally {
      setInstallingId(null)
    }
  }

  if (!debounced) {
    return null
  }

  const header = (
    <p className="mb-2 mt-4 text-[length:var(--conversation-caption-font-size)] font-medium text-(--ui-text-tertiary)">
      From the VS Code Marketplace
    </p>
  )

  if (search.isLoading) {
    return (
      <>
        {header}
        <p className="flex items-center gap-2 text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
          <Loader2 className="size-3.5 animate-spin" />
          {copy.loading}
        </p>
      </>
    )
  }

  if (search.isError) {
    return (
      <>
        {header}
        <p className="text-[length:var(--conversation-caption-font-size)] text-(--ui-red)">{copy.error}</p>
      </>
    )
  }

  const results = search.data ?? []

  if (results.length === 0) {
    return (
      <>
        {header}
        <p className="text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">{copy.empty}</p>
      </>
    )
  }

  return (
    <>
      {header}
      {error && <p className="mb-2 text-[length:var(--conversation-caption-font-size)] text-(--ui-red)">{error}</p>}
      <div className="grid gap-2 sm:grid-cols-2">
        {results.map(item => {
          const busy = installingId === item.extensionId
          const done = installs.has(item.extensionId)

          return (
            <button
              className={cn(
                'flex items-center gap-2.5 px-2.5 py-2 text-left disabled:opacity-60',
                selectableCardClass({ prominent: done })
              )}
              disabled={Boolean(installingId) && !busy}
              key={item.extensionId}
              onClick={() => select(item)}
              type="button"
            >
              <Palette className="size-4 shrink-0 text-(--ui-text-tertiary)" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[length:var(--conversation-text-font-size)] font-medium">
                  {item.displayName}
                </span>
                <span className="block truncate text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
                  {item.publisher}
                  {item.installs > 0 ? ` · ${copy.installs(compactNumber.format(item.installs))}` : ''}
                </span>
              </span>
              <span className="shrink-0 text-(--ui-text-tertiary)">
                {busy ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : done ? (
                  <Check className="size-4 text-(--ui-green)" />
                ) : (
                  <Download className="size-4" />
                )}
              </span>
            </button>
          )
        })}
      </div>
    </>
  )
}

// The Appearance page (desktop parity): Language, Theme (mode + preview cards +
// search + VS Code Marketplace install), UI scale, Translucency (desktop-only),
// Tool view, Embeds, and the nested Pet panel.
export function AppearanceSection() {
  const { t } = useI18n()
  const a = t.settings.appearance
  const { availableThemes, mode, resolvedMode, setMode, setTheme, themeName } = useTheme()
  const toolViewMode = useStore($toolViewMode)
  const backdrop = useStore($backdrop)
  const zoomPercent = useStore($zoomPercent)
  const embedMode = useStore($embedMode)
  const embedAllowed = useStore($embedAllowed)
  const translucency = useStore($translucency)
  const installs = useStore($marketplaceInstalls)
  const [query, setQuery] = useState('')

  const modeOptions = MODE_OPTIONS.map(({ id, icon }) => ({ icon, id, label: t.settings.modeOptions[id].label }))

  const toolOptions = [
    { id: 'product', label: a.product },
    { id: 'technical', label: a.technical }
  ] as const

  const embedOptions = [
    { id: 'ask', label: a.embedsAsk },
    { id: 'always', label: a.embedsAlways },
    { id: 'off', label: a.embedsOff }
  ] as const satisfies readonly { id: EmbedMode; label: string }[]

  const uiScaleOptions = UI_SCALE_PRESETS.map(preset => ({ id: preset, label: `${preset}%` }))

  const matchedScale =
    UI_SCALE_PRESETS.find(preset => Number(preset) === zoomPercent) ?? ('' as (typeof UI_SCALE_PRESETS)[number])

  const needle = normalize(query)

  const filteredThemes = availableThemes
    .filter(
      theme =>
        !needle ||
        normalize(theme.label).includes(needle) ||
        normalize(theme.name).includes(needle) ||
        normalize(theme.description).includes(needle)
    )
    .sort((x, y) => Number(y.name === themeName) - Number(x.name === themeName))

  return (
    <SettingsContent>
      <div>
        <SectionHeading icon={Palette} title={a.title} />
        <p className="max-w-2xl text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ui-text-tertiary)">
          {a.intro}
        </p>

        <div className="mt-2">
          {/* Language */}
          <ListRow action={<LanguageSwitcher />} description={t.language.description} title={t.language.label} />

          {/* Theme */}
          <ListRow
            below={
              <>
                <div className="mt-3">
                  <input
                    className={SEARCH_CHROME}
                    onChange={event => setQuery(event.target.value)}
                    placeholder={IS_TAURI ? 'Search your themes or the VS Code Marketplace…' : a.themeDesc}
                    spellCheck={false}
                    value={query}
                  />
                </div>
                <div className="mt-3 max-h-96 overflow-y-auto pr-1">
                  {filteredThemes.length === 0 ? (
                    needle ? (
                      <p className="text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
                        {`No themes match "${query.trim()}".`}
                      </p>
                    ) : null
                  ) : (
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                      {filteredThemes.map(theme => {
                        const active = themeName === theme.name
                        const removable = isUserTheme(theme.name)

                        return (
                          <div className="group relative" key={theme.name}>
                            <button
                              className={cn('w-full p-2 text-left', selectableCardClass({ active, prominent: true }))}
                              onClick={() => {
                                triggerHaptic('selection')
                                setTheme(theme.name)
                              }}
                              type="button"
                            >
                              <ThemePreview mode={resolvedMode} name={theme.name} />
                              <div className="mt-3 px-1">
                                <div className="truncate text-[length:var(--conversation-text-font-size)] font-medium">
                                  {theme.label}
                                </div>
                                <div className="mt-0.5 line-clamp-2 text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ui-text-tertiary)">
                                  {theme.description}
                                </div>
                              </div>
                            </button>
                            {removable && (
                              <Tip label={a.removeTheme}>
                                <button
                                  aria-label={a.removeTheme}
                                  className="absolute right-1.5 top-1.5 grid size-6 place-items-center rounded-md bg-(--ui-bg-elevated)/80 text-(--ui-text-tertiary) opacity-0 backdrop-blur-sm transition hover:text-(--ui-red) focus-visible:opacity-100 group-hover:opacity-100 coarse:opacity-100"
                                  onClick={() => {
                                    triggerHaptic('selection')
                                    removeUserTheme(theme.name)

                                    if (active) {
                                      setTheme(theme.name)
                                    }
                                  }}
                                  type="button"
                                >
                                  <Trash className="size-3.5" />
                                </button>
                              </Tip>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                  {IS_TAURI && (
                    <MarketplaceThemeResults installs={installs} onInstalled={name => setTheme(name)} query={query} />
                  )}
                </div>
              </>
            }
            description={a.themeDesc}
            title={
              <div className="flex items-center justify-between gap-3">
                <span>{a.themeTitle}</span>
                <SegmentedControl
                  onChange={id => {
                    triggerHaptic('selection')
                    setMode(id)
                  }}
                  options={modeOptions}
                  value={mode}
                />
              </div>
            }
            wide
          />

          {/* UI scale */}
          <ListRow
            action={
              <SegmentedControl
                onChange={id => {
                  triggerHaptic('selection')
                  setZoomPercent(Number(id))
                }}
                options={uiScaleOptions}
                value={matchedScale}
              />
            }
            description={a.uiScaleDesc(zoomPercent)}
            title={a.uiScaleTitle}
          />

          {/* Translucency (desktop-only native effect) */}
          {IS_DESKTOP && (
            <ListRow
              action={
                <div className="flex items-center gap-3">
                  <input
                    aria-label={a.translucencyTitle}
                    className="h-1 w-40 cursor-pointer appearance-none rounded-full bg-(--ui-stroke-tertiary)"
                    max={100}
                    min={0}
                    onChange={event => {
                      triggerHaptic('selection')
                      setTranslucency(Number(event.target.value))
                    }}
                    step={5}
                    style={{ accentColor: 'var(--dt-primary)' }}
                    type="range"
                    value={translucency}
                  />
                  <span className="w-9 text-right text-[length:var(--conversation-caption-font-size)] tabular-nums text-(--ui-text-tertiary)">
                    {translucency}%
                  </span>
                </div>
              }
              description={a.translucencyDesc}
              title={a.translucencyTitle}
            />
          )}

          {/* Tool view */}
          <ListRow
            action={
              <SegmentedControl
                onChange={id => {
                  triggerHaptic('selection')
                  setToolViewMode(id as ToolViewMode)
                }}
                options={toolOptions}
                value={toolViewMode}
              />
            }
            description={a.toolViewDesc}
            title={a.toolViewTitle}
          />

          {/* Chat backdrop */}
          <ListRow
            action={
              <SegmentedControl
                onChange={id => {
                  triggerHaptic('selection')
                  setBackdrop(id === 'on')
                }}
                options={[
                  { id: 'off', label: t.common.off },
                  { id: 'on', label: t.common.on }
                ]}
                value={backdrop ? 'on' : 'off'}
              />
            }
            description={a.backdropDesc}
            title={a.backdropTitle}
          />

          {/* Embeds */}
          <ListRow
            action={
              <div className="flex flex-col items-end gap-1.5">
                <SegmentedControl
                  onChange={id => {
                    triggerHaptic('selection')
                    setEmbedMode(id as EmbedMode)
                  }}
                  options={embedOptions}
                  value={embedMode}
                />
                {embedAllowed.length > 0 && (
                  <Button
                    onClick={() => {
                      triggerHaptic('selection')
                      clearEmbedAllowed()
                    }}
                    size="inline"
                    variant="text"
                  >
                    {a.embedsReset(embedAllowed.length)}
                  </Button>
                )}
              </div>
            }
            description={a.embedsDesc}
            title={a.embedsTitle}
          />
        </div>
      </div>

      <div className="mt-6">
        <PetPanel />
      </div>
    </SettingsContent>
  )
}
