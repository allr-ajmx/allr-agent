import type { Unstable_TriggerItem } from '@assistant-ui/core'
import { ComposerPrimitive, useAui, useAuiState } from '@assistant-ui/react'
import {
  type ClipboardEvent,
  type CompositionEvent,
  type FC,
  type FocusEvent,
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState
} from 'react'

import { swallowsTriggerTab } from '@/app/chat/composer/composer-utils'
import { ComposerDirectiveActions } from '@/app/chat/composer/directive-actions'
import { focusComposerInput, markActiveComposer } from '@/app/chat/composer/focus'
import { useComposerTrigger } from '@/app/chat/composer/hooks/use-composer-trigger'
import { useEmojiCompletions } from '@/app/chat/composer/hooks/use-emoji-completions'
import {
  composerPlainText,
  placeCaretEnd,
  renderComposerContents,
  RICH_INPUT_SLOT
} from '@/app/chat/composer/rich-editor'
import { ComposerTriggerPopover } from '@/app/chat/composer/trigger-popover'
import {
  StickyHumanMessageContainer,
  StopGlyph,
  USER_ACTION_ICON_BUTTON_CLASS,
  USER_ACTION_ICON_SIZE,
  USER_BUBBLE_BASE_CLASS
} from '@/components/assistant-ui/thread/user-message'
import { Codicon } from '@/components/ui/codicon'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { sanitizeComposerInput } from '@/lib/composer-input-sanitize'
import { cn } from '@/lib/utils'
import { notifyThreadEditClose } from '@/store/thread-scroll'

/** Below this much room above the editor, the completion list is drawn under it
 *  instead — the drawer caps at 22rem and would otherwise run off the top. */
const DRAWER_MIN_SPACE_ABOVE_PX = 220

/**
 * Inline editor for a past user prompt: click a bubble, change the text, press
 * Enter (or the send button) to rewind to that turn and re-run it with the new
 * text — the runtime's `onEdit` routes to `submitEditedPrompt`. Esc cancels.
 *
 * Ported from desktop's user-edit-composer.tsx, minus the `@`-mention / slash
 * completions, inline-ref drag-drop, and OS-drop upload staging: FLAG(chat-port)
 * — the desktop file's own text-editing core is what's here.
 *
 * `:shortcode:` emoji completions ARE wired, through the same
 * `useComposerTrigger` engine the docked composer runs on: an emoji is plain
 * text with no backend to resolve it, so it needs no gateway, session or cwd —
 * which is exactly what the `@` and `/` sources this mount lacks would need.
 * Only the `:` kind is honoured here (see `emojiTrigger`); a `/` typed into a
 * sent message is prose, and an adapter-less popover would dead-end on
 * "No matches".
 */
export const UserEditComposer: FC = () => {
  const { t } = useI18n()
  const copy = t.assistant.thread
  const aui = useAui()
  const draft = useAuiState(s => s.composer.text)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<HTMLDivElement | null>(null)
  // Capture the original draft immediately before the first edit. The runtime
  // may hydrate composer.text after this component's first render, so taking a
  // mount-time snapshot can incorrectly classify every later blur as dirty.
  const initialDraftRef = useRef<string | null>(null)
  const draftRef = useRef(draft)
  // True while an IME preedit is open (CJK input). Same latch the docked
  // composer keeps, and for the same two reasons: Enter must confirm rather than
  // submit, and the input events fired DURING composition carry uncommitted
  // preedit text that must not reach the draft.
  const composingRef = useRef(false)
  const [submitting, setSubmitting] = useState(false)
  const [triggerPlacement, setTriggerPlacement] = useState<'bottom' | 'top'>('top')
  const expanded = draft.includes('\n')
  const canSubmit = draft.trim().length > 0

  useEffect(() => () => notifyThreadEditClose(), [])

  const focusEditor = useCallback(() => {
    const editor = editorRef.current

    focusComposerInput(editor)

    if (editor) {
      placeCaretEnd(editor)
    }

    markActiveComposer('edit')
  }, [])

  /**
   * Focus WITHOUT moving the caret — what a completion pick needs.
   *
   * `focusEditor` drops the caret at the end, which is right on mount (a message
   * opened for edit starts with the caret after its last character) and wrong
   * after a pick: the insertion already left the caret behind the emoji, and a
   * shortcode typed mid-message would otherwise teleport the cursor past the
   * prose that follows it. The docked composer's equivalent only bumps a focus
   * request; it never touches the selection.
   */
  const refocusEditor = useCallback(() => {
    focusComposerInput(editorRef.current)
    markActiveComposer('edit')
  }, [])

  const rememberInitialDraft = useCallback(() => {
    if (initialDraftRef.current === null) {
      initialDraftRef.current = draftRef.current
    }
  }, [])

  const emoji = useEmojiCompletions()

  const setComposerText = useCallback(
    (text: string) => {
      draftRef.current = text
      aui.composer().setText(text)
    },
    [aui]
  )

  const {
    closeTrigger,
    refreshTrigger: detectTriggerNow,
    replaceTriggerWithChip,
    setTriggerActive,
    trigger,
    triggerActive,
    triggerItems,
    triggerKeyConsumedRef,
    triggerLoading
  } = useComposerTrigger({
    // No gateway/session/cwd on this mount, so no `@` or `/` source to give it.
    at: { adapter: null, loading: false },
    composingRef,
    draftRef,
    editorRef,
    emoji,
    requestMainFocus: refocusEditor,
    setComposerText,
    slash: { adapter: null, loading: false }
  })

  // The engine detects every kind; this mount only SERVES `:`. Everything below
  // reads this rather than `trigger`, so an `@` or `/` typed into a sent message
  // stays inert text instead of opening a popover with no source behind it.
  const emojiTrigger = trigger?.kind === ':' ? trigger : null

  // A message opened for edit sits anywhere in the transcript, including hard
  // against the top of the viewport where a list drawn above it would be
  // off-screen. The docked composer never has that problem (it is pinned to the
  // bottom), which is why only this mount measures. Measured on refresh rather
  // than during render so the layout read stays out of React's render pass.
  const refreshTrigger = useCallback(() => {
    const editor = editorRef.current

    if (editor) {
      const rect = editor.getBoundingClientRect()
      const spaceAbove = rect.top
      const spaceBelow = window.innerHeight - rect.bottom

      setTriggerPlacement(spaceAbove < DRAWER_MIN_SPACE_ABOVE_PX && spaceBelow > spaceAbove ? 'bottom' : 'top')
    }

    detectTriggerNow()
  }, [detectTriggerNow])

  // Picking must count as an edit: blur cancels this composer when the draft
  // still matches its pre-edit baseline, and an emoji inserted without banking
  // that baseline would be thrown away by the next click outside.
  const pickCompletion = useCallback(
    (item: Unstable_TriggerItem) => {
      rememberInitialDraft()
      replaceTriggerWithChip(item)
    },
    [rememberInitialDraft, replaceTriggerWithChip]
  )

  // Paint the hydrated draft into the contenteditable (which React doesn't own)
  // whenever the runtime's text changes out from under it.
  useEffect(() => {
    draftRef.current = draft

    const editor = editorRef.current

    if (
      editor &&
      (editor.childNodes.length === 0 || (document.activeElement !== editor && composerPlainText(editor) !== draft))
    ) {
      // Inert by construction — this repaints on mount or when the editor
      // isn't the one being typed into. A message opened for edit is finished
      // text, so a `/command` ending it is committed and chips, matching how
      // the transcript rendered that same message a moment ago.
      renderComposerContents(editor, draft, { trailingCommitted: true })

      if (document.activeElement === editor) {
        placeCaretEnd(editor)
      }
    }
  }, [draft])

  useEffect(() => {
    focusEditor()
  }, [focusEditor])

  const syncDraftFromEditor = useCallback(
    (editor: HTMLDivElement) => {
      const nextDraft = sanitizeComposerInput(composerPlainText(editor))

      if (nextDraft !== draftRef.current) {
        draftRef.current = nextDraft
        aui.composer().setText(nextDraft)
      }

      return nextDraft
    },
    [aui]
  )

  const handleInput = (event: FormEvent<HTMLDivElement>) => {
    const editor = event.currentTarget

    if (editor.childNodes.length === 1 && editor.firstChild?.nodeName === 'BR') {
      editor.replaceChildren()
    }

    // Mid-composition input carries the preedit, not text the user has
    // committed. `compositionend` flushes what they actually typed.
    if (composingRef.current) {
      return
    }

    rememberInitialDraft()
    syncDraftFromEditor(editor)
  }

  const handleCompositionStart = () => {
    composingRef.current = true
  }

  // Chromium does not reliably emit a trailing `input` after `compositionend`,
  // so the committed text is read from the DOM here — otherwise a message edited
  // purely in an IME would send with the pre-composition text.
  const handleCompositionEnd = (event: CompositionEvent<HTMLDivElement>) => {
    composingRef.current = false
    rememberInitialDraft()
    syncDraftFromEditor(event.currentTarget)
    // Now — and only now — the editor holds committed text, so this is where a
    // `:` typed through the IME is allowed to open the menu.
    window.setTimeout(refreshTrigger, 0)
  }

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const pastedText = sanitizeComposerInput(event.clipboardData.getData('text'))

    event.preventDefault()

    if (!pastedText) {
      return
    }

    rememberInitialDraft()
    document.execCommand('insertText', false, pastedText)
    syncDraftFromEditor(event.currentTarget)
    window.setTimeout(refreshTrigger, 0)
  }

  const submitEdit = (editor: HTMLDivElement) => {
    const nextDraft = syncDraftFromEditor(editor)

    if (submitting || !nextDraft.trim()) {
      return
    }

    setSubmitting(true)
    aui.composer().send()
  }

  const handleEditBlur = useCallback(
    (event: FocusEvent<HTMLDivElement>) => {
      const nextTarget = event.relatedTarget

      if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
        return
      }

      window.setTimeout(() => {
        const root = rootRef.current
        const active = document.activeElement

        if (submitting || (root && active && root.contains(active))) {
          return
        }

        const editor = editorRef.current

        // Dirty edit guard: when the user actually typed something, blur must
        // not cancel the composer — that would discard their in-flight edits.
        // Compare against the draft captured immediately before the first edit;
        // when no edit event occurred, the current hydrated draft is the clean
        // baseline.
        const initialDraft = initialDraftRef.current ?? draftRef.current

        // Focus has genuinely left this composer, so an open menu is stale
        // either way — close it before the dirty-edit guard returns.
        closeTrigger()

        if (editor && syncDraftFromEditor(editor) !== initialDraft) {
          return
        }

        aui.composer().cancel()
      }, 80)
    },
    [aui, closeTrigger, submitting, syncDraftFromEditor]
  )

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // IME composition: Enter CONFIRMS the preedit, it does not send. Without
    // this the first Enter a Japanese/Korean/Chinese typist presses re-runs the
    // turn with half-composed text in it — and this composer's Enter is
    // destructive (it rewinds the conversation to that message), so there is no
    // undo for it. The docked composer has carried the same guard since the
    // port; the edit composer was ported without it.
    //
    // `composingRef` over `nativeEvent.isComposing` alone for the same reason it
    // is there: WebKitGTK (which IS universal's desktop webview) does not set
    // the flag as reliably as Chromium, and compositionstart/end are what the
    // engines agree on.
    if (composingRef.current || event.nativeEvent.isComposing) {
      return
    }

    // The menu is up but its items are still in flight — the emoji index loads
    // on the first `:` of the session, so this window is real. Tab must not fall
    // through: focus leaving THIS composer blurs it, and a blur with the draft
    // still matching its baseline cancels the edit outright.
    if (
      swallowsTriggerTab({
        itemCount: triggerItems.length,
        key: event.key,
        loading: triggerLoading,
        open: Boolean(emojiTrigger)
      })
    ) {
      event.preventDefault()
      triggerKeyConsumedRef.current = true

      return
    }

    // Completion navigation, ahead of Escape and Enter — both of those mean
    // something else entirely while the menu is up, and Enter here is
    // destructive.
    if (emojiTrigger && triggerItems.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        triggerKeyConsumedRef.current = true
        setTriggerActive(idx => (idx + 1) % triggerItems.length)

        return
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault()
        triggerKeyConsumedRef.current = true
        setTriggerActive(idx => (idx - 1 + triggerItems.length) % triggerItems.length)

        return
      }

      // Enter and Tab accept, exactly as the docked composer does. There is no
      // Space acceptance and no folder descent: those are `/` and `@` shapes,
      // and an emoji shortcode can legitimately be followed by a space.
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        triggerKeyConsumedRef.current = true

        const item = triggerItems[triggerActive]

        if (item) {
          pickCompletion(item)
        }

        return
      }
    }

    // Escape dismisses the menu whenever it is up — including the empty and
    // loading states, which is a deliberate divergence from the docked composer
    // (it only handles Escape with items present). There, a fall-through Escape
    // interrupts the turn, which is recoverable; here it discards the edit, and
    // losing a message because a completion list happened to be empty is not.
    if (emojiTrigger && event.key === 'Escape') {
      event.preventDefault()
      triggerKeyConsumedRef.current = true
      closeTrigger()

      return
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      aui.composer().cancel()

      return
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submitEdit(event.currentTarget)
    }
  }

  const handleKeyUp = () => {
    // Keys the open menu already consumed in keydown (Arrow/Enter/Tab/Escape)
    // never edit text, and for Escape the menu is already closed — a refresh
    // here would re-detect the still-present `:` and reopen it instantly.
    if (triggerKeyConsumedRef.current) {
      triggerKeyConsumedRef.current = false

      return
    }

    window.setTimeout(refreshTrigger, 0)
  }

  return (
    <ComposerPrimitive.Root className="contents" data-slot="aui_edit-composer-root">
      <StickyHumanMessageContainer>
        <div
          className="composer-human-message-container human-execution-message-top relative flex w-full items-start rounded-md bg-(--ui-chat-surface-background)"
          onBlur={handleEditBlur}
          ref={rootRef}
        >
          {emojiTrigger && (
            <ComposerTriggerPopover
              activeIndex={triggerActive}
              items={triggerItems}
              kind={emojiTrigger.kind}
              loading={triggerLoading}
              onHover={setTriggerActive}
              onPick={pickCompletion}
              placement={triggerPlacement}
            />
          )}
          <div
            className={cn(
              USER_BUBBLE_BASE_CLASS,
              // The bubble owns the height cap AND the scroll — the editor inside
              // grows freely. `overflow-x-hidden` is load-bearing: `overflow-y`
              // alone would compute overflow-x to `auto` and hand us a stray
              // horizontal scrollbar.
              'ui-prompt-input__container relative max-h-48 w-full overflow-x-hidden overflow-y-auto border-(--ui-stroke-secondary) data-[expanded=true]:min-h-20'
            )}
            data-expanded={expanded ? 'true' : undefined}
          >
            <div
              aria-label={copy.editMessage}
              autoCapitalize="off"
              autoCorrect="off"
              className={cn(
                // Padding comes from the bubble (px-3 py-2); only the send-button
                // clearance (pr-9, same as the read-only bubble) lives here, so the
                // text sits at the same x in both modes. Wrap rules match the
                // docked composer input so long URLs/paths can't force x-overflow.
                'ui-prompt-input-editor__input resize-none whitespace-pre-wrap break-words [overflow-wrap:anywhere] pe-9 text-[length:var(--conversation-text-font-size)] text-foreground/95 outline-none',
                'empty:before:content-[attr(data-placeholder)] empty:before:text-muted-foreground/60',
                '**:data-ref-text:cursor-default',
                expanded ? 'min-h-16' : 'min-h-[1.25rem]'
              )}
              contentEditable
              data-placeholder={copy.editMessage}
              data-slot={RICH_INPUT_SLOT}
              onCompositionEnd={handleCompositionEnd}
              onCompositionStart={handleCompositionStart}
              onFocus={() => markActiveComposer('edit')}
              onInput={handleInput}
              onKeyDown={handleKeyDown}
              onKeyUp={handleKeyUp}
              onMouseUp={refreshTrigger}
              onPaste={handlePaste}
              ref={editorRef}
              role="textbox"
              spellCheck={false}
              suppressContentEditableWarning
            />
            <ComposerDirectiveActions editorRef={editorRef} />
            {/* The runtime's own composer input stays mounted (screen-reader
                only) so ComposerPrimitive owns submit/cancel state while the
                contenteditable above is what the user actually types into. */}
            <ComposerPrimitive.Input
              asChild
              className="sr-only bg-amber-500"
              submitMode="ctrlEnter"
              tabIndex={-1}
              unstable_focusOnScrollToBottom={false}
            >
              <textarea
                aria-hidden
                autoCapitalize="off"
                autoComplete="off"
                autoCorrect="off"
                className="sr-only bg-green-500"
                spellCheck={false}
                tabIndex={-1}
              />
            </ComposerPrimitive.Input>
          </div>
          <Tip label={copy.sendEdited}>
            <button
              aria-label={copy.sendEdited}
              className={cn('absolute end-2 bottom-2 size-5', USER_ACTION_ICON_BUTTON_CLASS)}
              disabled={!canSubmit || submitting}
              onClick={() => {
                const editor = editorRef.current

                if (editor) {
                  submitEdit(editor)
                }
              }}
              type="button"
            >
              {submitting ? StopGlyph : <Codicon name="arrow-up" size={USER_ACTION_ICON_SIZE} />}
            </button>
          </Tip>
        </div>
      </StickyHumanMessageContainer>
    </ComposerPrimitive.Root>
  )
}
