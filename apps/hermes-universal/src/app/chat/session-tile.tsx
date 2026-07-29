import { atom, computed } from 'nanostores'
import { type ReactNode, useEffect, useMemo, useRef } from 'react'

import { ChatScreen } from '@/app/chat/chat-screen'
import type { SessionDragPayload } from '@/app/chat/composer/inline-refs'
import { type ComposerScope, ComposerScopeProvider } from '@/app/chat/composer/scope'
import { paneMirror } from '@/app/chat/pane-mirror'
import { startSessionDrag } from '@/app/chat/session-drag'
import { type SessionView, SessionViewProvider } from '@/app/chat/session-view'
import { findGroupOfPane } from '@/components/pane-shell/tree/model'
import {
  $layoutTree,
  closeAllTreeTabs,
  closeOtherTreeTabs,
  closeTreeTabsToRight,
  moveTreePane
} from '@/components/pane-shell/tree/store'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useI18n } from '@/i18n'
import { sessionTitle } from '@/lib/chat-runtime'
import { useStore } from '@/store/atom'
import { type ChatMessage } from '@/store/chat'
import { createComposerAttachmentScope } from '@/store/composer'
import { $gatewayState } from '@/store/gateway'
import { $pinnedSessionIds, pinSession, unpinSession } from '@/store/layout'
import { sessionAwaitingInput } from '@/store/prompts'
import { $activeStoredSessionId, $sessions, sessionMatchesStoredId, sessionPinId } from '@/store/session'
import { $sessionColorById, sessionColorFor } from '@/store/session-color'
import { $sessionStates } from '@/store/session-state-types'
import {
  $confirmCloseTile,
  $sessionTiles,
  closeSessionTile,
  discardSessionTile,
  patchSessionTile,
  requestCloseSessionTile,
  type SessionTile,
  sessionTileDelegate
} from '@/store/session-states'

import { SessionContextMenu } from './sidebar/session-actions-menu'

const NO_MESSAGES: ChatMessage[] = []

function lastVisibleIsUser(messages: ChatMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'system') {
      continue
    }

    return messages[i].role === 'user'
  }

  return false
}

/** A SessionView driven entirely by the tile's `$sessionStates` slice — the same
 *  shape the primary chat's PRIMARY_SESSION_VIEW provides, so one ChatScreen
 *  serves both. */
function buildTileView(storedSessionId: string): SessionView {
  const $runtimeId = computed(
    $sessionTiles,
    tiles => tiles.find(t => t.storedSessionId === storedSessionId)?.runtimeId ?? null
  )

  const $state = computed([$runtimeId, $sessionStates], (rt, states) => (rt ? states[rt] : undefined))
  const $messages = computed($state, s => s?.messages ?? NO_MESSAGES)

  return {
    kind: 'tile',
    $runtimeId,
    $storedId: atom(storedSessionId),
    $messages,
    $busy: computed($state, s => Boolean(s?.busy)),
    $awaitingResponse: computed($state, s => Boolean(s?.awaitingResponse)),
    $messagesEmpty: computed($messages, m => m.length === 0),
    $lastVisibleIsUser: computed($messages, lastVisibleIsUser),
    $cwd: computed($state, s => s?.cwd ?? ''),
    $model: computed($state, s => s?.model ?? ''),
    $provider: computed($state, s => s?.provider ?? ''),
    $fast: computed($state, s => Boolean(s?.fast)),
    $reasoningEffort: computed($state, s => s?.reasoningEffort ?? '')
  }
}

/** Mounts the shared ChatScreen under the tile's view + a per-tile composer
 *  scope (its own attachment set, awaiting-input edge, and `tile:<id>` focus-bus
 *  target), so N tiled composers coexist without touching the main one. */
function TileChat({
  runtimeId,
  storedSessionId,
  view
}: {
  runtimeId: string
  storedSessionId: string
  view: SessionView
}) {
  const attachments = useRef(createComposerAttachmentScope()).current

  const scope: ComposerScope = useMemo(
    () => ({
      $awaitingInput: sessionAwaitingInput(runtimeId),
      attachments,
      popoutAllowed: false,
      readMessages: () => view.$messages.get(),
      target: `tile:${storedSessionId}`
    }),
    [attachments, runtimeId, storedSessionId, view]
  )

  return (
    // Advertise this tile as a chat surface for the session-drag resolver:
    // `data-session-anchor` = the split anchor + drop target zone;
    // `data-composer-target` = where an @session link drop routes.
    <div
      className="flex h-full min-h-0 flex-col"
      data-composer-target={`tile:${storedSessionId}`}
      data-session-anchor={`session-tile:${storedSessionId}`}
    >
      <SessionViewProvider value={view}>
        <ComposerScopeProvider value={scope}>
          <ChatScreen />
        </ComposerScopeProvider>
      </SessionViewProvider>
    </div>
  )
}

/** A session tile pane: resumes the stored session into its own state slice on
 *  mount, then renders the tile chat. Shows an error card (retryable) on a
 *  terminal resume failure, or a spinner while the runtime binds. */
export function SessionTilePane({ storedSessionId }: { storedSessionId: string }) {
  const { t } = useI18n()
  const tiles = useStore($sessionTiles)
  const tile = tiles.find(item => item.storedSessionId === storedSessionId)
  const runtimeId = tile?.runtimeId
  const gatewayOpen = useStore($gatewayState) === 'open'
  const view = useMemo(() => buildTileView(storedSessionId), [storedSessionId])
  const resumingRef = useRef(false)

  useEffect(() => {
    if (!gatewayOpen || runtimeId || tile?.error || resumingRef.current) {
      return
    }

    const delegate = sessionTileDelegate()

    if (!delegate) {
      return
    }

    resumingRef.current = true

    delegate
      .resumeTile(storedSessionId)
      .then(rt => patchSessionTile(storedSessionId, { error: undefined, runtimeId: rt }))
      .catch((err: unknown) => {
        const message = String((err as { message?: string })?.message ?? err)

        if (/not found|404/i.test(message)) {
          discardSessionTile(storedSessionId)
        } else {
          patchSessionTile(storedSessionId, { error: message })
        }
      })
      .finally(() => {
        resumingRef.current = false
      })
  }, [gatewayOpen, runtimeId, storedSessionId, tile?.error])

  // On reconnect, clear a prior error so the resume effect retries once.
  useEffect(() => {
    if (gatewayOpen && tile?.error) {
      patchSessionTile(storedSessionId, { error: undefined })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gatewayOpen])

  if (tile?.error) {
    return (
      <div className="grid h-full place-items-center p-4 text-center">
        <div className="max-w-sm space-y-3">
          <p className="text-sm text-(--ui-text-secondary)">{tile.error}</p>
          <button
            className="rounded-md border border-(--ui-stroke-secondary) px-3 py-1.5 text-xs hover:bg-(--ui-control-hover-background)"
            onClick={() => patchSessionTile(storedSessionId, { error: undefined })}
            type="button"
          >
            {t.common.retry ?? 'Retry'}
          </button>
        </div>
      </div>
    )
  }

  if (!runtimeId) {
    return (
      <div className="grid h-full place-items-center text-xs text-(--ui-text-quaternary)">
        <span className="animate-pulse">…</span>
      </div>
    )
  }

  return <TileChat runtimeId={runtimeId} storedSessionId={storedSessionId} view={view} />
}

// ---------------------------------------------------------------------------
// Tile pane title/accent (shared map with the sidebar) + the pane-mirror watcher.
// ---------------------------------------------------------------------------

function tileTitle(storedSessionId: string): string {
  const stored = $sessions.get().find(s => sessionMatchesStoredId(s, storedSessionId))

  return stored ? sessionTitle(stored) : 'Session'
}

function tileAccent(storedSessionId: string): string | undefined {
  const stored = $sessions.get().find(s => sessionMatchesStoredId(s, storedSessionId))

  return sessionColorFor(stored)
}

/** The `@session` drag payload for a tile's own tab — same identity a sidebar
 *  row drags, so a tile tab drops with the same stack/split/link language. */
function tileDragPayload(storedSessionId: string): SessionDragPayload {
  const stored = $sessions.get().find(s => sessionMatchesStoredId(s, storedSessionId))

  return {
    id: storedSessionId,
    profile: stored?.profile || 'default',
    title: stored ? sessionTitle(stored) : 'Session'
  }
}

/** Mirror `$sessionTiles` into layout-tree panes (title/accent live-refresh via
 *  `also`). `tabDrag` gives a tile's own tab the session drop language
 *  (stack / split / composer-link) via the shared pointer drag session — a
 *  sub-threshold release stays the tab's tap/double-tap. `tabWrap` gives the
 *  tab its right-click session menu (pin / copy / branch / rename / archive /
 *  delete + the tab close verbs). */
export const watchSessionTiles = paneMirror<SessionTile>({
  source: $sessionTiles,
  also: [$sessions, $sessionColorById],
  key: tile => tile.storedSessionId,
  prefix: 'session-tile',
  dir: tile => tile.dir,
  anchor: tile => tile.anchor,
  before: tile => tile.before,
  minWidth: '20rem',
  title: tileTitle,
  accent: tileAccent,
  render: storedSessionId => <SessionTilePane storedSessionId={storedSessionId} />,
  tabWrap: (storedSessionId, tab) => (
    <SessionTabMenu paneId={`session-tile:${storedSessionId}`} storedSessionId={storedSessionId}>
      {tab}
    </SessionTabMenu>
  ),
  tabDrag: (storedSessionId, event, onTap, double) => {
    startSessionDrag(tileDragPayload(storedSessionId), event, { double, onTap })

    return true
  },
  close: storedSessionId => requestCloseSessionTile(storedSessionId)
})

// ---------------------------------------------------------------------------
// Tab context menus — a tile's tab and the workspace tab both carry the session
// verbs (pin / copy / branch / rename / archive / delete) plus the tab close
// group (Close / Close others / Close to the right / Close all), so a stack of
// main + tiles is a row of interactive session tabs matching hermes-desktop.
// ---------------------------------------------------------------------------

/** Right-click menu for a session tab — a TILE tab or the WORKSPACE tab. Both
 *  carry the session verbs (pin / copy / branch / rename / archive / delete);
 *  as a layout-tree tab they also carry the TAB close group (Close / Close
 *  others / Close to the right / Close all). `paneId` is the tab's tree pane id
 *  (a tile = `session-tile:<id>`, the workspace = `workspace`); `canClose`
 *  gates the plain Close — the uncloseable workspace omits it but keeps the
 *  "close others/right/all" verbs for its zone. */
export function SessionTabMenu({
  children,
  storedSessionId,
  paneId,
  canClose = true
}: {
  children: ReactNode
  storedSessionId: string
  paneId: string
  canClose?: boolean
}) {
  const stored = useStore($sessions).find(s => sessionMatchesStoredId(s, storedSessionId))
  const pinned = useStore($pinnedSessionIds)
  const title = stored ? sessionTitle(stored) : 'Session'
  const pinId = stored ? sessionPinId(stored) : storedSessionId
  const isPinned = pinned.includes(pinId)

  return (
    <SessionContextMenu
      onArchive={() => void sessionTileDelegate()?.archiveSession(storedSessionId)}
      onBranch={() => void sessionTileDelegate()?.branchSession(storedSessionId)}
      onClose={canClose ? () => requestCloseSessionTile(storedSessionId) : undefined}
      onCloseAll={() => closeAllTreeTabs(paneId)}
      onCloseOthers={() => closeOtherTreeTabs(paneId)}
      onCloseToRight={() => closeTreeTabsToRight(paneId)}
      onDelete={() => void sessionTileDelegate()?.deleteSession(storedSessionId)}
      onPin={() => (isPinned ? unpinSession(pinId) : pinSession(pinId))}
      pinned={isPinned}
      sessionId={storedSessionId}
      title={title}
    >
      {children}
    </SessionContextMenu>
  )
}

/** Right-click menu for the WORKSPACE (primary) tab — the loaded session's verbs
 *  minus Close (the workspace is the one tab the app can't lose), or a plain
 *  passthrough on a fresh draft with nothing to act on. */
export function WorkspaceTabMenu({ children }: { children: React.ReactNode }) {
  const selected = useStore($activeStoredSessionId)

  if (!selected) {
    return <>{children}</>
  }

  return (
    <SessionTabMenu canClose={false} paneId="workspace" storedSessionId={selected}>
      {children}
    </SessionTabMenu>
  )
}

// ---------------------------------------------------------------------------
// Close confirmation for a still-running tile ($confirmCloseTile +
// requestCloseSessionTile live in store/session-states so keybinds can reach
// them; the confirm UI is here).
// ---------------------------------------------------------------------------

/** Mounted once at the shell root — the "Close running tab?" gate. */
export function SessionTileCloseConfirm() {
  const { t } = useI18n()
  const pending = useStore($confirmCloseTile)

  return (
    <ConfirmDialog
      confirmLabel={t.zones.closeRunningConfirm}
      description={t.zones.closeRunningBody}
      dismissOnConfirm
      onClose={() => $confirmCloseTile.set(null)}
      onConfirm={() => {
        if (pending) {
          closeSessionTile(pending)
        }

        $confirmCloseTile.set(null)
      }}
      open={Boolean(pending)}
      title={t.zones.closeRunningTitle}
    />
  )
}

/** Layout-reset handler: collapse every tile into the workspace zone as a tab
 *  (instead of re-scattering them across the fresh preset). */
export function stackSessionTilesIntoMain(): void {
  for (const tile of $sessionTiles.get()) {
    const tree = $layoutTree.get()
    const mainGroup = tree ? findGroupOfPane(tree, 'workspace')?.id : null

    if (mainGroup) {
      moveTreePane(`session-tile:${tile.storedSessionId}`, { groupId: mainGroup, pos: 'center' })
    }
  }
}
