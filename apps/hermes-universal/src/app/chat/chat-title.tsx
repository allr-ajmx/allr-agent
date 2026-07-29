import { useLocation } from 'react-router-dom'

import { SessionActionsMenu, SessionContextMenu } from '@/app/chat/sidebar/session-actions-menu'
import { appViewForPath } from '@/app/routes'
import { TitleMenuTrigger } from '@/components/ui/title-menu-trigger'
import { useI18n } from '@/i18n'
import { useStore } from '@/store/atom'
import { $liveSessionTitle, $sessionId } from '@/store/chat'
import { $pinnedSessionIds, pinSession, unpinSession } from '@/store/layout'
import {
  $activeStoredSessionId,
  $sessions,
  archiveSessionLocal,
  deleteSessionLocal,
  sessionPinId
} from '@/store/session'

// A plain (non-interactive) title span, shared by the "New session" and page-view
// (Capabilities/Messaging/Artifacts) cases.
const PLAIN_TITLE_CLASS =
  'inline-flex h-6 max-w-full items-center truncate px-2 text-[0.75rem] font-medium leading-none text-(--ui-text-tertiary)'

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
export function ChatTitle() {
  const { t } = useI18n()
  const { pathname } = useLocation()
  const activeId = useStore($activeStoredSessionId)
  const runtimeSessionId = useStore($sessionId)
  const sessions = useStore($sessions)
  const pinnedIds = useStore($pinnedSessionIds)
  const liveTitle = useStore($liveSessionTitle)

  // Page views win regardless of any session loaded in state behind them.
  const view = appViewForPath(pathname)

  if (view === 'skills' || view === 'messaging' || view === 'artifacts') {
    return <span className={PLAIN_TITLE_CLASS}>{t.sidebar.nav[view]}</span>
  }

  if (!activeId && !runtimeSessionId) {
    return <span className={PLAIN_TITLE_CLASS}>{t.sidebar.nav['new-session']}</span>
  }

  // Resolve by STORED id (resumed) or live RUNTIME id (a new session that has
  // since landed in the list), so the title updates once the auto-title arrives.
  const lookupId = activeId ?? runtimeSessionId
  const session = lookupId ? sessions.find(s => s.id === lookupId) : null

  // Until the session is in `sessions`, fall back to the live auto-title so it
  // stops saying "New session" as soon as the title lands.
  const title = session
    ? session.title?.trim() || session.preview?.trim() || 'Untitled'
    : liveTitle.trim() || 'New session'

  if (!session) {
    return <span className={PLAIN_TITLE_CLASS}>{title}</span>
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
      <span className="inline-flex min-w-0 max-w-full">
        <SessionActionsMenu {...actions}>
          <TitleMenuTrigger>{title}</TitleMenuTrigger>
        </SessionActionsMenu>
      </span>
    </SessionContextMenu>
  )
}
