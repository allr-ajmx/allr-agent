import { useAui, useAuiState, useComposerRuntime } from '@assistant-ui/react'
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react'

import { SLASH_COMMAND_RE } from '@/lib/chat-runtime'
import { onComposerDraftSyncRequest } from '@/lib/composer-draft-bus'
import { IS_MOBILE } from '@/lib/platform'
import { type ComposerAttachment, stashSessionDraft, takeSessionDraft } from '@/store/composer'
import { isBrowsingHistory } from '@/store/composer-input-history'

import {
  cloneAttachments,
  DRAFT_PERSIST_DEBOUNCE_MS,
  isPendingDraftPersistCurrent,
  type QueueEditState
} from '../composer-utils'
import {
  type ComposerInsertMode,
  focusComposerInput,
  focusHeldByOtherEditor,
  getActiveComposer,
  onComposerFocusRequest,
  onComposerInsertRefsRequest,
  onComposerInsertRequest
} from '../focus'
import { type InlineRefInput, insertInlineRefsIntoEditor } from '../inline-refs'
import { composerPlainText, placeCaretEnd, renderComposerContents } from '../rich-editor'
import { useComposerScope } from '../scope'
import type { ChatBarProps } from '../types'

interface UseComposerDraftArgs {
  activeQueueSessionKey: string | null
  focusKey: ChatBarProps['focusKey']
  inputDisabled: boolean
  queueEditRef: RefObject<QueueEditState | null>
  sessionId: string | null | undefined
}

/**
 * The composer's draft engine — the detached source-of-truth spine. The live
 * text lives in the contentEditable DOM + `draftRef`; React only sees coarse
 * edge selectors, so typing never re-renders the chrome. Owns the imperative
 * composer-runtime subscription (draftRef mirror + external repaint + debounced
 * per-session stash), the edit primitives (append/insert/inline-refs), focus,
 * and per-session load/clear/stash/restore. The contentEditable *event*
 * handlers stay in ChatBar (they bridge into the trigger engine) and drive the
 * primitives exposed here.
 */
export function useComposerDraft({
  activeQueueSessionKey,
  focusKey,
  inputDisabled,
  queueEditRef,
  sessionId
}: UseComposerDraftArgs) {
  const aui = useAui()
  const composerRuntime = useComposerRuntime()
  // Which composer this is on the focus bus + which attachment set it owns.
  const { attachments: attachmentScope, target } = useComposerScope()

  // Coarse edges only — these flip rarely (empty↔non-empty, the `?` help sigil,
  // steerable-vs-slash), so typing within a line costs no render.
  const hasText = useAuiState(s => s.composer.text.trim().length > 0)
  const isHelpHint = useAuiState(s => s.composer.text === '?')

  const isSteerableText = useAuiState(s => {
    const trimmed = s.composer.text.trim()

    return trimmed.length > 0 && !SLASH_COMMAND_RE.test(trimmed)
  })

  // assistant-ui's composer mutators throw when the core isn't bound yet (a
  // startup/thread-swap window); the DOM + draftRef hold the text and the
  // subscription reconciles once it binds, so swallow the premature write.
  const setComposerText = useCallback(
    (value: string) => {
      try {
        aui.composer().setText(value)
      } catch {
        // Composer core not bound yet — DOM/draftRef carry the text.
      }
    },
    [aui]
  )

  const editorRef = useRef<HTMLDivElement | null>(null)
  const draftRef = useRef('')
  const pendingDraftPersistRef = useRef<{ scope: string | null; text: string } | null>(null)
  const draftPersistTimerRef = useRef<number | undefined>(undefined)
  const activeQueueSessionKeyRef = useRef(activeQueueSessionKey)
  activeQueueSessionKeyRef.current = activeQueueSessionKey
  // Owned only by the swap effect below — unlike activeQueueSessionKeyRef this
  // does NOT update on every render, so it always reflects the session whose
  // text is actually loaded in the editor. Async work (debounce timers,
  // pagehide flush) must persist against this, not the render-time ref, or a
  // session switch mid-flight files one session's draft under another's key
  // (#54527).
  const draftScopeRef = useRef(activeQueueSessionKey)
  const sessionIdRef = useRef(sessionId)
  sessionIdRef.current = sessionId
  const queueEditStateRef = useRef<QueueEditState | null>(queueEditRef.current)
  queueEditStateRef.current = queueEditRef.current

  const [focusRequestId, setFocusRequestId] = useState(0)

  // Focus only. Marking the active composer is NOT this function's job: a real
  // focus fires `onFocus` on the input, which marks — while a mount-time call
  // marking would hand every keystroke to whichever tile resumed last.
  const focusInput = useCallback(() => {
    focusComposerInput(editorRef.current)
  }, [])

  const requestMainFocus = useCallback(() => {
    setFocusRequestId(id => id + 1)
  }, [])

  // The single write path for programmatic draft mutations: mirror → AUI state →
  // repaint the editor (caret to end). Repaints even while focused — inserts /
  // restores run mid-focus, and the runtime sync only repaints an unfocused
  // editor — so the visible text never lags the store.
  const paintDraft = useCallback(
    (next: string, focus = true) => {
      draftRef.current = next
      setComposerText(next)

      const editor = editorRef.current

      if (editor) {
        // Inert by construction: this paints text the user is not mid-typing —
        // a restore, an insert, a programmatic clear. A `/command` ending it is
        // therefore FINISHED, so it commits to a chip rather than staying an
        // editable trailing token the next keystroke would extend.
        renderComposerContents(editor, next, { trailingCommitted: true })

        // `placeCaretEnd` writes the DOCUMENT selection, and putting the
        // selection inside a contenteditable IS a focus in WebKit — it focuses
        // the editable root, which on a phone raises the soft keyboard. A draft
        // RESTORE paints with `focus: false` precisely because it must not take
        // the caret, so on mobile the keyboard came up on every bubble switch
        // even with the autofocus effect gated off. Place it there only when
        // this editor is the one holding the caret anyway: about to be focused,
        // or already focused.
        //
        // Desktop keeps the unconditional call. There is no keyboard to raise,
        // and the caret landing at the end of a restored draft is what its focus
        // paths (⌘L, the focus bus) have always relied on.
        if (!IS_MOBILE || focus || document.activeElement === editor) {
          placeCaretEnd(editor)
        }
      }

      if (focus) {
        requestMainFocus()
      }
    },
    [requestMainFocus, setComposerText]
  )

  const appendExternalText = useCallback(
    (text: string, mode: ComposerInsertMode) => {
      const value = text.trim()

      if (!value) {
        return
      }

      const base = mode === 'inline' ? draftRef.current.trimEnd() : draftRef.current
      const sep = mode === 'inline' ? (base ? ' ' : '') : base && !base.endsWith('\n') ? '\n\n' : ''

      paintDraft(`${base}${sep}${value}`)
    },
    [paintDraft]
  )

  // Autofocus on mount and on a session swap.
  useEffect(() => {
    if (inputDisabled) {
      return
    }

    // Not on a phone. On desktop the caret is free and following the focused
    // tile with it is the whole point; on a phone it costs the soft keyboard,
    // half the screen and a layout shift — for a SWITCH. The mobile bubble rail
    // changes `focusKey` on every tap, so navigating the parallel chats meant
    // the keyboard opening each time whether or not the user meant to type.
    // An explicit request over the focus bus (below) still focuses on mobile:
    // that is someone asking for the caret, not a composer announcing arrival.
    if (IS_MOBILE) {
      return
    }

    // Only the FOCUSED chat's composer may claim the caret on arrival. Tiles
    // arrive on their own schedule — `openSessionTile` saves one with no runtime
    // id, so its composer mounts once the async resume lands, long after the ⌘T
    // that created the tab (MJXHRM-6) — and with several tiles open the last one
    // home would otherwise win every keystroke. The focused zone already names
    // the chat the user is in, and it names it BEFORE the mount (`focusDraftTile`
    // claims the zone as the tab is created), so a fresh tab still autofocuses.
    if (target !== getActiveComposer()) {
      return
    }

    // Same target, but an editor the user is already in (the edit composer
    // inside this chat) holds the caret: arriving is not a reason to take it.
    if (focusHeldByOtherEditor(editorRef.current)) {
      return
    }

    focusInput()
  }, [focusInput, focusKey, inputDisabled, target])

  // An explicit request over the focus bus is unconditional — it is someone
  // saying "put the caret here", not a component announcing its arrival.
  useEffect(() => {
    if (!inputDisabled && focusRequestId > 0) {
      focusInput()
    }
  }, [focusInput, focusRequestId, inputDisabled])

  useEffect(() => {
    if (inputDisabled) {
      return undefined
    }

    const offFocus = onComposerFocusRequest(({ target: requested, typeChar }) => {
      if (requested !== target) {
        return
      }

      // Type-to-focus appends at end; bare Enter just focuses.
      if (typeChar) {
        paintDraft(`${draftRef.current}${typeChar}`, true)

        return
      }

      setFocusRequestId(id => id + 1)
    })

    const offInsert = onComposerInsertRequest(({ mode, target: requested, text }) => {
      if (requested === target) {
        appendExternalText(text, mode)
      }
    })

    return () => {
      offFocus()
      offInsert()
    }
  }, [appendExternalText, inputDisabled, paintDraft, target])

  const stashAt = (scope: string | null, text = draftRef.current, attachments = attachmentScope.$attachments.get()) =>
    stashSessionDraft(scope, text, attachments)

  const loadIntoComposer = (text: string, attachments: ComposerAttachment[]) => {
    attachmentScope.$attachments.set(cloneAttachments(attachments))
    paintDraft(text, false)
  }

  const clearDraft = useCallback(() => {
    setComposerText('')
    draftRef.current = ''

    if (editorRef.current) {
      editorRef.current.replaceChildren()
    }
  }, [setComposerText])

  // Read the editor's current plain text into draftRef + composer state. This
  // closes the "queued rAF flush hasn't run yet" window so scope-swap/pagehide
  // persistence captures the latest keystrokes.
  const syncDraftFromEditor = useCallback(() => {
    const editor = editorRef.current

    if (!editor) {
      return draftRef.current
    }

    const text = composerPlainText(editor)

    if (text !== draftRef.current) {
      draftRef.current = text
      setComposerText(text)
    }

    return text
  }, [setComposerText])

  // Imperative draft sync — the spine of the "work only when work is to be
  // performed" model. Subscribing to the composer runtime directly (not
  // `useAuiState(text)` + a `[draft]` effect) keeps per-keystroke text out of
  // React, so typing never re-renders the chrome. On each change we (1) mirror
  // text into draftRef, (2) repaint the editor only when the change came from
  // OUTSIDE it (programmatic clear/restore/insert; the focused editor is the
  // source otherwise), and (3) schedule the debounced per-session stash.
  // Browsing history / editing a queued prompt suppress the stash so recalled
  // text never clobbers the draft.
  useEffect(() => {
    const sync = () => {
      const text = composerRuntime.getState().text
      draftRef.current = text

      const editor = editorRef.current

      if (editor && document.activeElement !== editor && composerPlainText(editor) !== text) {
        // The editor is NOT the one being typed into (that is the guard right
        // above), so this text is finished and its trailing `/command` chips.
        renderComposerContents(editor, text, { trailingCommitted: true })
      }

      if (isBrowsingHistory(sessionIdRef.current) || queueEditRef.current) {
        return
      }

      const scope = draftScopeRef.current
      const entry = { scope, text }
      pendingDraftPersistRef.current = entry
      window.clearTimeout(draftPersistTimerRef.current)
      draftPersistTimerRef.current = window.setTimeout(() => {
        // Integrity guard (defense-in-depth, #54527): only commit if this is
        // still the pending write on file. A session swap or a newer
        // keystroke clears/replaces it before firing in the normal case; this
        // catches any future call site that skips that bookkeeping instead of
        // silently filing text under the wrong session.
        if (!isPendingDraftPersistCurrent(pendingDraftPersistRef.current, entry)) {
          return
        }

        pendingDraftPersistRef.current = null
        stashAt(scope, text)
      }, DRAFT_PERSIST_DEBOUNCE_MS)
    }

    const unsubscribe = composerRuntime.subscribe(sync)

    return () => {
      unsubscribe()
      window.clearTimeout(draftPersistTimerRef.current)
    }
    // `stashAt` is deliberately omitted: it is redeclared every render but reads
    // everything through refs and the scope context, so its behaviour never
    // changes — while depending on it would resubscribe the composer runtime on
    // every keystroke and cancel the pending draft write each time.
  }, [composerRuntime, queueEditRef]) // eslint-disable-line react-hooks/exhaustive-deps

  const insertText = (text: string) => {
    const base = draftRef.current
    const sep = base && !base.endsWith('\n') ? '\n' : ''

    paintDraft(`${base}${sep}${text}`)
  }

  // insertInlineRefs mutates the editor in place (chips), so it can't go through
  // paintDraft's re-render — it mirrors the resulting plain text and refocuses.
  const insertInlineRefs = (refs: InlineRefInput[]) => {
    const editor = editorRef.current

    if (!editor) {
      return false
    }

    const nextDraft = insertInlineRefsIntoEditor(editor, refs)

    if (nextDraft === null) {
      return false
    }

    draftRef.current = nextDraft
    setComposerText(nextDraft)
    requestMainFocus()

    return true
  }

  // Latest-closure ref so the once-only subscription always calls the current
  // insertInlineRefs without re-subscribing every render.
  const insertInlineRefsRef = useRef(insertInlineRefs)
  insertInlineRefsRef.current = insertInlineRefs

  useEffect(() => {
    return onComposerInsertRefsRequest(({ refs, target: requested }) => {
      if (requested === target) {
        insertInlineRefsRef.current(refs)
      }
    })
  }, [target])

  // Per-thread draft swap — the composer's only session coupling. Lifecycle
  // never clears composer state; this effect alone stashes on leave, restores
  // on enter. Keyed writes are idempotent, so no skip-sentinel.
  useEffect(() => {
    // A pending debounce timer from the outgoing session is now stale — its
    // scope was correct when scheduled, but the authoritative stash below
    // (and the cleanup on the way out) already covers that text. Letting it
    // fire later would just clobber with an older snapshot.
    window.clearTimeout(draftPersistTimerRef.current)
    pendingDraftPersistRef.current = null
    draftScopeRef.current = activeQueueSessionKey

    const { attachments, text } = takeSessionDraft(activeQueueSessionKey)
    loadIntoComposer(text, attachments)

    return () => {
      const latestText = syncDraftFromEditor()
      const editing = queueEditStateRef.current

      if (editing?.sessionKey === activeQueueSessionKey) {
        stashAt(activeQueueSessionKey, editing.draft, editing.attachments)
      } else if (!isBrowsingHistory(sessionId)) {
        stashAt(activeQueueSessionKey, latestText)
      }
    }
    // `sessionId` is deliberately the STALE (outgoing) one — do NOT "fix" this
    // to `sessionIdRef.current` for consistency with the rest of the file. This
    // cleanup persists the draft of the session being LEFT, under the outgoing
    // `activeQueueSessionKey`, so the browse guard has to ask about that same
    // session; the ref holds the incoming one by the time cleanup runs.
    // `loadIntoComposer` / `stashAt` are redeclared every render (they read
    // through live refs), so listing them would make a session-swap effect fire
    // per keystroke — stashing and reloading the composer mid-typing.
  }, [activeQueueSessionKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // A draft moving BETWEEN WINDOWS (MJXHRM-213). The HUD and the main window are
  // separate webviews sharing one `localStorage` draft stash, so a handoff is two
  // moments: flush what is in this editor before the other window reads it, and
  // repaint from the stash after the other window has written.
  //
  // The focus guard on `reload` is the load-bearing half: repainting an editor
  // someone is typing in would drop their keystrokes and move their caret, and
  // "the window you are looking at wins" is the only rule that cannot surprise
  // anyone.
  useEffect(() => {
    return onComposerDraftSyncRequest(mode => {
      const scope = draftScopeRef.current

      if (isBrowsingHistory(sessionIdRef.current) || queueEditStateRef.current?.sessionKey === scope) {
        return
      }

      if (mode === 'flush') {
        pendingDraftPersistRef.current = null
        stashAt(scope, syncDraftFromEditor())

        return
      }

      const editor = editorRef.current

      if (editor && document.activeElement === editor) {
        return
      }

      const { attachments, text } = takeSessionDraft(scope)

      if (text !== draftRef.current) {
        loadIntoComposer(text, attachments)
      }
    })
    // `stashAt` / `loadIntoComposer` are recreated every render (they close over
    // live refs by design), so listing them would resubscribe on every keystroke.
  }, [syncDraftFromEditor]) // eslint-disable-line react-hooks/exhaustive-deps

  // pagehide is load-bearing: React skips effect cleanups on reload, so Cmd+R
  // inside the debounce/rAF window would drop trailing keystrokes without this.
  useEffect(() => {
    const flushPendingDraftPersist = () => {
      const scope = draftScopeRef.current
      const editing = queueEditStateRef.current

      if (editing?.sessionKey === scope || isBrowsingHistory(sessionIdRef.current)) {
        return
      }

      const latestText = syncDraftFromEditor()
      pendingDraftPersistRef.current = null
      stashAt(scope, latestText)
    }

    window.addEventListener('pagehide', flushPendingDraftPersist)

    return () => {
      window.removeEventListener('pagehide', flushPendingDraftPersist)
      flushPendingDraftPersist()
    }
    // `stashAt` is deliberately omitted, as above — and it matters more here,
    // because this cleanup PERSISTS the draft. Re-running the effect on every
    // render would stash on every keystroke rather than on the way out.
  }, [syncDraftFromEditor]) // eslint-disable-line react-hooks/exhaustive-deps

  return {
    activeQueueSessionKeyRef,
    clearDraft,
    draftRef,
    editorRef,
    focusInput,
    hasText,
    insertInlineRefs,
    insertText,
    isHelpHint,
    isSteerableText,
    loadIntoComposer,
    requestMainFocus,
    sessionIdRef,
    setComposerText,
    stashAt,
    syncDraftFromEditor
  }
}
