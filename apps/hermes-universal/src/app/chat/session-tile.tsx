import { atom, computed } from 'nanostores'
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef } from 'react'

import { ChatScreen } from '@/app/chat/chat-screen'
import type { SessionDragPayload } from '@/app/chat/composer/inline-refs'
import { type ComposerScope, ComposerScopeProvider } from '@/app/chat/composer/scope'
import { paneMirror } from '@/app/chat/pane-mirror'
import { startSessionDrag } from '@/app/chat/session-drag'
import { type SessionView, SessionViewProvider } from '@/app/chat/session-view'
import { detachTile } from '@/components/pane-shell/tile/detach'
import { findGroupOfPane } from '@/components/pane-shell/tree/model'
import {
  $layoutTree,
  closeAllTreeTabs,
  closeOtherTreeTabs,
  closeTabPane,
  closeTreeTabsToRight,
  moveTreePane,
  reloadTreePane,
  treeTabCloseTargets
} from '@/components/pane-shell/tree/store'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { translateNow, useI18n } from '@/i18n'
import { sessionTitle } from '@/lib/chat-runtime'
import { DRAFT_TILE_KEY, isDraftTileKey, sessionTilePaneId, WORKSPACE_PANE_ID } from '@/lib/pane-ids'
import { useStoreSelector } from '@/lib/use-session-slice'
import { useStore } from '@/store/atom'
import { type ChatMessage } from '@/store/chat'
import { $draftTitles, createComposerAttachmentScope, draftTitleFor } from '@/store/composer'
import { $gatewayState } from '@/store/gateway'
import { $pinnedSessionIds, pinSession, unpinSession } from '@/store/layout'
import { startNewSessionTab } from '@/store/new-session'
import { sessionAwaitingInput } from '@/store/prompts'
import { $activeStoredSessionId } from '@/store/session'
import { SESSION_ROW_SOURCES, sessionRowFor, useSessionRow, useSessionRowScalars } from '@/store/session-lookup'
import { $sessionStates } from '@/store/session-state-types'
import {
  $confirmCloseTile,
  $sessionTiles,
  closeSessionTile,
  discardSessionTile,
  noteSessionTileMounted,
  patchSessionTile,
  requestCloseSessionTile,
  type SessionTile,
  sessionTileDelegate,
  tileRuntimeKey
} from '@/store/session-states'

import { SessionStatusDot } from './session-status-dot'
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
  // Resolved through the reverse index (which carries lineage aliases) rather
  // than the tile's cached runtimeId, so the tile follows its session across a
  // background auto-compaction instead of pointing at a dead slice (MJX-133).
  const $runtimeId = computed([$sessionTiles, $sessionStates], () => tileRuntimeKey(storedSessionId))

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
    $statusLine: computed($state, s => s?.statusLine ?? ''),
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

/**
 * The DRAFT tile — the unsaved chat, as a tile like any other.
 *
 * There is nothing to resume. A draft already owns a slice in `$sessionStates`
 * under its placeholder key, which is the same kind of slice every other tile
 * resumes INTO, and `tileRuntimeKey` resolves the draft key to it — so the view
 * below is built by the same `buildTileView` every saved tile uses, and a new
 * chat renders through exactly the component an old one does.
 *
 * The runtime key is read live rather than captured: `newSession()` mints a fresh
 * draft key each time, and the tile follows the current one.
 */
function DraftTilePane() {
  const view = useMemo(() => buildTileView(DRAFT_TILE_KEY), [])
  const runtimeId = useStore(view.$runtimeId)

  if (!runtimeId) {
    return null
  }

  return <TileChat runtimeId={runtimeId} storedSessionId={DRAFT_TILE_KEY} view={view} />
}

/** A session tile pane: resumes the stored session into its own state slice on
 *  mount, then renders the tile chat. Shows an error card (retryable) on a
 *  terminal resume failure, or a spinner while the runtime binds. */
export function SessionTilePane({ storedSessionId }: { storedSessionId: string }) {
  const { t } = useI18n()
  // NARROWED to this tile's own entry (MJXHRM-45). One instance of this
  // component mounts per open tile, and each one carries a whole `ChatScreen` +
  // composer subtree — so subscribing to the `$sessionTiles` ARRAY meant tile
  // A's resume / error / reconnect patch re-rendered tiles B, C and D too.
  // `patchSessionTile` maps the array and replaces only the matching entry, so
  // every unrelated tile object keeps its reference and this selector bails.
  const tile = useStoreSelector($sessionTiles, tiles => tiles.find(item => item.storedSessionId === storedSessionId))
  const runtimeId = tile?.runtimeId
  const gatewayOpen = useStore($gatewayState) === 'open'
  const view = useMemo(() => buildTileView(storedSessionId), [storedSessionId])
  const resumingRef = useRef(false)

  // Closes the `chat.open` span opened by the gesture that asked for this tile.
  // A layout effect so it runs in the commit that put the tile on screen; the
  // span itself closes one frame later, when that commit has actually painted.
  useLayoutEffect(() => noteSessionTileMounted(storedSessionId), [storedSessionId])

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
  // The draft names no session, so there is nothing to look up — it takes its
  // name from what has been typed into it instead, falling back to the same
  // "New session" the workspace tab shows for an unsaved chat.
  //
  // Universal reads the title here and re-syncs on `$draftTitles` rather than
  // rendering desktop's self-subscribing `SessionDraftTitle` in the label slot:
  // `paneMirror`'s `title` is a string, and widening it to a node would reshape
  // the pane-shell tab contract for one caller. The cost is bounded — the stash
  // is debounced, and `publishDraftTitle` writes only when the DERIVED title
  // actually changes, which stops happening once the draft passes 48 chars.
  if (isDraftTileKey(storedSessionId)) {
    // The composer stashes under the tile's RUNTIME key, which for the draft is
    // the live placeholder slice — the same resolution its view and busy state
    // already go through.
    return draftTitleFor(tileRuntimeKey(storedSessionId)) || translateNow('sidebar.nav.new-session')
  }

  // The wider lookup, not `$sessions` alone: a tab can outlive the recents page
  // it was opened from, and the bare `'Session'` this used to fall back to was
  // an untranslated placeholder standing in for a chat that has a perfectly good
  // name (MJXHRM-386).
  const stored = sessionRowFor(storedSessionId)

  return stored ? sessionTitle(stored) : translateNow('common.loading')
}

/** The tile tab's lead — the SAME primitive the sidebar row, the switcher and
 *  the mobile bubble strip render, so a session's status can never disagree
 *  between surfaces. It is a NODE rather than the older `accent` string because
 *  it subscribes for itself: a turn starting repaints the dot without the pane
 *  mirror re-registering the tile. A draft tile names no session, so it passes
 *  the null id and gets the draft dot.
 *
 *  `useSessionRow`, not a `$sessions` lookup: the row is only needed to resolve
 *  the IDLE dot's project colour, and a tab can outlive the recents page it was
 *  opened from (MJXHRM-386). Subscribing to the recents page alone would leave
 *  an older session's tab permanently uncoloured. */
function TileTabLead({ storedSessionId }: { storedSessionId: string }) {
  const draft = isDraftTileKey(storedSessionId)
  const stored = useSessionRow(draft ? null : storedSessionId)

  return <SessionStatusDot session={stored} storedSessionId={draft ? null : storedSessionId} />
}

/** The `@session` drag payload for a tile's own tab — same identity a sidebar
 *  row drags, so a tile tab drops with the same stack/split/link language. */
function tileDragPayload(storedSessionId: string): SessionDragPayload {
  const stored = sessionRowFor(storedSessionId)

  return {
    id: storedSessionId,
    profile: stored?.profile || 'default',
    title: stored ? sessionTitle(stored) : tileTitle(storedSessionId)
  }
}

/** Mirror `$sessionTiles` into layout-tree panes (title live-refresh via
 *  `also` — the lead dot subscribes for itself, so colour and status no longer
 *  re-register the tile). `tabDrag` gives a tile's own tab the session drop
 *  language (stack / split / composer-link) via the shared pointer drag
 *  session — a sub-threshold release stays the tab's tap/double-tap. `tabWrap`
 *  gives the tab its right-click session menu (pin / copy / branch / rename /
 *  archive / delete + the tab close verbs). */
export const watchSessionTiles = paneMirror<SessionTile>({
  source: $sessionTiles,
  // Every source `sessionRowFor` reads, so a tab TITLED from the pinned cache or
  // the project tree refreshes when the real row lands — the point of the wider
  // lookup is lost if the strip only re-syncs on `$sessions`.
  //
  // No `$sessionColorById`: the lead dot resolves colour and status for itself,
  // so a recolour repaints it without re-registering the tile.
  //
  // `$draftTitles` is here so the DRAFT tab takes its name from what has been
  // typed into it. It writes only when the derived title actually changes (see
  // `publishDraftTitle`), on the stash's own debounce, and stops changing once
  // the draft passes the 48-character cut.
  also: [...SESSION_ROW_SOURCES, $draftTitles],
  key: tile => tile.storedSessionId,
  kind: 'chat',
  linkTarget: true,
  onNewTab: startNewSessionTab,
  prefix: 'session-tile',
  dir: tile => tile.dir,
  anchor: tile => tile.anchor,
  before: tile => tile.before,
  minWidth: '20rem',
  title: tileTitle,
  tabLead: storedSessionId => <TileTabLead storedSessionId={storedSessionId} />,
  render: storedSessionId =>
    isDraftTileKey(storedSessionId) ? <DraftTilePane /> : <SessionTilePane storedSessionId={storedSessionId} />,
  // The draft has no session to pin, branch, rename, archive or delete, so its
  // tab is a plain tab — the same passthrough `WorkspaceTabMenu` already does for
  // an unsaved chat. It keeps its ✕ (the pane closer below), which is the one
  // verb that means something on an empty chat.
  tabWrap: (storedSessionId, tab) =>
    isDraftTileKey(storedSessionId) ? (
      tab
    ) : (
      <SessionTabMenu paneId={`session-tile:${storedSessionId}`} storedSessionId={storedSessionId}>
        {tab}
      </SessionTabMenu>
    ),
  tabDrag: (storedSessionId, event, onTap, double) => {
    // A draft is not an `@session` — there is no id to link into a composer or
    // hand to another window. Returning false leaves the tab on the ordinary
    // pane drag, so it still moves between zones like every other tab.
    if (isDraftTileKey(storedSessionId)) {
      return false
    }

    // Dropped clear of the window, the tile gets one of its own — the gesture
    // form of the zone menu's "Open in new window".
    startSessionDrag(tileDragPayload(storedSessionId), event, {
      double,
      onTap,
      tearOff: () => void detachTile(sessionTilePaneId(storedSessionId))
    })

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
 *  carry the session verbs (pin / copy / branch / rename / archive / delete)
 *  and, as a layout-tree tab, Reload plus the shared close group (Close / Close
 *  others / Close to the right / Close all). `paneId` is the tab's tree pane id
 *  (a tile = `session-tile:<id>`, the workspace = `workspace`). */
export function SessionTabMenu({
  children,
  storedSessionId,
  paneId
}: {
  children: ReactNode
  storedSessionId: string
  paneId: string
}) {
  // `useSessionRow`, not `$sessions` alone — the same widening `tileTitle` and
  // `TileTabLead` already took (MJXHRM-386/MJXHRM-423). Two consequences, and
  // only the first is cosmetic:
  //
  //  - the tab and its own right-click menu disagreed about the session's name,
  //    the menu falling back to the untranslated literal `'Session'`;
  //  - `pinId` fell back to the RAW stored id, so pinning a session that had
  //    aged out of the recents page wrote the pin under the live tip id instead
  //    of the durable lineage root — the id-mismatch class MJXHRM-414 had to
  //    defend against on the delete path. The sidebar row keys pins by
  //    `sessionPinId`, so the two surfaces would have pinned to different keys.
  //
  // The hook form matters: this is a component, and a tab whose zone mounts
  // before the project tree lands must retitle itself when that source arrives
  // rather than resolving once and staying on the fallback.
  //
  // NARROWED (MJXHRM-45): the scalar face of `useSessionRow`, not the row. One
  // of these wrappers is mounted per open tab, permanently, for a menu that is
  // almost never open — subscribing to all three sources whole re-rendered every
  // tab's wrapper on any recents poll or any OTHER session's title update.
  const { pinId, title: storedTitle } = useSessionRowScalars(storedSessionId)
  // Same reasoning one level down: the pin LIST reference changes whenever any
  // session is pinned or unpinned; this tab only cares about its own membership.
  const isPinned = useStoreSelector($pinnedSessionIds, ids => ids.includes(pinId))
  const title = storedTitle ?? translateNow('common.loading')

  // How many tabs each verb would hit. The shared group DISABLES a verb that
  // would close nothing rather than dropping its row — this menu used to drop
  // them, so the same right-click landed on a different item depending on how
  // many tabs happened to be open.
  //
  // Read, not subscribed. This only ever renders as a tab strip's `tabWrap`,
  // i.e. inside a TreeGroup under LayoutTreeRoot — which already subscribes, so
  // a tree write re-renders this component anyway and the counts stay live. Its
  // own `useStore($layoutTree)` bought nothing and cost a second independent
  // subscriber wakeup, per open tab, on every tree write.
  const closeTargets = treeTabCloseTargets(paneId)

  return (
    <SessionContextMenu
      onArchive={() => void sessionTileDelegate()?.archiveSession(storedSessionId)}
      onBranch={() => void sessionTileDelegate()?.branchSession(storedSessionId)}
      onDelete={() => void sessionTileDelegate()?.deleteSession(storedSessionId)}
      onPin={() => (isPinned ? unpinSession(pinId) : pinSession(pinId))}
      pinned={isPinned}
      sessionId={storedSessionId}
      tab={{
        close: {
          counts: closeTargets,
          // The workspace tab's Close runs the closer registered for it in
          // contrib/controller — the same one ⌘W / ⌘-click / middle-click have
          // always run, which EMPTIES main by promoting the next stacked
          // session into it. Withholding the menu row only hid a verb the
          // gestures already performed (desktop offers it).
          onClose:
            paneId === WORKSPACE_PANE_ID
              ? () => closeTabPane(WORKSPACE_PANE_ID)
              : () => requestCloseSessionTile(storedSessionId),
          onCloseAll: () => closeAllTreeTabs(paneId),
          onCloseOthers: () => closeOtherTreeTabs(paneId),
          onCloseToRight: () => closeTreeTabsToRight(paneId)
        },
        onReload: () => reloadTreePane(paneId)
      }}
      title={title}
    >
      {children}
    </SessionContextMenu>
  )
}

/** Right-click menu for the WORKSPACE (primary) tab — the loaded session's full
 *  verb set, or a plain passthrough on a fresh draft with nothing to act on. */
export function WorkspaceTabMenu({ children }: { children: React.ReactNode }) {
  const selected = useStore($activeStoredSessionId)

  if (!selected) {
    return <>{children}</>
  }

  return (
    <SessionTabMenu paneId={WORKSPACE_PANE_ID} storedSessionId={selected}>
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
