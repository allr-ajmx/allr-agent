import { useLocation } from 'react-router-dom'

import { SessionActionsMenu, SessionContextMenu } from '@/app/chat/sidebar/session-actions-menu'
import { appViewForPath } from '@/app/routes'
import { TitleMenuTrigger } from '@/components/ui/title-menu-trigger'
import { useI18n } from '@/i18n'
import { sessionTitle } from '@/lib/chat-runtime'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import { $liveSessionTitle, $sessionId } from '@/store/chat'
import { $pinnedSessionIds, pinSession, unpinSession } from '@/store/layout'
import { $activeStoredSessionId, archiveSessionLocal, deleteSessionLocal, sessionPinId } from '@/store/session'
import { useSessionRow } from '@/store/session-lookup'

// A plain (non-interactive) title span, shared by the "New session" and page-view
// (Capabilities/Messaging/Artifacts) cases.
const PLAIN_TITLE_CLASS =
  'inline-flex h-6 max-w-full items-center truncate px-2 text-[0.75rem] font-medium leading-4 text-(--ui-text-tertiary)'

// The active session's title as a clickable pill that opens the session actions
// menu (Rename / Pin / Archive / Delete) + a right-click context menu. Extracted
// from ChatHeader so it can also live in the mobile top bar (mobile has a fixed
// layout, so the title sits in the top bar instead of its own header row).
//
// Route-aware: on the Capabilities/Messaging/Artifacts pages it shows the view
// name instead of a session title, and on the empty new-session view it shows
// "New session". This only surfaces where ChatTitle is mounted across routes —
// the mobile top bar (MobileTopBar); desktop's ChatHeader is chat-only and keeps
// its own null guard so the empty view stays blank there.
//
// `className` is how the phone's top bar makes this fill the row: there the
// title is the bar's only large target and its one menu, so it takes the whole
// height and the whole width and left-aligns — the same shape the windowable
// surfaces' title menu already has. Desktop's header keeps the content-width
// pill it was drawn as.
export function ChatTitle({ className }: { className?: string }) {
  const { t } = useI18n()
  const { pathname } = useLocation()
  const activeId = useStore($activeStoredSessionId)
  const runtimeSessionId = useStore($sessionId)
  const pinnedIds = useStore($pinnedSessionIds)
  const liveTitle = useStore($liveSessionTitle)

  // Resolve by STORED id (resumed) or live RUNTIME id (a new session that has
  // since landed in the list), so the title updates once the auto-title arrives.
  //
  // The WIDE lookup, not `$sessions.find(s => s.id === lookupId)` (MJXHRM-386).
  // Two independent defects lived in that one line, on the three surfaces this
  // component IS — the mobile top bar, the desktop chat header, and a DETACHED
  // session window's titlebar:
  //
  //  - `$sessions` is the paginated RECENTS PAGE, not the set of sessions that
  //    exist, and `openSession` never inserts the row it resumed. So opening a
  //    session older than that window resolved to nothing and the bar read
  //    "New session" over a named conversation. Not merely cosmetic: with no
  //    row there is no pill, so the entire session menu (rename / pin / archive
  //    / delete) and the right-click menu were absent on exactly those chats —
  //    including in a detached window, whose titlebar is the ONLY place they
  //    are reachable from.
  //  - `s.id === lookupId` is not the lineage rule the rest of the app resolves
  //    by (`sessionMatchesStoredId`), so an id held from before an
  //    auto-compaction missed a row that WAS loaded.
  //
  // Called before every early return below, and derived from atoms rather than
  // from anything a return could skip, because it is a hook.
  const lookupId = activeId ?? runtimeSessionId
  const session = useSessionRow(lookupId)

  // Page views win regardless of any session loaded in state behind them.
  const view = appViewForPath(pathname)

  if (view === 'skills' || view === 'messaging' || view === 'artifacts') {
    return <span className={cn(PLAIN_TITLE_CLASS, className)}>{t.sidebar.nav[view]}</span>
  }

  if (!activeId && !runtimeSessionId) {
    return <span className={cn(PLAIN_TITLE_CLASS, className)}>{t.sidebar.nav['new-session']}</span>
  }

  // Until SOME source has seen the row, fall back to the live auto-title, so
  // the bar stops saying "New session" the moment the title lands.
  //
  // Failing that, the two unresolved cases are not the same chat: a STORED id
  // we hold but cannot yet resolve is a conversation still LOADING, while a
  // chat with only a runtime id has genuinely never been saved. The old copy
  // called both of them new — the same lie `syncWorkspaceTitle` stopped telling
  // for the workspace tab (MJXHRM-386).
  //
  // `sessionTitle` (lib/chat-runtime) rather than a local title→preview→literal
  // chain, so this bar, the workspace tab and every tile tab name a session
  // with one function.
  const title = session
    ? sessionTitle(session)
    : liveTitle.trim() || (activeId ? t.common.loading : t.sidebar.nav['new-session'])

  if (!session) {
    return <span className={cn(PLAIN_TITLE_CLASS, className)}>{title}</span>
  }

  const pinId = sessionPinId(session)
  const isPinned = pinnedIds.includes(pinId)

  const actions = {
    sessionId: session.id,
    title,
    pinned: isPinned,
    onArchive: () => void archiveSessionLocal(session.id),
    onDelete: () => void deleteSessionLocal(session.id),
    onPin: () => (isPinned ? unpinSession(pinId) : pinSession(pinId))
  }

  return (
    <SessionContextMenu {...actions}>
      {/* Real element for the context-menu trigger (SessionActionsMenu is a
          fragment). The pill inside is the click/dropdown trigger. */}
      <span className={cn('inline-flex min-w-0 max-w-full', className)}>
        <SessionActionsMenu {...actions}>
          <TitleMenuTrigger className={className}>{title}</TitleMenuTrigger>
        </SessionActionsMenu>
      </span>
    </SessionContextMenu>
  )
}
