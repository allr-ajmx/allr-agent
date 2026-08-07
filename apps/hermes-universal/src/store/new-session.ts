/**
 * "NEW SESSION", AS ONE ACT — the entry point behind ⌘N, ⌘T, the sidebar rail's
 * New session row, a chat strip's `+`, `/new`, and the sidebar's per-repo /
 * per-profile `+`.
 *
 * Creating a chat is three things, not one: the session exists, the surface
 * showing it is the focused one, and the caret is in its composer. Every entry
 * point used to do a different subset — ⌘T did none of the last two — so a new
 * session landed focused, half-focused or not at all depending on how you asked
 * for it (MJXHRM-6). They all funnel through here now, and the behaviour cannot
 * drift apart again.
 *
 * `newSession()` itself deliberately stays focus-free: session delete, archive,
 * profile switch, project-scope exit and the secondary window's re-home all call
 * it as a CONSEQUENCE of something else, and none of them may yank the caret.
 *
 * This module composes `session`, `session-states` and `chat-bubbles` rather
 * than living inside one of them — `chat-bubbles` already imports
 * `session-states`, so the mobile branch cannot live there without a cycle.
 * Nothing in `store/` imports this file; keep it that way. A store that needs a
 * new session wants `newSession()` / `newSessionTab()`, not the focus act.
 */

import { type ComposerTarget, requestComposerFocus } from '@/app/chat/composer/focus'
import { NEW_CHAT_ROUTE } from '@/app/routes'
import { DRAFT_TILE_KEY } from '@/lib/pane-ids'
import { IS_MOBILE } from '@/lib/platform'
import { navigateTo } from '@/lib/route-nav'
import { newChatBubble } from '@/store/chat-bubbles'
import { NEW_SESSION_FLASH_EVENT } from '@/store/layout'
import { newSession, startSessionInWorkspace } from '@/store/session'
import { focusWorkspaceSession, newSessionTab } from '@/store/session-states'

/**
 * Land on the chat that was just created: route to it, front its pane and claim
 * its zone, put the caret in its composer, flash the rail.
 *
 * Runs AFTER the session exists. `newSession()` homes the focused zone to null
 * synchronously on its way through (the `$activeStoredSessionId` listener in
 * `session-states`), so this has to be the last writer or it claims a zone that
 * is about to change.
 *
 * `surface` is where the new chat actually WENT. ⌘N loads it in main; ⌘T gives it
 * its own tile, and a tile has its own composer scope — focusing `'main'` there
 * would put the caret in a different chat's input than the one just opened.
 */
function landOnNewSession(surface: { composer: ComposerTarget; focusZone: () => void }): void {
  // A page view (Skills / Messaging / Artifacts) owns the workspace pane, so a
  // new chat created underneath one is invisible and has no composer to focus.
  navigateTo(NEW_CHAT_ROUTE)

  surface.focusZone()
  requestComposerFocus(surface.composer)

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(NEW_SESSION_FLASH_EVENT))
  }
}

/**
 * ⌘N, the rail's New session row, `/new`, and the sidebar's per-lane `+`.
 *
 * `cwd` anchors the draft to a repo or worktree (the sidebar's `+`). An anchored
 * chat replaces the one on screen on every platform: a mobile bubble cannot
 * carry the anchor.
 */
export function startNewSession({ cwd }: { cwd?: string } = {}): void {
  if (cwd?.trim()) {
    startSessionInWorkspace(cwd)
  } else if (IS_MOBILE) {
    // A parallel bubble beside the current chat. A no-op when already on a
    // draft — but the caret still moves, which is the point of the ticket.
    newChatBubble()
  } else {
    newSession()
  }

  // The fresh chat loads in MAIN — on phones too, where the only composer scope
  // is the default one (session tiles, the other scope, are desktop-only).
  landOnNewSession({ composer: 'main', focusZone: focusWorkspaceSession })
}

/**
 * ⌘T and the `+` at the end of a chat tab strip: the new chat opens as its OWN
 * tile, beside whatever is already there. Desktop-only surface, so no bubble
 * branch.
 *
 * `newSessionTab` claims the draft tile's zone itself, so the zone act here is a
 * no-op — passed anyway so both entry points read the same and neither can
 * silently lose its focus step.
 */
export function startNewSessionTab(): void {
  newSessionTab()
  landOnNewSession({ composer: `tile:${DRAFT_TILE_KEY}`, focusZone: () => undefined })
}
