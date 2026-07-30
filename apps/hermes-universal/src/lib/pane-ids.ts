/**
 * Pane-id vocabulary for the layout tree — a LEAF module.
 *
 * The tree stores only pane ids, so "is this pane a chat?" is a string test,
 * and it was spelled out as a literal `'session-tile:'` in six places across
 * three layers (the tree store, its renderer, the session store, the drag
 * resolver). The layout layer cannot import `store/session-states`, so the
 * shared spelling lives here instead.
 */

/** A session tile's pane id is this prefix plus its STORED session id. */
export const TILE_PANE_PREFIX = 'session-tile:'

/** The main workspace pane — the chat that is not a tile. */
export const WORKSPACE_PANE_ID = 'workspace'

export const sessionTilePaneId = (storedSessionId: string): string => `${TILE_PANE_PREFIX}${storedSessionId}`

/** The stored session id a tile pane names, or null if it isn't a tile pane. */
export const storedIdFromTilePane = (paneId: string): null | string =>
  paneId.startsWith(TILE_PANE_PREFIX) ? paneId.slice(TILE_PANE_PREFIX.length) : null

/** Whether a pane renders a chat — the workspace or any session tile. This is
 *  what makes a zone a "chat zone", i.e. one whose tab strip is a session strip. */
export const isChatPaneId = (paneId: string): boolean =>
  paneId === WORKSPACE_PANE_ID || paneId.startsWith(TILE_PANE_PREFIX)
