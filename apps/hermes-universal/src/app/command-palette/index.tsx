// Side-effect import: registers the app's own destinations in the `palette`
// area. The palette renders one list from the registry, so the rows have to be
// in it before this mounts — the deleted command-menu carried the same import.
import '@/app/shell/nav-contrib'

import { useQuery } from '@tanstack/react-query'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { memo, useCallback, useEffect, useMemo, useState } from 'react'

import { HUD_HEADING, HUD_ITEM, HUD_POSITION, HUD_SURFACE, HUD_TEXT } from '@/app/floating-hud'
import { setTerminalTakeover } from '@/app/right-pane/store'
import { COMMAND_CENTER_ROUTE, PET_SETTINGS_ROUTE, sessionRoute, SETTINGS_ROUTE, SKILLS_ROUTE } from '@/app/routes'
import { FIELD_LABELS, SECTIONS } from '@/app/settings/constants'
import { fieldCopyForSchemaKey } from '@/app/settings/field-copy'
import { prettyName } from '@/app/settings/helpers'
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { KbdCombo } from '@/components/ui/kbd'
import { getHermesConfigRecord, listAllProfileSessions } from '@/hermes'
import { useI18n } from '@/i18n'
import { sessionTitle } from '@/lib/chat-runtime'
import {
  Activity,
  AppWindow,
  Archive,
  BarChart3,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  Egg,
  GitBranch,
  Globe,
  type IconComponent,
  Info,
  KeyRound,
  Layers3,
  MessageCircle,
  Monitor,
  Moon,
  Palette,
  Paw,
  Plug,
  RefreshCw,
  Settings2,
  SlidersHorizontal,
  Sun,
  Terminal,
  Wrench,
  Zap
} from '@/lib/icons'
import { IS_DESKTOP, IS_MOBILE } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import { $repoWorktrees } from '@/store/coding-status'
import {
  $commandPaletteOpen,
  $commandPalettePage,
  closeCommandPalette,
  setCommandPaletteOpen
} from '@/store/command-palette'
import { $bindings, bindingsFor } from '@/store/keybinds'
import { openPetGenerate } from '@/store/pet-generate'
import { requestStartWorkSession } from '@/store/projects'
import { runGatewayRestart } from '@/store/system-status'
import { canOpenNewWindow, openAppRoute, openNewWindow } from '@/store/windows'
import { luminance } from '@/themes/color'
import { type ThemeMode, useTheme } from '@/themes/context'
import { isUserTheme, resolveTheme } from '@/themes/user-themes'

import { usePaletteContributions } from './contrib'
import {
  PAGE_PARENTS,
  type PaletteGroup,
  type PaletteItem,
  type PalettePage,
  paletteValue,
  rankGroups
} from './ranking'

interface SessionEntry {
  git_branch?: null | string
  id: string
  preview?: string
  title: string
}

const PaletteRow = memo(function PaletteRow({
  bindings,
  item,
  onSelectItem
}: {
  bindings: Record<string, string[]>
  item: PaletteItem
  onSelectItem: (item: PaletteItem) => void
}) {
  const Icon = item.icon
  // bindingsFor, not a raw lookup: $bindings holds only the user's overrides —
  // an action that was never rebound still has a default combo to show.
  const combo = item.action ? bindingsFor(item.action, bindings)[0] : undefined

  return (
    <CommandItem
      className={cn(HUD_ITEM, HUD_TEXT)}
      keywords={item.keywords}
      onSelect={() => onSelectItem(item)}
      value={paletteValue(item)}
    >
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{item.label}</span>
      {item.detail && <span className="truncate text-muted-foreground/80">{item.detail}</span>}
      {combo && <KbdCombo className="ml-auto opacity-55" combo={combo} size="sm" />}
      {item.to && <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground/70', !combo && 'ml-auto')} />}
      {item.active && <Check className={cn('size-3.5 shrink-0 text-primary', !combo && !item.to && 'ml-auto')} />}
    </CommandItem>
  )
})

// Hermes session ids: <YYYYMMDD>_<HHMMSS>_<6 hex>. Used to offer a direct
// "Go to session ‹id›" jump for ids that aren't in the recent list.
const SESSION_ID_RE = /^\d{8}_\d{6}_[a-f0-9]{6}$/

// The palette mounts on phones too, where a few hundred rows of session history
// is a needless round trip over the gateway on every open.
const SESSION_LIMIT = IS_MOBILE ? 50 : 200

type SessionRow = Awaited<ReturnType<typeof listAllProfileSessions>>['sessions'][number]

const toSessionEntry = (session: SessionRow): SessionEntry => ({
  git_branch: session.git_branch ?? null,
  id: session.id,
  preview: session.preview ?? undefined,
  title: sessionTitle(session)
})

type NonConfigSettingsLabel =
  | 'about'
  | 'archivedChats'
  | 'billing'
  | 'gateway'
  | 'keysSettings'
  | 'keysTools'
  | 'notifications'
  | 'plugins'
  | 'providerAccounts'
  | 'providerApiKeys'
  | 'providerCustomEndpoints'

// Settings pages that aren't schema-driven sections. Desktop addresses these
// with `?tab=`; universal's settings shell reads the path, so each entry is the
// route its SectionBody case answers to.
const NON_CONFIG_SETTINGS: ReadonlyArray<{
  icon: IconComponent
  keywords?: string[]
  labelKey: NonConfigSettingsLabel
  path: string
}> = [
  {
    icon: Zap,
    keywords: ['accounts', 'sign in', 'oauth', 'login', 'subscription', 'models', 'anthropic', 'openai'],
    labelKey: 'providerAccounts',
    path: 'providers'
  },
  {
    icon: KeyRound,
    keywords: ['providers', 'api key', 'keys', 'secrets', 'tokens'],
    labelKey: 'providerApiKeys',
    path: 'providers/keys'
  },
  {
    icon: Globe,
    keywords: ['providers', 'custom', 'endpoint', 'base url', 'openai compatible', 'local'],
    labelKey: 'providerCustomEndpoints',
    path: 'providers/custom-endpoints'
  },
  { icon: Globe, keywords: ['connection', 'ssh', 'cloud', 'remote', 'local'], labelKey: 'gateway', path: 'gateway' },
  {
    icon: KeyRound,
    keywords: ['api', 'secrets', 'tokens', 'credentials', 'browser', 'search'],
    labelKey: 'keysTools',
    path: 'keys'
  },
  {
    icon: Settings2,
    keywords: ['gateway', 'proxy', 'server', 'webhook', 'env'],
    labelKey: 'keysSettings',
    path: 'keys/settings'
  },
  {
    icon: Activity,
    keywords: ['notify', 'sound', 'haptics', 'alerts'],
    labelKey: 'notifications',
    path: 'notifications'
  },
  {
    icon: BarChart3,
    keywords: ['balance', 'plan', 'credits', 'top up', 'usage'],
    labelKey: 'billing',
    path: 'billing'
  },
  { icon: Plug, keywords: ['extensions', 'addons'], labelKey: 'plugins', path: 'plugins' },
  { icon: Archive, keywords: ['history', 'archived'], labelKey: 'archivedChats', path: 'sessions' },
  { icon: Info, keywords: ['version', 'about'], labelKey: 'about', path: 'about' }
]

const THEME_MODES: ReadonlyArray<{ icon: IconComponent; mode: ThemeMode }> = [
  { icon: Sun, mode: 'light' },
  { icon: Moon, mode: 'dark' },
  { icon: Monitor, mode: 'system' }
]

// Which Light/Dark groups a theme belongs in. Built-ins render in both modes
// (the engine synthesises the missing side). Imported VS Code themes only carry
// the variant(s) the extension shipped — a single dark theme like Dracula lives
// under Dark only, while a GitHub/Solarized family (light + dark) lives in both.
function themeSupportsMode(name: string, target: 'dark' | 'light'): boolean {
  if (!isUserTheme(name)) {
    return true
  }

  const resolved = resolveTheme(name)

  if (!resolved) {
    return true
  }

  const background =
    target === 'dark' ? (resolved.darkColors ?? resolved.colors).background : resolved.colors.background

  return target === 'dark' ? luminance(background) <= 0.5 : luminance(background) > 0.5
}

export function CommandPalette() {
  const { t } = useI18n()
  const open = useStore($commandPaletteOpen)
  const pendingPage = useStore($commandPalettePage)
  const bindings = useStore($bindings)
  const worktrees = useStore($repoWorktrees)
  const { availableThemes, mode, resolvedMode, setMode, setTheme, themeName } = useTheme()
  const [search, setSearch] = useState('')
  const [page, setPage] = useState<null | string>(null)

  // Server-backed sources for the type-to-search groups, fetched lazily while
  // the palette is open. react-query handles caching/dedup/staleness.
  const configQuery = useQuery({
    queryKey: ['command-palette', 'config'],
    queryFn: getHermesConfigRecord,
    enabled: open
  })

  const sessionsQuery = useQuery({
    queryKey: ['command-palette', 'sessions', SESSION_LIMIT],
    queryFn: () => listAllProfileSessions(SESSION_LIMIT, 1, 'exclude'),
    enabled: open
  })

  const archivedQuery = useQuery({
    queryKey: ['command-palette', 'archived', SESSION_LIMIT],
    queryFn: () => listAllProfileSessions(SESSION_LIMIT, 0, 'only'),
    enabled: open
  })

  const mcpServers = useMemo(() => {
    const raw = configQuery.data?.mcp_servers

    return raw && typeof raw === 'object' && !Array.isArray(raw)
      ? Object.keys(raw as Record<string, unknown>).sort()
      : []
  }, [configQuery.data])

  const sessions = useMemo(() => (sessionsQuery.data?.sessions ?? []).map(toSessionEntry), [sessionsQuery.data])
  const archivedSessions = useMemo(() => (archivedQuery.data?.sessions ?? []).map(toSessionEntry), [archivedQuery.data])

  // Reset the query/sub-page on close so it reopens clean.
  useEffect(() => {
    if (!open) {
      setSearch('')
      setPage(null)
    }
  }, [open])

  // Deep-link into a nested page.
  useEffect(() => {
    if (open && pendingPage) {
      setPage(pendingPage)
      $commandPalettePage.set(null)
    }
  }, [open, pendingPage])

  // One door for every destination: openAppRoute promotes Settings, Command
  // Center and Profiles to their native Android activity and navigates in-app
  // everywhere else, so the palette never needs the router itself.
  const go = useCallback((path: string) => () => openAppRoute(path), [])

  const goSession = useCallback((sessionId: string) => () => openAppRoute(sessionRoute(sessionId)), [])

  // Step up one nested page (or back to the root list), clearing the filter so
  // the parent page doesn't reopen mid-search.
  const goBack = useCallback(() => {
    setSearch('')
    setPage(prev => (prev ? (PAGE_PARENTS[prev] ?? null) : null))
  }, [])

  const settingsSectionLabel = useCallback(
    (section: (typeof SECTIONS)[number]) => t.settings.sections[section.id] ?? section.label,
    [t.settings.sections]
  )

  const configFieldLabel = useCallback(
    (key: string) =>
      fieldCopyForSchemaKey(t.settings.fieldLabels, key) ??
      fieldCopyForSchemaKey(FIELD_LABELS, key) ??
      prettyName(key.split('.').pop() ?? key),
    [t.settings.fieldLabels]
  )

  const contributedItems = usePaletteContributions()

  const baseGroups = useMemo<PaletteGroup[]>(() => {
    const settingsPath = (page_: string) => `${SETTINGS_ROUTE}/${page_}`
    const cc = t.commandCenter

    // Core destinations come from the registry (app/shell/nav-contrib.ts), not
    // from a hardcoded list here — MJX-52 made the app's own nav contributions,
    // and rendering both would list every destination twice. Plugin rows get
    // their own group below.
    const isCore = (source?: string) => (source ?? 'core') === 'core'

    const toItem = (row: (typeof contributedItems)[number]): PaletteItem => ({
      action: row.action,
      icon: row.icon ?? Plug,
      id: row.key,
      keywords: row.keywords,
      label: row.label,
      run: row.run
    })

    const coreRows = contributedItems.filter(row => isCore(row.source)).map(toItem)
    const pluginRows = contributedItems.filter(row => !isCore(row.source)).map(toItem)

    // The active repo's worktrees → "new conversation in <branch>". This is the
    // ⌘K-typed "I want to work on <branch>" reflex: each entry seeds a fresh
    // session anchored to that worktree's checkout (requestStartWorkSession),
    // so git is the source of truth and edits land in the right tree.
    const branchGroup: PaletteGroup[] =
      worktrees.length > 0
        ? [
            {
              heading: cc.branches,
              items: worktrees.map(wt => {
                const name = wt.branch?.trim() || wt.path.split('/').pop() || wt.path

                return {
                  icon: GitBranch,
                  id: `worktree-${wt.path}`,
                  keywords: ['branch', 'worktree', 'switch', name, wt.path],
                  label: cc.startInBranch(name),
                  run: () => requestStartWorkSession(wt.path)
                }
              })
            }
          ]
        : []

    return [
      {
        heading: cc.goTo,
        items: [
          ...coreRows,
          // Not destinations, so they can't be module-load registrations: both
          // depend on runtime capability rather than on a route existing.
          ...(canOpenNewWindow()
            ? [
                {
                  action: 'session.newWindow',
                  icon: AppWindow,
                  id: 'nav-new-window',
                  keywords: ['window', 'instance', 'open', 'new'],
                  label: t.keybinds.actions['session.newWindow'],
                  run: () => void openNewWindow()
                }
              ]
            : []),
          ...(IS_DESKTOP
            ? [
                {
                  action: 'view.showTerminal',
                  icon: Terminal,
                  id: 'nav-terminal',
                  keywords: ['terminal', 'shell', 'console'],
                  label: t.keybinds.actions['view.showTerminal'],
                  run: () => setTerminalTakeover(true)
                }
              ]
            : [])
        ]
      },
      ...branchGroup,
      {
        heading: cc.commandCenter,
        items: [
          {
            icon: Archive,
            id: 'cc-sessions',
            keywords: ['command center', 'sessions', 'pin'],
            label: cc.sections.sessions,
            run: go(`${COMMAND_CENTER_ROUTE}?section=sessions`)
          },
          {
            icon: Activity,
            id: 'cc-system',
            keywords: ['command center', 'system', 'status', 'logs'],
            label: cc.sections.system,
            run: go(`${COMMAND_CENTER_ROUTE}?section=system`)
          },
          {
            icon: BarChart3,
            id: 'cc-usage',
            keywords: ['command center', 'usage', 'tokens', 'cost'],
            label: cc.sections.usage,
            run: go(`${COMMAND_CENTER_ROUTE}?section=usage`)
          },
          {
            icon: RefreshCw,
            id: 'cc-restart-gateway',
            keywords: ['gateway', 'restart', 'messaging', 'reconnect', 'system'],
            label: cc.restartGateway,
            run: () => void runGatewayRestart()
          },
          {
            // Lands on the System section rather than firing the update
            // headless: universal's update flow (trigger, action polling, live
            // log lines) lives there, and an update with no progress surface is
            // not something to start from a palette row.
            icon: Download,
            id: 'cc-update-hermes',
            keywords: ['update', 'upgrade', 'hermes', 'version', 'system', 'restart'],
            label: cc.updateHermes,
            run: go(`${COMMAND_CENTER_ROUTE}?section=system`)
          }
        ]
      },
      {
        // Declared before Settings: cmdk keeps group order, so this keeps the
        // theme/mode pickers on top for "theme"/"color" queries instead of
        // buried under a fuzzy Settings match.
        heading: cc.appearance,
        items: [
          {
            icon: Palette,
            id: 'appearance-theme',
            keywords: ['theme', 'appearance', 'color', 'palette', 'skin', 'dark', 'light', 'look'],
            label: cc.changeTheme,
            to: 'theme'
          },
          {
            icon: Sun,
            id: 'appearance-mode',
            keywords: ['appearance', 'color mode', 'brightness', 'dark', 'light', 'system'],
            label: cc.changeColorMode,
            to: 'color-mode'
          },
          {
            icon: Paw,
            id: 'appearance-pets',
            keywords: ['pet', 'petdex', 'mascot', 'pets', '/pet', 'paw'],
            label: cc.pets.title,
            run: go(PET_SETTINGS_ROUTE)
          },
          {
            icon: Egg,
            id: 'appearance-generate-pet',
            keywords: ['pet', 'generate', 'create', 'make', 'new pet', 'mascot', 'hatch', 'ai'],
            label: cc.generatePet.title,
            run: () => openPetGenerate()
          }
        ]
      },
      {
        heading: cc.settings,
        items: [
          ...SECTIONS.map(section => ({
            icon: section.icon,
            id: `set-config-${section.id}`,
            keywords: ['settings', section.label, settingsSectionLabel(section)],
            label: settingsSectionLabel(section),
            run: go(settingsPath(section.id))
          })),
          ...NON_CONFIG_SETTINGS.map(entry => ({
            icon: entry.icon,
            id: `set-${entry.path}`,
            keywords: ['settings', ...(entry.keywords ?? [])],
            label: t.settings.nav[entry.labelKey],
            run: go(settingsPath(entry.path))
          }))
        ]
      },
      // Plugin-contributed rows — one group, omitted while nothing contributes.
      ...(pluginRows.length > 0 ? [{ heading: cc.commands, items: pluginRows }] : [])
    ]
  }, [contributedItems, go, settingsSectionLabel, t, worktrees])

  // The long, granular lists (settings fields, MCP servers, archived chats)
  // only surface once the user types — otherwise they'd bury the navigation
  // entries on an empty palette.
  const searchGroups = useMemo<PaletteGroup[]>(() => {
    if (!search.trim()) {
      return []
    }

    const result: PaletteGroup[] = []

    // Paste a raw session id → jump straight to it, even if it predates the
    // recent window the lists below are built from.
    const directId = search.trim()

    if (SESSION_ID_RE.test(directId)) {
      result.push({
        items: [
          {
            icon: MessageCircle,
            id: `goto-${directId}`,
            keywords: ['session', 'id', 'go to', directId],
            label: `${t.commandCenter.goToSession} ${directId}`,
            run: goSession(directId)
          }
        ]
      })
    }

    // Deep-link straight to a Capabilities sub-tab. The root "Go to" entry only
    // lands on the top-level Skills view; typing "mcp"/"tools"/"skills" should
    // jump to the exact tab.
    const capLabel = t.commandCenter.nav.skills.title

    result.push({
      heading: capLabel,
      items: [
        {
          icon: Wrench,
          id: 'cap-skills',
          keywords: ['skills', 'capabilities'],
          label: `${capLabel}: ${t.skills.tabSkills}`,
          run: go(`${SKILLS_ROUTE}?tab=skills`)
        },
        {
          icon: SlidersHorizontal,
          id: 'cap-toolsets',
          keywords: ['tools', 'toolsets', 'capabilities'],
          label: `${capLabel}: ${t.skills.tabToolsets}`,
          run: go(`${SKILLS_ROUTE}?tab=toolsets`)
        },
        {
          icon: Layers3,
          id: 'cap-mcp',
          keywords: ['mcp', 'servers', 'tools', 'capabilities', 'model context protocol'],
          label: `${capLabel}: ${t.skills.tabMcp}`,
          run: go(`${SKILLS_ROUTE}?tab=mcp`)
        },
        {
          icon: Download,
          id: 'cap-hub',
          keywords: ['hub', 'install', 'browse', 'marketplace', 'capabilities'],
          label: `${capLabel}: ${t.skills.tabHub}`,
          run: go(`${SKILLS_ROUTE}?tab=hub`)
        }
      ]
    })

    // Apply a theme directly from the root search (e.g. "nous" → Nous). Live
    // preview via keepOpen, mirroring the nested theme picker. If the theme
    // can't render the current light/dark mode, flip to the one it supports.
    result.push({
      heading: t.settings.appearance.themeTitle,
      items: availableThemes.map(theme => ({
        active: themeName === theme.name,
        icon: Palette,
        id: `search-theme-${theme.name}`,
        keepOpen: true,
        keywords: ['theme', 'appearance', 'color', 'skin', theme.name, theme.description],
        label: theme.label,
        run: () => {
          setTheme(theme.name)

          if (!themeSupportsMode(theme.name, resolvedMode)) {
            setMode(resolvedMode === 'dark' ? 'light' : 'dark')
          }
        }
      }))
    })

    // Switch light/dark/system directly (typing "dark" shouldn't require the
    // nested color-mode page).
    result.push({
      heading: t.settings.appearance.colorMode,
      items: THEME_MODES.map(entry => ({
        active: mode === entry.mode,
        icon: entry.icon,
        id: `search-mode-${entry.mode}`,
        keepOpen: true,
        keywords: ['appearance', 'color mode', 'brightness', entry.mode, t.settings.modeOptions[entry.mode].label],
        label: t.settings.modeOptions[entry.mode].label,
        run: () => setMode(entry.mode)
      }))
    })

    if (sessions.length > 0) {
      result.push({
        heading: t.commandCenter.sections.sessions,
        items: sessions.map(session => ({
          icon: MessageCircle,
          id: `session-${session.id}`,
          keywords: [
            'chat',
            'session',
            ...(session.preview ? [session.preview] : []),
            ...(session.git_branch ? [session.git_branch] : [])
          ],
          label: session.title,
          run: goSession(session.id)
        }))
      })
    }

    const fieldItems = SECTIONS.flatMap(section =>
      section.keys.map(key => ({
        icon: section.icon,
        id: `field-${key}`,
        keywords: ['settings', key, section.label, settingsSectionLabel(section)],
        label: `${settingsSectionLabel(section)}: ${configFieldLabel(key)}`,
        run: go(`${SETTINGS_ROUTE}/${section.id}?field=${encodeURIComponent(key)}`)
      }))
    )

    result.push({ heading: t.commandCenter.settingsFields, items: fieldItems })

    if (mcpServers.length > 0) {
      result.push({
        heading: t.commandCenter.mcpServers,
        items: mcpServers.map(name => ({
          icon: Wrench,
          id: `mcp-${name}`,
          keywords: ['mcp', 'server', 'tool'],
          label: name,
          run: go(`${SKILLS_ROUTE}?tab=mcp&server=${encodeURIComponent(name)}`)
        }))
      })
    }

    if (archivedSessions.length > 0) {
      result.push({
        heading: t.commandCenter.archivedChats,
        items: archivedSessions.map(session => ({
          icon: Archive,
          id: `archived-${session.id}`,
          keywords: [
            'archived',
            'chat',
            'session',
            ...(session.preview ? [session.preview] : []),
            ...(session.git_branch ? [session.git_branch] : [])
          ],
          label: session.title,
          run: go(`${SETTINGS_ROUTE}/sessions?session=${encodeURIComponent(session.id)}`)
        }))
      })
    }

    return result
  }, [
    archivedSessions,
    availableThemes,
    configFieldLabel,
    go,
    goSession,
    mcpServers,
    mode,
    resolvedMode,
    search,
    sessions,
    setMode,
    setTheme,
    settingsSectionLabel,
    t,
    themeName
  ])

  const groups = useMemo(() => [...baseGroups, ...searchGroups], [baseGroups, searchGroups])

  // Nested palette pages (VS Code-style submenus). Reusable: add an entry here
  // and point a root item at it via `to`.
  const subPages = useMemo<Record<string, PalettePage>>(
    () => ({
      theme: {
        title: t.settings.appearance.themeTitle,
        placeholder: t.settings.appearance.themeDesc,
        groups: [
          // Built-ins and imported families list under the mode(s) they support;
          // picking sets skin + mode at once. A multi-variant import (GitHub,
          // Solarized) appears in both groups and switches variants with the mode.
          ...(['light', 'dark'] as const).map(groupMode => ({
            heading: groupMode === 'light' ? t.settings.modeOptions.light.label : t.settings.modeOptions.dark.label,
            items: availableThemes
              .filter(theme => themeSupportsMode(theme.name, groupMode))
              .map(theme => ({
                active: themeName === theme.name && resolvedMode === groupMode,
                icon: groupMode === 'light' ? Sun : Moon,
                id: `theme-${theme.name}-${groupMode}`,
                keepOpen: true,
                keywords: ['theme', 'appearance', 'palette', groupMode, theme.label, theme.description ?? ''],
                label: theme.label,
                run: () => {
                  setTheme(theme.name)
                  setMode(groupMode)
                }
              }))
          }))
        ]
      },
      'color-mode': {
        title: t.settings.appearance.colorMode,
        placeholder: t.settings.appearance.colorModeDesc,
        groups: [
          {
            heading: t.settings.appearance.colorMode,
            items: THEME_MODES.map(entry => ({
              active: mode === entry.mode,
              icon: entry.icon,
              id: `mode-${entry.mode}`,
              keepOpen: true,
              keywords: ['appearance', 'brightness', t.settings.modeOptions[entry.mode].label],
              label: t.settings.modeOptions[entry.mode].label,
              run: () => setMode(entry.mode)
            }))
          }
        ]
      }
    }),
    [availableThemes, mode, resolvedMode, setMode, setTheme, t, themeName]
  )

  const activePage = page ? subPages[page] : null
  const unrankedGroups = activePage ? activePage.groups : groups
  const visibleGroups = useMemo(() => rankGroups(unrankedGroups, search), [unrankedGroups, search])
  const placeholder = activePage ? activePage.placeholder : t.commandCenter.searchPlaceholder

  const handleSelect = (item: PaletteItem) => {
    if (item.to) {
      setPage(item.to)
      setSearch('')

      return
    }

    // Close BEFORE running: a command that opens its own dialog must not be
    // dismissed along with the palette.
    if (!item.keepOpen) {
      closeCommandPalette()
    }

    try {
      item.run?.()
    } catch (err) {
      // A contributed row is plugin code — it must not take the palette down.
      console.error('[plugins] palette command failed', item.id, err)
    }
  }

  return (
    <DialogPrimitive.Root onOpenChange={setCommandPaletteOpen} open={open}>
      <DialogPrimitive.Portal>
        {/* Transparent overlay: keeps click-away + focus trap, but no dim/blur. */}
        <DialogPrimitive.Overlay className="fixed inset-0 z-(--z-over-modal)" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className={cn(
            HUD_POSITION,
            HUD_SURFACE,
            'z-(--z-over-modal-content) w-[min(34rem,calc(100vw-2rem))] overflow-hidden duration-150 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-top-2 data-[state=open]:zoom-in-95'
          )}
        >
          <DialogPrimitive.Title className="sr-only">{t.commandCenter.paletteTitle}</DialogPrimitive.Title>
          <Command className="bg-transparent" loop shouldFilter={false}>
            {activePage && (
              <button
                className="flex w-full items-center gap-1.5 border-b border-border px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
                onClick={goBack}
                type="button"
              >
                <ChevronLeft className="size-3.5" />
                <span>{t.commandCenter.back}</span>
                <span className="text-muted-foreground/50">/</span>
                <span className="font-medium text-foreground">{activePage.title}</span>
              </button>
            )}
            <CommandInput
              className={HUD_TEXT}
              onKeyDown={event => {
                if (!activePage) {
                  return
                }

                // In a submenu: Esc and empty-input Backspace step back out
                // instead of closing the whole palette.
                if (event.key === 'Escape' || (event.key === 'Backspace' && search === '')) {
                  event.preventDefault()
                  event.stopPropagation()
                  goBack()
                }
              }}
              onValueChange={setSearch}
              placeholder={placeholder}
              value={search}
            />
            {/* Explicit max height: cmdk sizes the list with a ResizeObserver, and
                a --cmdk-list-height that fails to resolve should degrade to a
                scrollable box, never an invisible one. */}
            <CommandList className="dt-portal-scrollbar max-h-[min(20rem,56vh)]">
              {/* Filtering happens in rankGroups, so cmdk's own CommandEmpty
                  (keyed to its internal filter count) would never fire. */}
              {visibleGroups.length === 0 && (
                <div className="py-6 text-center text-sm text-muted-foreground">{t.commandCenter.noResults}</div>
              )}
              {visibleGroups.map((group, index) => (
                <CommandGroup
                  className={HUD_HEADING}
                  heading={group.heading}
                  key={group.heading ?? `palette-group-${index}`}
                >
                  {group.items.map(item => (
                    <PaletteRow bindings={bindings} item={item} key={item.id} onSelectItem={handleSelect} />
                  ))}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
