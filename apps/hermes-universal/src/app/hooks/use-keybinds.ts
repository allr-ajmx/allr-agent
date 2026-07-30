import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'

import { activateTreeTabSlot, closeWorkspaceTab, cycleTreeTabInFocusedZone } from '@/components/pane-shell/tree/store'
import { contributedKeybindHandler, PROFILE_SLOT_COUNT, SESSION_SLOT_COUNT } from '@/lib/keybinds/actions'
import { comboAllowedInInput, comboFromEvent, isEditableTarget } from '@/lib/keybinds/combo'
import { IS_MOBILE } from '@/lib/platform'
import { newChatBubble } from '@/store/chat-bubbles'
import { toggleCommandMenu } from '@/store/command-menu'
import { $capture, $comboIndex, endCapture, setBinding } from '@/store/keybinds'
import {
  $terminalOpen,
  FILE_TREE_PANE_ID,
  NEW_SESSION_FLASH_EVENT,
  requestSessionSearchFocus,
  setTerminalOpen,
  toggleLeftEdge,
  togglePanesFlipped,
  toggleRightEdge
} from '@/store/layout'
import { setModelPickerOpen } from '@/store/model'
import { setPaneOpen } from '@/store/panes'
import { cycleProfile, switchProfileToSlot, switchToDefaultProfile } from '@/store/profiles'
import { toggleReview } from '@/store/review'
import { newSession, toggleSelectedPin } from '@/store/session'
import {
  $focusedStoredSessionId,
  $sessionTiles,
  focusOpenSession,
  newSessionTab,
  reopenLastClosedTile,
  requestCloseSessionTile
} from '@/store/session-states'
import {
  $switcherOpen,
  closeSwitcher,
  commitOnCtrlUp,
  onSwitcherTabDown,
  onSwitcherTabUp,
  openOrAdvanceSwitcher,
  slotSessionId,
  switcherActive,
  switcherJustClosed
} from '@/store/session-switcher'
import { closeActiveTerminal, createTerminal, cycleTerminal } from '@/store/terminals'
import { openAppRoute, openNewWindow } from '@/store/windows'
import { useTheme } from '@/themes/context'

import { requestComposerFocus, requestVoiceToggle } from '../chat/composer/focus'
import {
  AGENTS_ROUTE,
  ARTIFACTS_ROUTE,
  CRON_ROUTE,
  MESSAGING_ROUTE,
  NEW_CHAT_ROUTE,
  PROFILES_ROUTE,
  sessionRoute,
  SETTINGS_ROUTE,
  SKILLS_ROUTE
} from '../routes'

// Ported from desktop `app/hooks/use-keybinds.ts`. Structure, dispatch and the
// switcher plumbing are unchanged; the handler bodies point at universal's
// stores. Actions whose subsystem universal lacks (tab tree, multi-window,
// worktrees, all-profiles) ship unbound in `lib/keybinds/actions.ts` and simply
// get no handler here — the dispatcher already no-ops on a missing one.
//
// Desktop scopes ⌘1…⌘9 and ⌃Tab to the FOCUSED pane-shell tab strip first, and
// only falls through to profiles / the session switcher when the focus isn't a
// tab strip. Universal has no tab tree, so it always takes that fall-through
// branch — the calls are simply inlined rather than guarded.
export interface KeybindRuntimeDeps {
  /** Open/close the command center overlay (sessions / system / usage). */
  toggleCommandCenter: () => void
}

type HandlerMap = Record<string, () => void>

// Mount once near the top of the app. Owns the single global keydown listener
// for every rebindable hotkey: it runs the matched action, or — while capture
// mode is active (edit overlay / panel rebind) — records the pressed combo.
export function useKeybinds(deps: KeybindRuntimeDeps): void {
  const navigate = useNavigate()
  const { resolvedMode, setMode } = useTheme()

  // Keep the latest closures without re-subscribing the listener.
  const handlersRef = useRef<HandlerMap>({})
  const commitSwitcherRef = useRef<() => void>(() => {})

  const profileSwitchHandlers: HandlerMap = {}

  for (let slot = 1; slot <= PROFILE_SLOT_COUNT; slot += 1) {
    profileSwitchHandlers[`profile.switch.${slot}`] = () => switchProfileToSlot(slot)
  }

  // A session that is ALREADY on screen — an open tab or the main thread — is
  // fronted rather than re-opened. Without this, picking it from the switcher
  // or the sidebar loaded a second copy into main while its tab sat there
  // holding the same conversation.
  const goToSession = (sessionId: null | string) => {
    if (!sessionId || focusOpenSession(sessionId)) {
      return
    }

    navigate(sessionRoute(sessionId))
  }

  // ^N jumps straight to the Nth recent session and dismisses the switcher.
  const sessionSlotHandlers: HandlerMap = {}

  for (let slot = 1; slot <= SESSION_SLOT_COUNT; slot += 1) {
    sessionSlotHandlers[`session.slot.${slot}`] = () => {
      // The focused chat strip's Nth TAB first; the Nth recent session only
      // when no multi-tab chat zone has focus.
      //
      // (Desktop overloads ⌘1-9 for this and falls through to profiles.
      // Universal already spends ⌘1-9 on profiles and has ⌃1-9 free for
      // sessions, so there is nothing to overload — the tab meaning simply
      // takes precedence within the key that already means "session N".)
      if (activateTreeTabSlot(slot)) {
        closeSwitcher()

        return
      }

      closeSwitcher()
      goToSession(slotSessionId(slot))
    }
  }

  commitSwitcherRef.current = () => goToSession(commitOnCtrlUp())

  // ⌃Tab belongs to the FOCUSED TAB STRIP when one is in play — that is what
  // the key means everywhere else in the app — and only falls through to the
  // recent-session HUD when the focus isn't a chat strip with something to
  // cycle. Desktop scopes it the same way.
  const stepSession = (direction: 1 | -1) => {
    if (cycleTreeTabInFocusedZone(direction)) {
      return
    }

    onSwitcherTabDown()
    goToSession(openOrAdvanceSwitcher(direction))
  }

  // Reveal the file tree and drop the terminal out of the way. Universal's
  // "file browser" is the FILE_TREE pane; the terminal is its own bottom dock.
  const showFiles = () => {
    setPaneOpen(FILE_TREE_PANE_ID, true)
    setTerminalOpen(false)
  }

  handlersRef.current = {
    // Universal's settings overlay routes per-section (`/settings/:id`) rather
    // than desktop's `?tab=` query; the keybind panel lives at `shortcuts`.
    'keybinds.openPanel': () => openAppRoute(`${SETTINGS_ROUTE}/shortcuts`),

    'composer.focus': () => requestComposerFocus('main'),
    'composer.modelPicker': () => setModelPickerOpen(true),
    'composer.voice': requestVoiceToggle,

    'nav.commandPalette': toggleCommandMenu,
    'nav.commandCenter': deps.toggleCommandCenter,
    'nav.settings': () => openAppRoute(SETTINGS_ROUTE),
    'nav.profiles': () => navigate(PROFILES_ROUTE),
    'nav.skills': () => navigate(SKILLS_ROUTE),
    'nav.messaging': () => navigate(MESSAGING_ROUTE),
    'nav.artifacts': () => navigate(ARTIFACTS_ROUTE),
    'nav.cron': () => navigate(CRON_ROUTE),
    'nav.agents': () => navigate(AGENTS_ROUTE),

    // Match the sidebar New Session button — the same three steps
    // `use-sidebar-keybinds` used to run for ⌘N before the registry took over.
    'session.new': () => {
      // Mobile: a new bubble alongside the current chat (no-op on a draft).
      if (IS_MOBILE) {
        newChatBubble()
      } else {
        newSession()
      }

      navigate(NEW_CHAT_ROUTE)
      window.dispatchEvent(new CustomEvent(NEW_SESSION_FLASH_EVENT))
    },
    // ⌘⇧N opens a full app instance in a new native window (desktop only; MJX-104).
    'session.newWindow': () => void openNewWindow(),
    // ⌃Tab steps through the recent-session switcher.
    'session.next': () => stepSession(1),
    'session.prev': () => stepSession(-1),
    ...sessionSlotHandlers,
    'session.focusSearch': requestSessionSearchFocus,
    'session.togglePin': toggleSelectedPin,

    // Narrow-viewport reveal is handled inside the store toggles now.
    // Both are POSITIONAL (see `store/layout.ts`): ⌘B drives whatever sits on the
    // left of main, ⌘J the right — so they track the titlebar buttons through a
    // pane swap instead of staying pinned to one sidebar.
    'view.toggleSidebar': toggleLeftEdge,
    // ⌘J toggles the file browser — the "secondary panel" toggle.
    'view.toggleRightSidebar': toggleRightEdge,
    'view.toggleReview': toggleReview,
    'view.showFiles': showFiles,
    'view.showTerminal': () => setTerminalOpen(!$terminalOpen.get()),
    // Create first so the area's open-effect ensure sees a non-empty set and
    // doesn't also spawn one — net effect is exactly one fresh terminal.
    'view.newTerminal': () => {
      createTerminal()
      setTerminalOpen(true)
    },
    // Switch / close only act while the terminal is open (no focus-scoping here,
    // so this stands in for "terminal is showing").
    'view.nextTerminal': () => $terminalOpen.get() && cycleTerminal(1),
    'view.prevTerminal': () => $terminalOpen.get() && cycleTerminal(-1),
    'view.closeTerminal': () => $terminalOpen.get() && closeActiveTerminal(),
    'view.flipPanes': togglePanesFlipped,

    // ⌘T new tab, ⌘W close tab, ⌘⇧T reopen the last closed one.
    //
    // The main thread is a pane like any other, so "new tab" means: park the
    // conversation currently in it as its own tab, then start a fresh chat in
    // the main pane. Both end up in the same strip, which is what the user
    // sees as two tabs. (An unsaved draft has nothing to park.)
    'session.newTab': newSessionTab,
    // Fall-through chain, and it deliberately bottoms out in a no-op: ⌘W must
    // never close the window.
    'view.closeTab': () => {
      const id = $focusedStoredSessionId.get()

      // A tile goes through requestCloseSessionTile so a running or
      // input-blocked session still gets its confirmation.
      if (id && $sessionTiles.get().some(t => t.storedSessionId === id)) {
        requestCloseSessionTile(id)

        return
      }

      closeWorkspaceTab()
    },
    'view.reopenTab': reopenLastClosedTile,

    'appearance.toggleMode': () => setMode(resolvedMode === 'dark' ? 'light' : 'dark'),

    'profile.default': switchToDefaultProfile,
    ...profileSwitchHandlers,
    'profile.next': () => cycleProfile(1),
    'profile.prev': () => cycleProfile(-1),
    // Universal's rail has no inline create dialog — the Profiles overlay owns it.
    'profile.create': () => navigate(PROFILES_ROUTE)
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Capture mode: the next real key becomes the binding. Swallow everything
      // so e.g. ⌘K rebinds instead of opening the palette.
      const capturing = $capture.get()

      if (capturing) {
        event.preventDefault()
        event.stopPropagation()

        if (event.key === 'Escape') {
          endCapture()

          return
        }

        const combo = comboFromEvent(event)

        if (!combo) {
          return
        }

        setBinding(capturing, [combo])
        endCapture()

        return
      }

      // While the session switcher is up, Esc abandons it (stay put) before any
      // combo dispatch — ⌃Tab keeps stepping through the existing handler.
      if (switcherActive() && event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closeSwitcher()

        return
      }

      const combo = comboFromEvent(event)

      if (!combo) {
        return
      }

      const actionId = $comboIndex.get().get(combo)

      if (!actionId) {
        return
      }

      if (isEditableTarget(event.target) && !comboAllowedInInput(combo)) {
        return
      }

      // Built-in handlers first (they carry React context); contributed
      // actions bring their own `run` through the registry.
      const handler = handlersRef.current[actionId] ?? contributedKeybindHandler(actionId)

      if (!handler) {
        return
      }

      event.preventDefault()
      handler()
    }

    // Mac-app-switcher commit: lifting Ctrl with the overlay open lands on the
    // highlighted session. A window blur (Cmd+Tab away mid-switch) cancels so
    // the overlay never gets stranded waiting for a keyup that never comes.
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Tab') {
        onSwitcherTabUp()
      }

      if (event.key === 'Control') {
        commitSwitcherRef.current()
      }
    }

    const onBlur = () => switcherActive() && closeSwitcher()

    // Swallow trailing contextmenu after Ctrl+click commit (Electron main menu).
    const onContextMenu = (event: MouseEvent) => {
      if ($switcherOpen.get() || switcherJustClosed()) {
        event.preventDefault()
        event.stopPropagation()
      }
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })
    window.addEventListener('keyup', onKeyUp, { capture: true })
    window.addEventListener('blur', onBlur)
    window.addEventListener('contextmenu', onContextMenu, { capture: true })

    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true })
      window.removeEventListener('keyup', onKeyUp, { capture: true })
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('contextmenu', onContextMenu, { capture: true })
    }
  }, [])
}
