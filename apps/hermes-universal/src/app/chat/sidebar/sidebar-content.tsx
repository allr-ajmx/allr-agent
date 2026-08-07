import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { PlatformAvatar } from '@/app/messaging/platform-icon'
import { CRON_ROUTE, sessionRoute } from '@/app/routes'
import { Codicon } from '@/components/ui/codicon'
import { GlyphSpinner } from '@/components/ui/glyph-spinner'
import { SearchField } from '@/components/ui/search-field'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { profileColor } from '@/lib/profile-color'
import { sessionMatchesSearch } from '@/lib/session-search'
import { useStore } from '@/store/atom'
import { $busy, $sessionId } from '@/store/chat'
import { $cronJobs, refreshCronJobs, triggerCron } from '@/store/cron'
import {
  $dismissedAutoProjectIds,
  $pinnedSessionIds,
  $sidebarAgentsGrouped,
  $sidebarMessagingOpenIds,
  $sidebarPinsOpen,
  $sidebarProjectOrderIds,
  $sidebarRecentsOpen,
  $sidebarSessionOrderIds,
  $sidebarSessionOrderManual,
  pinSession,
  SESSION_SEARCH_FOCUS_EVENT,
  setPinnedSessionOrder,
  setSidebarAgentsGrouped,
  setSidebarPinsOpen,
  setSidebarProjectOrderIds,
  setSidebarRecentsOpen,
  setSidebarSessionOrderIds,
  setSidebarSessionOrderManual,
  toggleSidebarMessagingOpen,
  unpinSession
} from '@/store/layout'
import { $sidebarCronOpen, setSidebarCronOpen } from '@/store/layout'
import { startNewSession } from '@/store/new-session'
import { $profileScope, ALL_PROFILES, normalizeProfileKey } from '@/store/profile'
import { $profiles, setActiveProfile } from '@/store/profiles'
import {
  $activeProjectId,
  $projectScope,
  $projectTree,
  $projectTreeLoading,
  $reposScanning,
  ALL_PROJECTS,
  enterProject,
  exitProjectScope,
  fetchProjectSessions,
  openProjectCreate,
  refreshProjects,
  refreshProjectTree,
  refreshWorktrees,
  scanAndRecordRepos
} from '@/store/projects'
import {
  $activeStoredSessionId,
  $messagingSessions,
  $searchLoading,
  $sessions,
  $sessionSearch,
  $sessionsLoading,
  $sessionsTotal,
  $workingSessionIds,
  archiveSessionLocal,
  deleteSessionLocal,
  isMessagingSource,
  loadMoreSessions,
  messagingSourceLabel,
  openSession,
  refreshMessagingSessions,
  refreshSessions,
  resetSessionsPaging,
  searchSessionsQuery,
  sessionPinId
} from '@/store/session'
import { openAppRoute } from '@/store/windows'
import type { SessionInfo, SessionSearchResult } from '@/types/hermes'

import { countLabel } from './chrome'
import { SidebarCronJobsSection } from './cron-jobs-section'
import { SidebarLoadMoreButton, SidebarLoadMoreRow } from './load-more-row'
import { ProjectDialog } from './project-dialog'
import {
  type SidebarProjectTree,
  type SidebarSessionGroup,
  sortProjectsForOverview,
  useRepoWorktreeMap
} from './projects/model'
import { ProjectBackRow } from './projects/overview-row'
import { StartWorkButton } from './projects/workspace-header'
import { SidebarPinnedEmptyState } from './section-states'
import { SidebarSessionsSection } from './sessions-section'

// Synthesize a minimal row for a server search hit not in the loaded page.
function searchResultToSession(r: SessionSearchResult): SessionInfo {
  return {
    _lineage_root_id: r.lineage_root ?? null,
    ended_at: null,
    id: r.session_id,
    input_tokens: 0,
    is_active: false,
    last_active: r.session_started ?? 0,
    message_count: 0,
    model: r.model,
    output_tokens: 0,
    preview: r.snippet ?? null,
    source: r.source,
    started_at: r.session_started ?? 0,
    title: r.snippet ?? null,
    tool_call_count: 0
  }
}

function togglePin(pinId: string): void {
  if ($pinnedSessionIds.get().includes(pinId)) {
    unpinSession(pinId)
  } else {
    pinSession(pinId)
  }
}

// Reconcile a manual drag order over the current rows: dragged ids keep their
// stored order; any newer item (not yet in the order) surfaces on top.
function applyManualOrder<T extends { id: string }>(items: T[], ids: string[]): T[] {
  const pos = new Map(ids.map((id, i) => [id, i]))
  const known = items.filter(item => pos.has(item.id)).sort((a, b) => (pos.get(a.id) ?? 0) - (pos.get(b.id) ?? 0))
  const fresh = items.filter(item => !pos.has(item.id))

  return [...fresh, ...known]
}

const SESSIONS_CONTENT_CLASS =
  'flex min-h-0 flex-1 flex-col gap-px overflow-y-auto overflow-x-hidden overscroll-contain pb-1 pr-1.5'

// All-profiles lanes need breathing room between group headers; the flat list
// packs rows at gap-px.
const SESSIONS_CONTENT_GROUPED_CLASS = SESSIONS_CONTENT_CLASS.replace('gap-px', 'gap-3')

const SESSIONS_ROOT_CLASS = 'flex min-h-0 flex-1 flex-col p-0'

// The entered project's sessions, remembered across mounts.
//
// Every other list this body shows lives in a store, so closing and reopening the
// phone's sidebar drawer re-paints them instantly from cache while the refresh
// runs behind. This one was component state, so a reopen started at null and the
// rows blanked and repopulated — the one part of the sidebar that visibly
// reloaded. Module-level, not a store: it is a per-scope render cache, and only
// this component has any use for it.
let cachedEnteredProject: { project: null | SidebarProjectTree; scope: string } | null = null

// The scroll body: search + (query) merged Results, else the Sessions/recents
// list. Pinned lands in Phase 5; messaging groups + cron in Phases 7–8.
export function SidebarScrollBody({
  onNavigate,
  searchPlacement = 'top'
}: {
  onNavigate?: () => void
  /** `bottom` puts the field just above the phone surface's nav bar, where a
   *  thumb already is; the docked pane keeps it at the top of the list. */
  searchPlacement?: 'bottom' | 'top'
}) {
  const { t } = useI18n()
  const s = t.sidebar
  const sessions = useStore($sessions)
  const total = useStore($sessionsTotal)
  const sessionsLoading = useStore($sessionsLoading)
  const activeId = useStore($activeStoredSessionId)
  const working = useStore($workingSessionIds)
  const serverResults = useStore($sessionSearch)
  const searching = useStore($searchLoading)
  const pinnedIds = useStore($pinnedSessionIds)
  const pinsOpen = useStore($sidebarPinsOpen)
  const recentsOpen = useStore($sidebarRecentsOpen)
  const orderManual = useStore($sidebarSessionOrderManual)
  const orderIds = useStore($sidebarSessionOrderIds)
  const grouped = useStore($sidebarAgentsGrouped)
  const scope = useStore($projectScope)
  const projectTree = useStore($projectTree)
  const projectsLoading = useStore($projectTreeLoading)
  const reposScanning = useStore($reposScanning)
  const activeProjectId = useStore($activeProjectId)
  const dismissedProjects = useStore($dismissedAutoProjectIds)
  const projectOrder = useStore($sidebarProjectOrderIds)
  const messagingSessions = useStore($messagingSessions)
  const messagingOpenIds = useStore($sidebarMessagingOpenIds)
  const cronJobs = useStore($cronJobs)
  const cronOpen = useStore($sidebarCronOpen)
  const busy = useStore($busy)
  const runtimeSessionId = useStore($sessionId)
  const profileScope = useStore($profileScope)
  const profiles = useStore($profiles)
  const [messagingReveal, setMessagingReveal] = useState<Record<string, number>>({})

  const [enteredProject, setEnteredProjectState] = useState<SidebarProjectTree | null>(() =>
    cachedEnteredProject?.scope === scope ? cachedEnteredProject.project : null
  )

  const setEnteredProject = useCallback(
    (project: null | SidebarProjectTree) => {
      cachedEnteredProject = { project, scope }
      setEnteredProjectState(project)
    },
    [scope]
  )

  const [query, setQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()

  // Messaging platform sessions poll every 10s (their own slice, so a busy
  // platform never crowds out recents).
  useEffect(() => {
    void refreshMessagingSessions()
    const timer = setInterval(() => void refreshMessagingSessions(), 10_000)

    return () => clearInterval(timer)
  }, [])

  // Cron jobs poll every 30s (list is small; countdowns tick client-side), scoped
  // to the browse scope like the cron overlay is.
  useEffect(() => {
    const cronScope = profileScope === ALL_PROFILES ? 'all' : profileScope
    void refreshCronJobs(cronScope)
    const timer = setInterval(() => void refreshCronJobs(cronScope), 30_000)

    return () => clearInterval(timer)
  }, [profileScope])

  // A big all-profiles page must not carry over into one small profile — but only
  // on an actual switch. On a phone the sidebar is a drawer that unmounts when it
  // closes, so running this on mount meant every reopen silently threw away
  // "Load more" and the list visibly shrank back to one page.
  const scopeAtMount = useRef(profileScope)

  useEffect(() => {
    if (profileScope === scopeAtMount.current) {
      return
    }

    scopeAtMount.current = profileScope
    resetSessionsPaging()
  }, [profileScope])

  // Pull projects + tree when the Projects (grouped) view is active. Paint from
  // the fast tree fetch (explicit projects + repos from existing sessions and the
  // backend's cache) FIRST, then kick off the disk crawl so newly-discovered
  // repos fold in afterwards instead of the crawl blocking the first render.
  useEffect(() => {
    if (grouped) {
      void refreshProjects()
      void refreshProjectTree().finally(() => void scanAndRecordRepos())
    }
  }, [grouped])

  // Out-of-band repo changes (a `git init` or `rm -rf` in another terminal) emit
  // no gateway event, so — like every git GUI — re-pull on window focus / tab
  // visibility rather than stranding the tree until a reload. The tree fetch is
  // cheap and runs every focus; the disk crawl that surfaces brand-new repos is
  // throttled.
  useEffect(() => {
    if (!grouped) {
      return
    }

    let lastScanAt = 0
    const SCAN_THROTTLE_MS = 30_000

    const onActive = () => {
      if (document.visibilityState === 'hidden') {
        return
      }

      void refreshProjects()
      void refreshProjectTree()

      const now = Date.now()

      if (now - lastScanAt >= SCAN_THROTTLE_MS) {
        lastScanAt = now
        void scanAndRecordRepos(true)
      }
    }

    window.addEventListener('focus', onActive)
    document.addEventListener('visibilitychange', onActive)

    return () => {
      window.removeEventListener('focus', onActive)
      document.removeEventListener('visibilitychange', onActive)
    }
  }, [grouped])

  // Hydrate the entered project's sessions (lazy drill-in).
  useEffect(() => {
    if (grouped && scope !== ALL_PROJECTS) {
      void fetchProjectSessions(scope).then(setEnteredProject)
    } else {
      setEnteredProject(null)
    }
  }, [grouped, scope, projectTree, setEnteredProject])

  // A new session lands server-side when its first turn runs, but no gateway
  // event refreshes the sidebar. Re-pull the session list (and, when inside a
  // project, that project's sessions) once a turn settles or the active session
  // changes, so the new session shows in recents AND the entered project without
  // a manual refresh. Also covers the initial mount (busy is false at rest).
  useEffect(() => {
    if (busy) {
      return
    }

    void refreshSessions()

    if (grouped && scope !== ALL_PROJECTS) {
      void fetchProjectSessions(scope).then(setEnteredProject)
    }
  }, [busy, runtimeSessionId, grouped, scope, profileScope, setEnteredProject])

  useEffect(() => {
    const timer = setTimeout(() => void searchSessionsQuery(query), 200)

    return () => clearTimeout(timer)
  }, [query])

  useEffect(() => {
    const onFocus = () => searchInputRef.current?.focus()
    window.addEventListener(SESSION_SEARCH_FOCUS_EVENT, onFocus)

    return () => window.removeEventListener(SESSION_SEARCH_FOCUS_EVENT, onFocus)
  }, [])

  const trimmed = query.trim()

  const results = useMemo(() => {
    if (!trimmed) {
      return []
    }

    const clientMatches = sessions.filter(session => sessionMatchesSearch(session, trimmed))
    const seen = new Set(clientMatches.map(session => session.id))

    return [...clientMatches, ...serverResults.filter(r => !seen.has(r.session_id)).map(searchResultToSession)]
  }, [trimmed, sessions, serverResults])

  // Pinned = loaded sessions whose durable id is pinned, in the stored pin order.
  const pinnedSessions = useMemo(() => {
    const byPinId = new Map(sessions.map(session => [sessionPinId(session), session]))

    return pinnedIds.map(id => byPinId.get(id)).filter((s): s is SessionInfo => Boolean(s))
  }, [sessions, pinnedIds])

  // Recents = loaded sessions minus pinned, newest-first (or the manual order).
  const recents = useMemo(() => {
    const pinnedSet = new Set(pinnedIds)

    const base = sessions
      .filter(session => !pinnedSet.has(sessionPinId(session)))
      // Cron runs + messaging-platform threads have their own sidebar regions
      // (the Cron section + per-platform groups), so keep them out of recents.
      .filter(session => session.source !== 'cron' && !isMessagingSource(session.source))
      .sort((a, b) => (b.started_at || 0) - (a.started_at || 0))

    return orderManual && orderIds.length ? applyManualOrder(base, orderIds) : base
  }, [sessions, pinnedIds, orderManual, orderIds])

  // Per-platform messaging groups (Discord, Telegram, …), busiest first.
  const messagingGroups = useMemo(() => {
    const map = new Map<string, SessionInfo[]>()

    for (const session of messagingSessions) {
      const src = (session.source ?? '').toLowerCase()

      if (!src) {
        continue
      }

      const arr = map.get(src) ?? []
      arr.push(session)
      map.set(src, arr)
    }

    return [...map.entries()]
      .map(([sourceId, groupSessions]) => ({
        label: messagingSourceLabel(sourceId),
        sessions: groupSessions,
        sourceId
      }))
      .sort((a, b) => b.sessions.length - a.sessions.length)
  }, [messagingSessions])

  // Desktop's `multiProfile` gate: with a single profile the rail hides its
  // toggle, so a persisted browse flag would trap the user in the grouped view.
  const showAllProfiles = profiles.length > 1 && profileScope === ALL_PROFILES

  const inProject = grouped && scope !== ALL_PROJECTS && !showAllProfiles

  // ALL-profiles view: one collapsible lane per profile, color on the header (not
  // on every row). Default profile floats to the top, the rest alphabetical.
  const profileGroups = useMemo<SidebarSessionGroup[] | undefined>(() => {
    if (!showAllProfiles) {
      return undefined
    }

    const groups = new Map<string, SidebarSessionGroup>()

    for (const session of recents) {
      const key = normalizeProfileKey(session.profile)

      const group = groups.get(key) ?? { color: profileColor(key), id: key, label: key, path: null, sessions: [] }
      group.sessions.push(session)
      groups.set(key, group)
    }

    return [...groups.values()].sort((a, b) =>
      a.id === 'default' ? -1 : b.id === 'default' ? 1 : a.label.localeCompare(b.label)
    )
  }, [showAllProfiles, recents])

  // Worktree lanes are git-driven, not session-derived: probe `git worktree
  // list` per repo of the entered project so linked worktrees appear even
  // before they hold any Hermes session. Only while drilled in — the overview
  // shows no lanes, so probing there would be pure cost.
  const scopedRepoPaths = useMemo(
    () => (enteredProject?.repos ?? []).map(repo => repo.path).filter((path): path is string => Boolean(path?.trim())),
    [enteredProject]
  )

  const [scopedRepoWorktrees] = useRepoWorktreeMap(scopedRepoPaths, inProject)

  // Out-of-band worktree changes the UI can't see — the agent running `git
  // worktree add/remove` in the terminal during a turn, or an external shell
  // while the window was away. Re-probe on turn-settle and on refocus (the
  // git-GUI standard), gated on being inside a project so it stays free at rest.
  useEffect(() => {
    if (inProject && !busy) {
      refreshWorktrees()
    }
  }, [busy, inProject])

  useEffect(() => {
    if (!inProject) {
      return
    }

    const onFocus = () => refreshWorktrees()
    window.addEventListener('focus', onFocus)

    return () => window.removeEventListener('focus', onFocus)
  }, [inProject])

  // "+" on a repo or worktree lane: open a fresh chat anchored to that path,
  // carrying no draft (unlike the composer's branch-off hand-off).
  const newSessionInWorkspace = useCallback(
    (path: null | string) => {
      startNewSession({ cwd: path ?? '' })
    },
    []
  )

  // Project overview rows: drop dismissed auto-projects, sort, then apply the
  // manual drag order when the user has set one.
  const overview = useMemo(() => {
    if (showAllProfiles) {
      return []
    }

    const dismissedSet = new Set(dismissedProjects)
    const filtered = projectTree.filter(project => !(project.isAuto && dismissedSet.has(project.id)))
    const sorted = sortProjectsForOverview(filtered, activeProjectId)

    return projectOrder.length ? applyManualOrder(sorted, projectOrder) : sorted
  }, [showAllProfiles, projectTree, dismissedProjects, activeProjectId, projectOrder])

  // The per-lane "+" in the browse view: point the app at that profile and start
  // a fresh chat, WITHOUT calling selectProfile — that clears $showAllProfiles and
  // would collapse the browse view the user is standing in.
  const startSessionInProfile = (profileKey: string) => {
    setActiveProfile(profileKey === 'default' ? null : profileKey)
    startNewSession()
  }

  const rowHandlers = {
    activeSessionId: activeId,
    onArchiveSession: (id: string) => void archiveSessionLocal(id),
    onDeleteSession: (id: string) => void deleteSessionLocal(id),
    onResumeSession: (id: string) => {
      void openSession(id)
      // Route back to the session so a page view (Capabilities/Messaging/
      // Artifacts) unmounts and the resumed chat is actually shown.
      navigate(sessionRoute(id))
      onNavigate?.()
    },
    onTogglePin: togglePin,
    workingSessionIdSet: working
  }

  const hasMore = sessions.length < total

  const searchField = (
    <div className="shrink-0 px-2 pb-1 pt-1">
      <SearchField
        aria-label={s.searchAria}
        inputRef={searchInputRef}
        loading={searching}
        onChange={setQuery}
        placeholder={s.searchPlaceholder}
        value={query}
      />
    </div>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col px-2.5 pb-1.5">
      {searchPlacement === 'top' && searchField}

      {trimmed ? (
        <SidebarSessionsSection
          {...rowHandlers}
          collapsible={false}
          contentClassName={SESSIONS_CONTENT_CLASS}
          emptyState={<div className="px-2 py-3 text-xs text-(--ui-text-tertiary)">{s.noMatch(trimmed)}</div>}
          label={s.results}
          onToggle={() => {}}
          open
          pinned={false}
          rootClassName={SESSIONS_ROOT_CLASS}
          sessions={results}
          showProfileTags={showAllProfiles}
        />
      ) : (
        <>
          <SidebarSessionsSection
            {...rowHandlers}
            contentClassName="flex max-h-44 flex-col gap-px overflow-y-auto overflow-x-hidden overscroll-contain rounded-lg pb-2 pt-1"
            emptyState={<SidebarPinnedEmptyState />}
            label={s.pinned}
            onReorderSessions={ids => {
              const byId = new Map(pinnedSessions.map(session => [session.id, session]))
              setPinnedSessionOrder(ids.map(id => sessionPinId(byId.get(id) ?? ({ id } as SessionInfo))))
            }}
            onToggle={() => setSidebarPinsOpen(!pinsOpen)}
            open={pinsOpen}
            pinned
            rootClassName="shrink-0 p-0 pb-1"
            sessions={pinnedSessions}
            showProfileTags={showAllProfiles}
            sortable={pinnedSessions.length > 1}
          />
          <SidebarSessionsSection
            {...rowHandlers}
            activeProjectId={activeProjectId}
            collapsible={!inProject}
            contentClassName={showAllProfiles ? SESSIONS_CONTENT_GROUPED_CLASS : SESSIONS_CONTENT_CLASS}
            emptyState={
              <div className="px-2 py-3 text-xs text-(--ui-text-tertiary)">
                {grouped ? s.projectEmpty : s.noSessions}
              </div>
            }
            footer={
              !grouped && hasMore ? (
                <div className="pt-1">
                  <SidebarLoadMoreButton loading={sessionsLoading} onClick={() => void loadMoreSessions()} step={0} />
                </div>
              ) : null
            }
            groups={profileGroups}
            headerAction={
              <div className="flex shrink-0 items-center gap-0.5">
                {/* Inside a project: spin up a worktree off its repo root. The
                    same dialog the composer's ⌘⇧B opens. */}
                {inProject && enteredProject?.path && (
                  <StartWorkButton onStarted={newSessionInWorkspace} repoPath={enteredProject.path} />
                )}
                {grouped && !inProject && (
                  <Tip label={s.projects.newButton}>
                    <button
                      aria-label={s.projects.newButton}
                      className="grid size-5 place-items-center rounded-sm text-(--ui-text-tertiary) opacity-0 transition-opacity hover:bg-(--ui-control-hover-background) hover:text-foreground group-hover/section:opacity-100 coarse:opacity-100"
                      onClick={openProjectCreate}
                      type="button"
                    >
                      <Codicon name="add" size="0.75rem" />
                    </button>
                  </Tip>
                )}
                <Tip label={grouped ? s.groupTitleGrouped : s.groupTitleUngrouped}>
                  <button
                    aria-label={grouped ? s.showSessions : s.showProjects}
                    className="grid size-5 place-items-center rounded-sm text-(--ui-text-tertiary) opacity-70 transition-colors hover:bg-(--ui-control-hover-background) hover:text-foreground hover:opacity-100"
                    onClick={() => {
                      if (grouped) {
                        exitProjectScope()
                      }

                      setSidebarAgentsGrouped(!grouped)
                    }}
                    type="button"
                  >
                    <Codicon name={grouped ? 'list-unordered' : 'root-folder'} size="0.75rem" />
                  </button>
                </Tip>
              </div>
            }
            label={
              inProject
                ? (enteredProject?.label ?? s.projects.sectionLabel)
                : grouped
                  ? s.projects.sectionLabel
                  : s.sessions
            }
            labelMeta={
              grouped ? (
                // A rescan is a background refresh, not a load: show it next to
                // the section label, and only when the skeleton isn't already
                // saying "loading" (same rule as desktop).
                reposScanning && !projectsLoading ? (
                  <GlyphSpinner ariaLabel={s.loading} className="text-[0.6875rem] text-(--ui-text-quaternary)" />
                ) : undefined
              ) : (
                countLabel(recents.length, total)
              )
            }
            onEnterProject={enterProject}
            onNewSessionInProfile={startSessionInProfile}
            onNewSessionInWorkspace={newSessionInWorkspace}
            onReorderProjects={showAllProfiles ? undefined : ids => setSidebarProjectOrderIds(ids)}
            onReorderSessions={
              grouped || showAllProfiles
                ? undefined
                : ids => {
                    setSidebarSessionOrderManual(true)
                    setSidebarSessionOrderIds(ids)
                  }
            }
            onToggle={() => setSidebarRecentsOpen(!recentsOpen)}
            open={recentsOpen}
            pinned={false}
            projectBackRow={
              inProject ? <ProjectBackRow label={s.projects.back} onExit={exitProjectScope} /> : undefined
            }
            projectContent={inProject ? enteredProject : undefined}
            projectOverview={grouped && !inProject ? overview : undefined}
            projectRepoWorktrees={scopedRepoWorktrees}
            projectsLoading={grouped ? projectsLoading : false}
            rootClassName={SESSIONS_ROOT_CLASS}
            sessions={grouped || showAllProfiles ? [] : recents}
            showProfileTags={showAllProfiles}
            sortable={!grouped && !showAllProfiles}
          />

          {/* Messaging platform groups (Discord etc.) — flat view only, below
              recents; collapsed by default, progressive reveal. */}
          {!grouped &&
            messagingGroups.map(group => {
              const shown = messagingReveal[group.sourceId] ?? 3

              return (
                <SidebarSessionsSection
                  {...rowHandlers}
                  contentClassName="flex max-h-56 flex-col gap-px overflow-y-auto overflow-x-hidden overscroll-contain pb-1.5"
                  emptyState={null}
                  footer={
                    group.sessions.length > shown ? (
                      <div className="flex pt-0.5">
                        <SidebarLoadMoreRow
                          onClick={() => setMessagingReveal(r => ({ ...r, [group.sourceId]: shown + 10 }))}
                          step={10}
                        />
                      </div>
                    ) : null
                  }
                  key={group.sourceId}
                  label={group.label}
                  labelIcon={
                    <PlatformAvatar
                      className="size-4 rounded-[4px] text-[0.5625rem] [&_svg]:size-3"
                      platformId={group.sourceId}
                      platformName={group.label}
                    />
                  }
                  labelMeta={countLabel(Math.min(shown, group.sessions.length), group.sessions.length)}
                  onToggle={() => toggleSidebarMessagingOpen(group.sourceId)}
                  open={messagingOpenIds.includes(group.sourceId)}
                  pinned={false}
                  rootClassName="shrink-0 p-0"
                  sessions={group.sessions.slice(0, shown)}
                />
              )
            })}

          {/* Cron jobs — flat view only, collapsed by default, live countdowns. */}
          {!grouped && cronJobs.length > 0 && (
            <SidebarCronJobsSection
              jobs={cronJobs}
              label={s.cronJobs}
              onManageJob={() => openAppRoute(CRON_ROUTE)}
              onOpenRun={id => {
                void openSession(id)
                navigate(sessionRoute(id))
                onNavigate?.()
              }}
              onToggle={() => setSidebarCronOpen(!cronOpen)}
              onTriggerJob={id => void triggerCron(id)}
              open={cronOpen}
            />
          )}
        </>
      )}

      {searchPlacement === 'bottom' && searchField}

      <ProjectDialog />
    </div>
  )
}
