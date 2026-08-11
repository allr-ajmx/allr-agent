'use client'

import { type ToolCallMessagePartProps, useAuiState } from '@assistant-ui/react'
import { useStore } from '@nanostores/react'
import {
  type ComponentProps,
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'

import { requestComposerFocus, requestComposerInsert } from '@/app/chat/composer/focus'
import { useSessionView } from '@/app/chat/session-view'
import { ToolFallback } from '@/components/assistant-ui/tool/fallback'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { Textarea } from '@/components/ui/textarea'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import { CircleLetterA, Loader2, MessageQuestion } from '@/lib/icons'
import { keyOwningClarifyCard } from '@/lib/keybinds/composer-focus-keys'
import { cn } from '@/lib/utils'
import { respondClarify } from '@/store/chat'
import { normalizeChoices, readChoices } from '@/store/clarify'
import { notify, notifyError } from '@/store/notifications'
import { sessionClarifyRequest } from '@/store/prompts'

import { selectMessageRunning } from './tool/fallback-model'
import { parseMaybeObject } from './tool/fallback-model/format'

// Ported from apps/desktop/src/components/assistant-ui/clarify-tool.tsx.
//
// This inline panel is the ONLY interactive clarify surface (same as desktop —
// there is no footer bar). Question and choices come from the `clarify.request`
// gateway event parked in `$clarify`, because `tool.start` carries no args; the
// tool args are only a fallback (they land with `tool.complete`). The request is
// read per SESSION KEY, so a tile's clarify answers the tile's agent — and so it
// survives the runtime-id rotation a cold resume performs (store/prompts.ts).

interface ClarifyArgs {
  question?: string
  choices?: string[] | null
}

interface ClarifyResult {
  question?: string
  answer?: string
  error?: string
}

function stringField(row: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = row[key]

    if (typeof value === 'string') {
      return value
    }
  }
}

function readClarifyArgs(args: unknown): ClarifyArgs {
  const row = parseMaybeObject(args)
  const question = stringField(row, 'question')

  // The same hygiene the gateway path gets (store/clarify.ts): choices come
  // from a model's tool call, so a blank / multi-line / over-long entry is a
  // rendering bug waiting to happen rather than an option worth offering.
  return { question, choices: readChoices('tool_args', question ?? '', row.choices) }
}

/** Parse clarify tool JSON (`question` + `user_response`). */
export function readClarifyResult(result: unknown): ClarifyResult {
  const row = parseMaybeObject(result)

  if (Object.keys(row).length === 0) {
    return typeof result === 'string' && result.trim() ? { answer: result.trim() } : {}
  }

  return {
    question: stringField(row, 'question'),
    answer: stringField(row, 'user_response', 'answer'),
    error: stringField(row, 'error')
  }
}

const letterFor = (index: number): string => String.fromCharCode(65 + index)

const OPTION_ROW_CLASS =
  'flex w-full items-start gap-2 rounded-[0.25rem] px-1.5 py-1 text-left disabled:cursor-not-allowed disabled:opacity-50'

// field-sizing on top of Textarea's shared chrome; kill min-h-16 for one-liners.
const CLARIFY_TEXTAREA_CLASS = 'field-sizing-content max-h-40 min-h-0 resize-none'

const CLARIFY_SHELL_CLASS =
  'my-1.5 rounded-md border border-primary/20 bg-(--ui-chat-surface-background) text-[length:var(--conversation-text-font-size)] text-(--ui-text-primary)'

const CLARIFY_ICON_CLASS = 'mt-px size-4 shrink-0 text-(--ui-text-tertiary)'

function ClarifyShell({ children, className, ...props }: ComponentProps<'div'>) {
  return (
    <div className={cn(CLARIFY_SHELL_CLASS, className)} data-slot="clarify-inline" {...props}>
      {children}
    </div>
  )
}

function ClarifyLine({
  children,
  className,
  icon: Icon,
  ...props
}: ComponentProps<'div'> & { icon: typeof MessageQuestion }) {
  return (
    <div className={cn('flex items-start gap-2', className)} {...props}>
      <div className="min-w-0 flex-1">{children}</div>
      <Icon aria-hidden className={CLARIFY_ICON_CLASS} />
    </div>
  )
}

function KeyBadge({ char, preview, selected }: { char: string; preview?: boolean; selected: boolean }) {
  return (
    <Kbd
      className={cn(
        'mt-px',
        selected && 'border-primary bg-primary text-white shadow-none',
        !selected && preview && 'border-primary text-primary shadow-none'
      )}
      size="sm"
    >
      {char}
    </Kbd>
  )
}

/**
 * One choice row.
 *
 * `Tip` is this repo's themed stand-in for a native `title=` (banned on a
 * button by the no-native-title guard). It renders the child untouched when
 * `label` is falsy, so the live card is unaffected and only the settled
 * skipped card picks up the hover hint.
 *
 * `active` is the KEYBOARD cursor — where arrow keys have moved to — which is
 * a different thing from `selected`, the answer staged for submit. The settled
 * card passes neither, so its rows stay plain.
 */
function ChoiceButton({
  active = false,
  char,
  choice,
  disabled,
  keyShortcuts,
  onClick,
  selected = false,
  title
}: {
  active?: boolean
  char: string
  choice: string
  disabled?: boolean
  keyShortcuts?: string
  onClick: () => void
  selected?: boolean
  title?: string
}) {
  return (
    <Tip label={title}>
      <button
        aria-current={active || undefined}
        aria-keyshortcuts={keyShortcuts}
        className={cn(
          OPTION_ROW_CLASS,
          'text-(--ui-text-secondary) hover:bg-(--chrome-action-hover) hover:text-(--ui-text-primary)',
          active && 'bg-(--chrome-action-hover) text-(--ui-text-primary)',
          selected && 'text-(--ui-text-primary)'
        )}
        data-choice
        data-highlighted={active || undefined}
        disabled={disabled}
        onClick={onClick}
        type="button"
      >
        <KeyBadge char={char} preview={active} selected={selected} />
        <span className="flex-1 wrap-anywhere">{choice}</span>
      </button>
    </Tip>
  )
}

export const ClarifyTool = (props: ToolCallMessagePartProps) => {
  // Answered → settled Q&A (ToolFallback collapsed the answer away).
  if (props.result !== undefined) {
    return <ClarifyToolSettled {...props} />
  }

  return <ClarifyToolLive {...props} />
}

function ClarifyToolLive(props: ToolCallMessagePartProps) {
  const messageRunning = useAuiState(selectMessageRunning)

  // Stopped mid-prompt with no result — don't leave a dead interactive panel.
  if (!messageRunning) {
    return <ToolFallback {...props} />
  }

  return <ClarifyToolPending {...props} />
}

function ClarifyToolSettled({ args, result }: ToolCallMessagePartProps) {
  const { t } = useI18n()
  const copy = t.assistant.clarify
  const fromArgs = useMemo(() => readClarifyArgs(args), [args])
  const fromResult = useMemo(() => readClarifyResult(result), [result])

  const question = fromResult.question || fromArgs.question || ''
  const answer = fromResult.answer
  const error = fromResult.error
  const skipped = !error && answer !== undefined && !answer.trim()
  const answerText = error || (skipped ? copy.skipped : (answer ?? '').trim())
  const choices = fromArgs.choices ?? []

  // A SKIPPED clarify keeps its choices on screen and actionable. The blocking
  // request is long gone — the tool already returned empty — so a pick cannot
  // resolve it retroactively; instead it drafts a quoted follow-up into the
  // composer, which sends on Enter (or queues, if the agent is mid-turn).
  // Without this the card collapsed to a bare "Skipped" and the options the
  // agent offered were unrecoverable.
  const followUp = useCallback(
    (choice: string) => {
      requestComposerInsert(copy.lateAnswer(question, choice), { mode: 'block' })
      requestComposerFocus()
      void triggerHaptic('selection')
    },
    [copy, question]
  )

  return (
    <ClarifyShell className="grid gap-1.5 px-2.5 py-2" data-clarify-settled="">
      {question ? (
        <ClarifyLine icon={MessageQuestion}>
          <span className="whitespace-pre-wrap font-medium leading-(--conversation-line-height)">{question}</span>
        </ClarifyLine>
      ) : null}
      {answerText ? (
        <ClarifyLine icon={CircleLetterA}>
          <p
            className={cn(
              'whitespace-pre-wrap leading-(--conversation-line-height)',
              error ? 'text-destructive' : 'text-(--ui-text-secondary)',
              skipped && 'italic text-(--ui-text-tertiary)'
            )}
            data-clarify-answer=""
          >
            {answerText}
          </p>
        </ClarifyLine>
      ) : null}
      {skipped && choices.length > 0 ? (
        <div className="grid gap-px" data-clarify-late-choices="" role="group">
          {choices.map((choice, index) => (
            <ChoiceButton
              char={letterFor(index)}
              choice={choice}
              key={`${index}-${choice}`}
              onClick={() => followUp(choice)}
              title={copy.lateAnswerTip}
            />
          ))}
          <p className="px-1.5 pt-0.5 text-[0.6875rem] leading-4 text-(--ui-text-tertiary)">{copy.lateAnswerHint}</p>
        </div>
      ) : null}
    </ClarifyShell>
  )
}

function ClarifyToolPending({ args }: ToolCallMessagePartProps) {
  const { t } = useI18n()
  const copy = t.assistant.clarify
  // The clarify panel renders INSIDE a transcript, so it belongs to the session
  // that transcript is showing — not to whichever chat is on screen. Reading the
  // view's key means a tile's clarify answers the tile's agent.
  const sessionKey = useStore(useSessionView().$runtimeId) ?? ''
  const request = useStore(sessionClarifyRequest(sessionKey))
  const fromArgs = useMemo(() => readClarifyArgs(args), [args])

  const matchingRequest = useMemo(() => {
    if (!request) {
      return null
    }

    if (fromArgs.question && request.question && fromArgs.question !== request.question) {
      return null
    }

    return request
  }, [fromArgs.question, request])

  // The store leads: `tool.start` ships no args, so `clarify.request` is the only
  // source for the question + choices until the tool completes.
  const question = matchingRequest?.question || fromArgs.question || ''

  // Normalized once more at the render boundary: the store holds whatever the
  // gateway sent, and a panel that renders a blank or multi-line option has no
  // way back once it is on screen (store/clarify.ts).
  const choices = useMemo(
    () => normalizeChoices(matchingRequest?.choices ?? fromArgs.choices ?? []),
    [fromArgs.choices, matchingRequest?.choices]
  )

  const hasChoices = choices.length > 0

  const [draft, setDraft] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [selectedChoice, setSelectedChoice] = useState<string | null>(null)
  // The keyboard cursor. Indices 0..choices.length-1 are the options; the
  // trailing index (=== choices.length) is the "Other" free-text row. Distinct
  // from `selectedChoice`: moving is not picking.
  const [activeIndex, setActiveIndex] = useState(0)
  const [otherFocused, setOtherFocused] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const shellRef = useRef<HTMLDivElement | null>(null)

  // Race: tool.start fires a tick before clarify.request, so request_id
  // arrives slightly after the tool block mounts. Hold the whole panel on a
  // spinner until the gateway request is wired — showing disabled choices or
  // a "loading question" stub is worse than a brief wait.
  const ready = Boolean(matchingRequest?.requestId)
  const loading = !ready && !submitting

  const respond = useCallback(
    async (answer: string) => {
      if (!ready) {
        notifyError(new Error(copy.notReady), copy.sendFailed)

        return
      }

      setSubmitting(true)

      try {
        const outcome = await respondClarify(answer, sessionKey)

        void triggerHaptic('submit')

        // `clarify.respond` is `allow_expired`: a question the backend's own
        // 5-minute timeout already popped answers OK and delivers nothing. The
        // agent has moved on, so there is no retry — but the words are still
        // the user's intent, so route them where a skipped clarify's late pick
        // goes: a quoted follow-up in the composer. Silently "succeeding" here
        // is how an answer disappears with the UI saying it was sent.
        if (outcome === 'expired' && answer.trim()) {
          requestComposerInsert(copy.lateAnswer(question, answer.trim()), { mode: 'block' })
          requestComposerFocus()
          notify({ kind: 'warning', message: copy.expiredAnswer })
        }
        // tool.complete lands next → ClarifyToolSettled.
      } catch (error) {
        notifyError(error, copy.sendFailed)
        setSubmitting(false)
      }
    },
    [copy, question, ready, sessionKey]
  )

  const trimmedDraft = draft.trim()
  const pendingAnswer = selectedChoice ?? (trimmedDraft || null)

  const selectChoice = useCallback((choice: string, index: number) => {
    // Picking a choice and typing are mutually exclusive answers.
    setDraft('')
    setSelectedChoice(choice)
    setActiveIndex(index)
  }, [])

  // Keep the cursor in range when the choice set changes (never past "Other").
  useEffect(() => {
    setActiveIndex(index => Math.min(index, choices.length))
  }, [choices.length])

  const moveActive = useCallback(
    (delta: number) => {
      const itemCount = choices.length + 1

      // Arrow navigation is a move, not a pick — clear any staged answer so the
      // cursor and the selection cannot disagree about what Enter would send.
      setDraft('')
      setSelectedChoice(null)
      setActiveIndex(index => (index + delta + itemCount) % itemCount)
    },
    [choices.length]
  )

  const submitAnswer = useCallback(() => {
    if (selectedChoice !== null) {
      void respond(selectedChoice)

      return
    }

    if (trimmedDraft) {
      void respond(trimmedDraft)
    }
  }, [respond, selectedChoice, trimmedDraft])

  const activateActive = useCallback(() => {
    // A staged answer (picked choice or typed text) wins — confirm it.
    if (pendingAnswer) {
      submitAnswer()

      return
    }

    // Otherwise act on the highlighted row: a choice answers immediately, and
    // the trailing "Other" row focuses the free-text field.
    const choice = choices[activeIndex]

    if (choice) {
      void respond(choice)

      return
    }

    textareaRef.current?.focus()
  }, [activeIndex, choices, pendingAnswer, respond, submitAnswer])

  const handleTextareaKey = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.nativeEvent.isComposing) {
        return
      }

      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        submitAnswer()
      }
    },
    [submitAnswer]
  )

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      submitAnswer()
    },
    [submitAnswer]
  )

  // Arrow keys move the cursor, 1-9 and A/B/C… pick directly, and Enter
  // confirms the staged answer (or acts on the highlighted row). Stands down
  // whenever ANY focusable control holds focus — a field, a choice button, a
  // button in the action row — so it never eats a keystroke meant for the thing
  // the user actually tabbed to. Testing only INPUT/TEXTAREA (as this did) let
  // a focused Skip button lose its own Enter to this handler.
  useEffect(() => {
    if (!ready || !hasChoices || submitting) {
      return
    }

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) {
        return
      }

      // This listener is on the DOCUMENT, but the card is one surface among
      // many: keep-alive leaves an inactive tab's clarify mounted, and a split
      // can show two at once. Only the card the composer also yields to may act
      // — otherwise a background session's question ate the foreground's
      // letters, and Enter answered it with whatever its cursor happened to be
      // resting on. `keyOwningClarifyCard` is that single answer, shared with
      // `clarifyCardOwnsKey` so the two can never pick different cards.
      if (keyOwningClarifyCard() !== shellRef.current) {
        return
      }

      const active = document.activeElement as HTMLElement | null

      if (
        active &&
        (active.isContentEditable || active.matches('a[href], button, input, select, textarea, [role="button"]'))
      ) {
        return
      }

      // Mid-composition (IME) the key events describe the composition, not the
      // user's intent. WebKitGTK orders these differently from Chromium, so the
      // guard belongs on the GLOBAL handler too, not just the textarea's.
      if (event.isComposing) {
        return
      }

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        moveActive(event.key === 'ArrowDown' ? 1 : -1)

        return
      }

      if (/^[1-9]$/.test(event.key)) {
        const index = Number(event.key) - 1

        if (index < choices.length) {
          event.preventDefault()
          selectChoice(choices[index], index)
        } else if (index === choices.length) {
          event.preventDefault()
          setActiveIndex(index)
          textareaRef.current?.focus()
        }

        return
      }

      const key = event.key.toLowerCase()

      // Only the letters this card actually renders a row for. Anything past
      // the last row belongs to the composer — the user is typing a message
      // instead of picking an option, and swallowing it here would make the
      // first letter of that message vanish.
      if (key.length === 1 && key >= 'a' && key <= 'z') {
        const index = key.charCodeAt(0) - 97

        if (index < choices.length) {
          event.preventDefault()
          selectChoice(choices[index], index)
        } else if (index === choices.length) {
          event.preventDefault()
          setActiveIndex(index)
          textareaRef.current?.focus()
        }

        return
      }

      if (event.key === 'Enter') {
        event.preventDefault()
        activateActive()
      }
    }

    window.addEventListener('keydown', onKeyDown)

    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activateActive, choices, hasChoices, moveActive, ready, selectChoice, submitting])

  if (loading) {
    return (
      <ClarifyShell
        aria-label={copy.loadingQuestion}
        className="grid min-h-12 place-items-center px-2.5 py-3"
        role="status"
      >
        <Loader2 aria-hidden className="size-4 animate-spin text-(--ui-text-tertiary)" />
      </ClarifyShell>
    )
  }

  const onDraftChange = (value: string) => {
    setDraft(value)

    if (value.trim()) {
      setSelectedChoice(null)
    }
  }

  return (
    // `data-clarify-choices` marks the panel as owning its OWN shortcut keys
    // (Enter, and 1..N+1 / A.. for the N choices plus "Other") while they're
    // live, so the global type-to-focus listener (`clarifyCardOwnsKey`) yields
    // exactly those and lets every other printable through to the composer —
    // typing a real message instead of picking an option stays possible. The
    // value is the choice count so the check needs no store access.
    <ClarifyShell
      className="grid gap-2 px-2.5 py-2"
      data-clarify-choices={hasChoices ? choices.length : undefined}
      ref={shellRef}
    >
      <div className="flex items-start gap-2">
        <span className="flex-1 whitespace-pre-wrap font-medium leading-(--conversation-line-height)">{question}</span>
        <MessageQuestion aria-hidden className="mt-px size-4 shrink-0 text-(--ui-text-tertiary)" />
      </div>

      <form className="grid gap-2" onSubmit={handleSubmit}>
        {hasChoices ? (
          <div className="grid gap-px" role="group">
            {choices.map((choice, index) => (
              <ChoiceButton
                active={activeIndex === index}
                char={letterFor(index)}
                choice={choice}
                disabled={submitting}
                key={`${index}-${choice}`}
                keyShortcuts={`${letterFor(index)} ${index + 1}`}
                onClick={() => selectChoice(choice, index)}
                selected={selectedChoice === choice}
              />
            ))}
            <label
              className={cn(
                OPTION_ROW_CLASS,
                'items-center',
                activeIndex === choices.length && 'bg-(--chrome-action-hover)'
              )}
              data-highlighted={activeIndex === choices.length || undefined}
            >
              <KeyBadge
                char={letterFor(choices.length)}
                preview={otherFocused || activeIndex === choices.length}
                selected={Boolean(trimmedDraft)}
              />
              <Textarea
                aria-current={activeIndex === choices.length || undefined}
                aria-keyshortcuts={`${letterFor(choices.length)} ${choices.length + 1}`}
                className={CLARIFY_TEXTAREA_CLASS}
                disabled={submitting}
                onBlur={() => setOtherFocused(false)}
                onChange={event => onDraftChange(event.target.value)}
                onFocus={() => {
                  setSelectedChoice(null)
                  setActiveIndex(choices.length)
                  setOtherFocused(true)
                }}
                onKeyDown={handleTextareaKey}
                placeholder={copy.other}
                ref={textareaRef}
                rows={1}
                size="sm"
                value={draft}
              />
            </label>
          </div>
        ) : (
          <Textarea
            className={CLARIFY_TEXTAREA_CLASS}
            disabled={submitting}
            onChange={event => onDraftChange(event.target.value)}
            onKeyDown={handleTextareaKey}
            placeholder={copy.placeholder}
            ref={textareaRef}
            rows={1}
            size="sm"
            value={draft}
          />
        )}

        <div className="flex items-center justify-end gap-1">
          <Button disabled={submitting} onClick={() => void respond('')} size="xs" type="button" variant="text">
            {copy.skip}
          </Button>
          <Button disabled={submitting || !pendingAnswer} size="xs" type="submit">
            {submitting ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <>
                {copy.continueLabel}
                <span aria-hidden className="ml-0.5 text-[0.625rem] opacity-70">
                  ⏎
                </span>
              </>
            )}
          </Button>
        </div>
      </form>
    </ClarifyShell>
  )
}
