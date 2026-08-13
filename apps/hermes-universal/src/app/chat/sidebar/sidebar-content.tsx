import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { PlatformAvatar } from '@/app/messaging/platform-icon'
import { cronJobRoute, sessionRoute } from '@/app/routes'
import { Codicon } from '@/components/ui/codicon'
import { GlyphSpinner } from '@/components/ui/glyph-spinner'
import { SearchField } from '@/components/ui/search-field'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { profileColor } from '@/lib/profile-color'
import { sessionMatchesSearch } from '@/lib/session-search'
import { reuseUnchanged } from '@/lib/structural-share'
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
import { $changeEventsAvailable, $cronChangeTick, livePollIntervalMs } from '@/store/live-sync'
import { newSessionInProfile, startNewSession } from '@/store/new-session'
import { $profileScope, ALL_PROFILES, normalizeProfileKey } from '@/store/profile'
import { $profiles } from '@/store/profiles'
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
  $prBranchBySession,
  recoverSessionPullRequests,
  refreshPullRequests,
  sessionPrKey
} from '@/store/pull-requests'
import {
  $activeStoredSessionId,
  $messagingSessions,
  $pinnedSessionCache,
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
  pinnedSessionRows,
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
import { WorktreeDialog } from './projects/worktree-dialog'
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

// Legacy cadences, kept for a gateway that does not broadcast change events;
// on one that does, the same fetch becomes a slow backstop behind the ticks.
const MESSAGING_POLL_MS = 10_000
const MESSAGING_BACKSTOP_MS = 120_000
// The transcript recovery scan reads every unscanned session's state.db, so it
// waits for the first paint rather than competing with it.
const PR_RECOVERY_WARM_MS = 1_500
const CRON_POLL_MS = 30_000
const CRON_BACKSTOP_MS = 180_000

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
  const changeEventsAvailable = useStore($changeEventsAvailable)
  const cronChangeTick = useStore($cronChangeTick)
  const working = useStore($workingSessionIds)
  const serverResults = useStore($sessionSearch)
  const searching = useStore($searchLoading)
  const pinnedIds = useStore($pinnedSessionIds)
  // Subscribed, not read directly: `pinnedSessionRows` reads the cache with
  // `.get()`, so the section needs a reason to re-render when it changes.
  const pinnedCache = useStore($pinnedSessionCache)
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
  // Subscribed, not read directly: `sessionPrKey` reads it with `.get()`, so the
  // lookup map needs a reason to rebuild when a scan stamps a new key.
  const prBranchOverrides = useStore($prBranchBySession)
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

  // Mirrors `enteredProject` so the setter can share identities without reading
  // state through its closure (which would re-mint it on every render and
  // re-trigger the effects that list it).
  const enteredProjectRef = useRef(enteredProject)

  const setEnteredProject = useCallback(
    (project: null | SidebarProjectTree) => {
      // Identity-shared against what is already on screen (MJXHRM-383). This
      // lands from `fetchProjectSessions`, which is re-run on every turn settle
      // and every tree change; its lanes carry the same memoized
      // `SidebarSessionRow` the flat list does, and a JSON-parsed snapshot has a
      // brand-new object for every row. Reusing the unchanged ones is what lets
      // the row memo bail — and an identical refetch does not re-render at all,
      // because `useState` skips a set of the same reference.
      const shared = reuseUnchanged(enteredProjectRef.current, project)

      enteredProjectRef.current = shared
      cachedEnteredProject = { project: shared, scope }
      setEnteredProjectState(shared)
    },
    [scope]
  )

  const [query, setQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()

  // Messaging platform sessions: their own slice, so a busy platform never
  // crowds out recents. Seeded on mount, then the 10s poll (slowed to a backstop
  // on a broadcasting backend).
  //
  // NOT keyed on `sessionsChangeTick`. `sessions.changed` fires on every
  // state.db write during a streaming turn — floored to 2s server-side — and
  // this fetch asks for 100 rows, so tick-keying it turned the 10s poll it
  // replaced into a 2s one. The tick-driven refresh is coalesced onto a 10s
  // trailing gap in store/live-session-status instead, which also re-pulls the
  // recents list the same broadcast can invalidate.
  useEffect(() => {
    void refreshMessagingSessions()

    const timer = setInterval(
      () => void refreshMessagingSessions(),
      livePollIntervalMs(MESSAGING_POLL_MS, MESSAGING_BACKSTOP_MS)
    )

    return () => clearInterval(timer)
  }, [changeEventsAvailable])

  // Cron jobs: same shape. `cron.changed` fires on create/edit/pause/remove AND
  // on the scheduler's own last_run/next_run bookkeeping, which is exactly when
  // the countdowns need re-reading. Scoped to the browse scope like the overlay.
  useEffect(() => {
    const cronScope = profileScope === ALL_PROFILES ? 'all' : profileScope
    void refreshCronJobs(cronScope)

    const timer = setInterval(() => void refreshCronJobs(cronScope), livePollIntervalMs(CRON_POLL_MS, CRON_BACKSTOP_MS))

    return () => clearInterval(timer)
  }, [changeEventsAvailable, cronChangeTick, profileScope])

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

  // Pinned, in the stored pin order — EVERY pin, not just the ones the current
  // page happens to cover. A pinned chat that has fallen past the loaded window
  // resolves from its last-known row (`$pinnedSessionCache`) instead of silently
  // disappearing from the section while its pin is still stored.
  const pinnedSessions = useMemo(
    () => pinnedSessionRows(sessions, pinnedIds),
    // `pinnedCache` looks unnecessary to the linter and is not: the memo body
    // never names it, but `pinnedSessionRows` reads `$pinnedSessionCache` with
    // `.get()`, so this is what makes the rows recompute when the cache moves —
    // in lockstep with these two by store/session.ts's subscriptions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessions, pinnedIds, pinnedCache]
  )

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

  // A session that started on trunk but did the work in a worktree recorded no
  // usable branch, so the join below can never find its PR. Recover those from
  // the transcripts once, off the critical path — the store remembers every id
  // it looked at, so this settles to a no-op from the second pass on.
  useEffect(() => {
    if (sessions.length === 0) {
      return
    }

    const warm = window.setTimeout(() => void recoverSessionPullRequests(sessions), PR_RECOVERY_WARM_MS)

    return () => window.clearTimeout(warm)
  }, [sessions])

  // Ask about the branches ON SCREEN, not the repo at large, so a busy repo's
  // newer PRs can't crowd out the ones these rows need.
  const prLookupsByRepo = useMemo(() => {
    const byRepo: Record<string, string[]> = {}

    for (const session of sessions) {
      // The row's own key, so a session stamped with a branch (or a PR number)
      // asks about THAT, not the branch it started on.
      const [root, lookup] = sessionPrKey(session)?.split('\n') ?? []

      if (root && lookup && !byRepo[root]?.includes(lookup)) {
        byRepo[root] = [...(byRepo[root] ?? []), lookup]
      }
    }

    return byRepo
    // prBranchOverrides is what `sessionPrKey` reads through — a recovered PR
    // has to re-ask with the key it just learned.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [sessions, prBranchOverrides])

  // A stable identity for "the same question as last time", so a re-render that
  // rebuilds the map doesn't re-ask GitHub.
  const prQueryKey = JSON.stringify(
    Object.entries(prLookupsByRepo)
      .map(([root, lookups]) => [root, [...lookups].sort()] as const)
      .sort(([a], [b]) => a.localeCompare(b))
  )

  useEffect(() => {
    if (prQueryKey === '[]') {
      return
    }

    const byRepo = Object.fromEntries(JSON.parse(prQueryKey) as [string, string[]][])

    void refreshPullRequests(byRepo)

    // A PR opens, merges or gets closed on github.com, not in here — so like the
    // project tree, re-pull when the window comes back. The store's own
    // staleness window keeps a flurry of focus events to one call per repo.
    const onActive = () => {
      if (document.visibilityState !== 'hidden') {
        void refreshPullRequests(byRepo)
      }
    }

    window.addEventListener('focus', onActive)
    document.addEventListener('visibilitychange', onActive)

    return () => {
      window.removeEventListener('focus', onActive)
      document.removeEventListener('visibilitychange', onActive)
    }
  }, [prQueryKey])

  // "+" on a repo or worktree lane: open a fresh chat anchored to that path,
  // carrying no draft (unlike the composer's branch-off hand-off).
  const newSessionInWorkspace = useCallback((path: null | string) => {
    startNewSession({ cwd: path ?? '' })
  }, [])

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

  // The per-lane "+" in the browse view uses the shared `newSessionInProfile`
  // (store/new-session) — which deliberately does NOT call `selectProfile`, so
  // the browse view the user is standing in survives the click.

  // Stable identities, so `renderRow` one layer down (`sessions-section`) — a
  // `useCallback` listing all three — keeps its identity too.
  //
  // BE PRECISE about what this buys, because the first pass at MJXHRM-383 was
  // not: `renderRow` is INVOKED during render by every consumer
  // (`sessions-section` itself, `profile-group`, `overview-row`,
  // `workspace-group`, `entered-content`) and none of them is memoized, so a
  // stable `renderRow` skips nothing on its own today. It is correct, it is free
  // and it stops being a lie the moment anything above the row is memoized — but
  // it is not why rows re-render.
  //
  // What actually decides that is `SidebarSessionRow`'s own memo, whose
  // comparator deliberately IGNORES these handlers and resolves the row down to
  // `Object.is(prev.session, next.session)`. Which is why the fix that made the
  // memo hit had to land in the STORES: see `reuseUnchanged` and its use in
  // `store/session.ts` / `store/projects.ts`.
  const onArchiveSession = useCallback((id: string) => void archiveSessionLocal(id), [])
  const onDeleteSession = useCallback((id: string) => void deleteSessionLocal(id), [])

  const onResumeSession = useCallback(
    (id: string) => {
      void openSession(id)
      // Route back to the session so a page view (Capabilities/Messaging/
      // Artifacts) unmounts and the resumed chat is actually shown.
      navigate(sessionRoute(id))
      onNavigate?.()
    },
    [navigate, onNavigate]
  )

  // `activeId` and `working` legitimately change what a row renders, so they
  // are not stabilized — they are the inputs `renderRow` SHOULD re-run for.
  const rowHandlers = useMemo(
    () => ({
      activeSessionId: activeId,
      onArchiveSession,
      onDeleteSession,
      onResumeSession,
      onTogglePin: togglePin,
      workingSessionIdSet: working
    }),
    [activeId, onArchiveSession, onDeleteSession, onResumeSession, working]
  )

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
                {inProject && enteredProject?.path && <StartWorkButton repoPath={enteredProject.path} />}
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
            onNewSessionInProfile={newSessionInProfile}
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
              // Carry the row's job into the cron surface, or "Manage" on ANY
              // row lands on whichever job sorts first — the kebab acting on
              // someone else's job.
              onManageJob={jobId => openAppRoute(cronJobRoute(jobId))}
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
      {/* One mount for the whole app — see the WorktreeDialog header for why. */}
      <WorktreeDialog />
    </div>
  )
}
