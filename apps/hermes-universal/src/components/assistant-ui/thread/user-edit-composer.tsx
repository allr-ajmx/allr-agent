import { ComposerPrimitive, useAui, useAuiState } from '@assistant-ui/react'
import {
  type ClipboardEvent,
  type FC,
  type FocusEvent,
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState
} from 'react'

import { focusComposerInput, markActiveComposer } from '@/app/chat/composer/focus'
import { composerPlainText, placeCaretEnd, renderComposerContents, RICH_INPUT_SLOT } from '@/app/chat/composer/rich-editor'
import {
  StickyHumanMessageContainer,
  StopGlyph,
  USER_ACTION_ICON_BUTTON_CLASS,
  USER_ACTION_ICON_SIZE,
  USER_BUBBLE_BASE_CLASS
} from '@/components/assistant-ui/thread/user-message'
import { Codicon } from '@/components/ui/codicon'
import { useI18n } from '@/i18n'
import { sanitizeComposerInput } from '@/lib/composer-input-sanitize'
import { cn } from '@/lib/utils'
import { notifyThreadEditClose } from '@/store/thread-scroll'

/**
 * Inline editor for a past user prompt: click a bubble, change the text, press
 * Enter (or the send button) to rewind to that turn and re-run it with the new
 * text — the runtime's `onEdit` routes to `submitEditedPrompt`. Esc cancels.
 *
 * Ported from desktop's user-edit-composer.tsx, minus the completion popover
 * (@-mention / slash), inline-ref drag-drop, and OS-drop upload staging:
 * FLAG(chat-port) — the desktop file's own text-editing core is what's here.
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
  const [submitting, setSubmitting] = useState(false)
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

  const rememberInitialDraft = useCallback(() => {
    if (initialDraftRef.current === null) {
      initialDraftRef.current = draftRef.current
    }
  }, [])

  // Paint the hydrated draft into the contenteditable (which React doesn't own)
  // whenever the runtime's text changes out from under it.
  useEffect(() => {
    draftRef.current = draft

    const editor = editorRef.current

    if (
      editor &&
      (editor.childNodes.length === 0 || (document.activeElement !== editor && composerPlainText(editor) !== draft))
    ) {
      renderComposerContents(editor, draft)

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

    rememberInitialDraft()
    syncDraftFromEditor(editor)
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

        if (editor && syncDraftFromEditor(editor) !== initialDraft) {
          return
        }

        aui.composer().cancel()
      }, 80)
    },
    [aui, submitting, syncDraftFromEditor]
  )

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
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

  return (
    <ComposerPrimitive.Root className="contents" data-slot="aui_edit-composer-root">
      <StickyHumanMessageContainer>
        <div
          className="composer-human-message-container human-execution-message-top relative flex w-full items-start rounded-md bg-(--ui-chat-surface-background)"
          onBlur={handleEditBlur}
          ref={rootRef}
        >
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
                'ui-prompt-input-editor__input resize-none whitespace-pre-wrap break-words [overflow-wrap:anywhere] pr-9 text-[length:var(--conversation-text-font-size)] text-foreground/95 outline-none',
                'empty:before:content-[attr(data-placeholder)] empty:before:text-muted-foreground/60',
                '**:data-ref-text:cursor-default',
                expanded ? 'min-h-16' : 'min-h-[1.25rem]'
              )}
              contentEditable
              data-placeholder={copy.editMessage}
              data-slot={RICH_INPUT_SLOT}
              onFocus={() => markActiveComposer('edit')}
              onInput={handleInput}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              ref={editorRef}
              role="textbox"
              spellCheck={false}
              suppressContentEditableWarning
            />
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
          <button
            aria-label={copy.sendEdited}
            className={cn('absolute right-2 bottom-2 size-5', USER_ACTION_ICON_BUTTON_CLASS)}
            disabled={!canSubmit || submitting}
            onClick={() => {
              const editor = editorRef.current

              if (editor) {
                submitEdit(editor)
              }
            }}
            title={copy.sendEdited}
            type="button"
          >
            {submitting ? StopGlyph : <Codicon name="arrow-up" size={USER_ACTION_ICON_SIZE} />}
          </button>
        </div>
      </StickyHumanMessageContainer>
    </ComposerPrimitive.Root>
  )
}
