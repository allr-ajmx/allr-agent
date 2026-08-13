import type { Unstable_TriggerAdapter, Unstable_TriggerItem } from '@assistant-ui/core'
import { type MutableRefObject, type RefObject, useCallback, useEffect, useRef, useState } from 'react'

import { hermesDirectiveFormatter } from '@/components/assistant-ui/directive-text'
import { desktopSlashCommandTakesArgs } from '@/lib/desktop-slash-commands'

import {
  COMPLETION_ACTIONS,
  isSkillItem,
  slashArgStage,
  slashChipKindForItem,
  slashCommandToken
} from '../composer-utils'
import {
  appendComposerContents,
  caretOffsetInEditor,
  composerPlainText,
  placeCaretAtOffset,
  refChipElement,
  renderComposerContents,
  replaceBeforeCaret,
  RICH_INPUT_SLOT,
  slashChipElement
} from '../rich-editor'
import { detectTrigger, mayContainTrigger, textBeforeCaret, type TriggerState } from '../text-utils'

/**
 * Rewrite the `tokenLength` characters before the caret, keeping the prose on
 * either side. The fallback for when the in-place `replaceBeforeCaret` can't
 * run — it rebuilds the editor from text, which is correct but loses nothing
 * only because every chip hydrates back (see `appendComposerContents`).
 *
 * Anchored on the CARET, not the end of the editor: a completion picked
 * mid-message used to chop the trailing prose off and strand a partial
 * `folder:` in front of the chip, because the window it removed wasn't the
 * token the user was typing.
 */
export function rebuildAroundCaret(editor: HTMLDivElement, tokenLength: number, insert: DocumentFragment | string) {
  const current = composerPlainText(editor)
  const caret = caretOffsetInEditor(editor)
  const prefix = current.slice(0, Math.max(0, caret - tokenLength))
  const suffix = current.slice(caret)

  if (typeof insert === 'string') {
    renderComposerContents(editor, `${prefix}${insert}${suffix}`)
    placeCaretAtOffset(editor, prefix.length + insert.length)

    return
  }

  // Measure before appending — moving a fragment empties it. Appending the
  // element rather than re-serializing keeps mid-message slash pills alive.
  const scratch = document.createElement('div')

  scratch.dataset.slot = RICH_INPUT_SLOT
  scratch.append(insert.cloneNode(true))

  const inserted = composerPlainText(scratch)

  renderComposerContents(editor, prefix)
  editor.append(insert)
  appendComposerContents(editor, suffix)
  placeCaretAtOffset(editor, prefix.length + inserted.length)
}

interface CompletionSource {
  adapter: Unstable_TriggerAdapter | null
  loading: boolean
}

interface UseComposerTriggerOptions {
  at: CompletionSource
  /** True while an IME preedit is open. The popover must not act on composition
   *  keys: the DOM already holds the uncommitted preedit, so detecting against
   *  it opens a menu over the IME's own candidate window on characters the user
   *  has not committed and may never commit. `compositionend` refreshes with
   *  what the input method actually produced. */
  composingRef?: MutableRefObject<boolean>
  /** `:joy` emoji completions — inserts the emoji character, never a chip. */
  emoji?: CompletionSource
  draftRef: MutableRefObject<string>
  editorRef: RefObject<HTMLDivElement | null>
  /** Bank the pre-edit state before a pick rewrites the editor, so ⌘Z steps
   *  back over a committed chip instead of past it. */
  recordUndoPoint?: () => void
  requestMainFocus: () => void
  setComposerText: (text: string) => void
  slash: CompletionSource
}

/**
 * Trigger / completion engine: `@`/`/` detection against the live editor, the
 * adapter-driven item list, the open popover's selection state, and the chip
 * insertion that commits a pick back into the contentEditable. Owns the trigger
 * state; ChatBar threads its editor refs in and consumes the returned API from
 * the input/keydown/keyup paths + the popover render. `triggerKeyConsumedRef` is
 * exposed so keydown can mark a navigation/control key as handled and the
 * subsequent keyup skips its refresh.
 */
export function useComposerTrigger({
  at,
  composingRef,
  emoji,
  draftRef,
  editorRef,
  recordUndoPoint,
  requestMainFocus,
  setComposerText,
  slash
}: UseComposerTriggerOptions) {
  const [trigger, setTrigger] = useState<TriggerState | null>(null)
  const [triggerActive, setTriggerActive] = useState(0)
  const [triggerItems, setTriggerItems] = useState<readonly Unstable_TriggerItem[]>([])
  // Set synchronously in keydown when the open trigger popover consumes a
  // navigation/control key (Arrow/Enter/Tab/Escape). The subsequent keyup must
  // NOT run refreshTrigger for that keypress: it never edits text, and for
  // Escape the keydown has already set trigger=null, so a keyup refresh would
  // re-detect the still-present `/` and instantly reopen the menu. A ref is
  // used instead of reading `trigger` in keyup because by keyup time React has
  // re-rendered and the handler closure sees the post-keydown state.
  const triggerKeyConsumedRef = useRef(false)

  const refreshTrigger = useCallback(() => {
    const editor = editorRef.current

    if (!editor) {
      return
    }

    // Mid-composition the editor holds an uncommitted IME preedit, so anything
    // detected against it is a menu opened on keys the user is still choosing
    // between. Leave whatever is already open alone and wait for
    // `compositionend`, which refreshes with the committed text. Keyup fires for
    // every physical key during a preedit, so without this the popover reacts to
    // the composition on both composers.
    if (composingRef?.current) {
      return
    }

    // Fast-bail: if the draft holds no character that can START a trigger,
    // there's nothing for `detectTrigger` to match. Use `textContent` (cheap
    // browser-native walk) for the precondition check rather than
    // `composerPlainText` (recursive child walk with chip-aware logic). Only
    // when a trigger char is present do we pay the cost of the full walk + DOM
    // range work. The character set lives beside the regexes in `text-utils` —
    // a local copy of it is what silently dropped every `:` emoji trigger.
    const rawText = editor.textContent ?? ''

    if (!mayContainTrigger(rawText)) {
      if (trigger) {
        setTrigger(null)
        setTriggerActive(0)
      }

      return
    }

    const before = textBeforeCaret(editor)
    const found = detectTrigger(before ?? composerPlainText(editor))

    // The arg-stage popover is only useful for commands with an options screen.
    // For a no-arg command it would dead-end on "No matches", so drop it — the
    // directive is already complete.
    const detected =
      found?.kind === '/' && slashArgStage(found.query) && !desktopSlashCommandTakesArgs(slashCommandToken(found.query))
        ? null
        : found

    setTrigger(detected)

    // Only reset the highlight when the trigger actually changed (opened, or
    // the query/kind differs). Re-detecting the *same* trigger — e.g. on a
    // caret move (mouseup) or a stray refresh — must preserve the user's
    // current selection instead of snapping back to the first item.
    if (detected?.kind !== trigger?.kind || detected?.query !== trigger?.query) {
      setTriggerActive(0)
    }
  }, [composingRef, editorRef, trigger])

  const triggerAdapter: Unstable_TriggerAdapter | null =
    trigger?.kind === '@' ? at.adapter : trigger?.kind === '/' ? slash.adapter : (emoji?.adapter ?? null)

  useEffect(() => {
    if (!trigger || !triggerAdapter?.search) {
      setTriggerItems([])

      return
    }

    const items = triggerAdapter.search(trigger.query)

    // Mid-message only offers SKILLS. A built-in like `/model` or `/new` acts
    // on the app, so it is meaningless as a reference inside prose — only a
    // skill reads as "handle this part with X". Filtering here rather than in
    // the fetcher keeps one completion source for both shapes.
    setTriggerItems(trigger.inline ? items.filter(isSkillItem) : items)
  }, [trigger, triggerAdapter])

  const triggerLoading =
    trigger?.kind === '@' ? at.loading : trigger?.kind === '/' ? slash.loading : (emoji?.loading ?? false)

  // Suppress the "No matches" empty state once a slash command is past its name:
  // a no-arg command has nothing to offer, and a fully-typed arg commits on
  // Space/Tab — neither should dead-end on a popover.
  const argStageEmpty = trigger?.kind === '/' && slashArgStage(trigger.query) && !triggerLoading && !triggerItems.length

  const closeTrigger = () => {
    setTrigger(null)
    setTriggerItems([])
    setTriggerActive(0)
  }

  useEffect(() => {
    setTriggerActive(idx => Math.min(idx, Math.max(0, triggerItems.length - 1)))
  }, [triggerItems.length])

  // Commit the literally-typed `/command arg` as a directive chip — used when
  // the completion list is empty because the arg is already fully typed (the
  // backend completer drops exact matches). Reuses the chip path via a
  // synthetic item whose serialized form is the verbatim text.
  const commitTypedSlashDirective = () => {
    if (trigger?.kind !== '/') {
      return
    }

    const text = `/${trigger.query.trimEnd()}`

    replaceTriggerWithChip({
      id: text,
      type: 'slash',
      label: text.slice(1),
      metadata: {
        command: slashCommandToken(trigger.query),
        display: text,
        meta: '',
        group: '',
        action: '',
        rawText: text
      }
    })
  }

  const replaceTriggerWithChip = (item: Unstable_TriggerItem, options?: { descend?: boolean }) => {
    const editor = editorRef.current

    if (!editor || !trigger) {
      return
    }

    // Bank the pre-commit state first — every path below mutates the editor,
    // and a pick must be exactly one undo step.
    recordUndoPoint?.()

    const rebuildAround = (insert: DocumentFragment | string) => rebuildAroundCaret(editor, trigger.tokenLength, insert)

    // Action items (e.g. "Browse all sessions…") run a side effect instead of
    // inserting a chip: strip the typed trigger token, then fire the action.
    const completionAction = (item.metadata as { action?: unknown } | undefined)?.action
    const runAction = typeof completionAction === 'string' ? COMPLETION_ACTIONS[completionAction] : undefined

    if (runAction) {
      if (!replaceBeforeCaret(editor, trigger.tokenLength, document.createDocumentFragment())) {
        rebuildAround('')
      }

      draftRef.current = composerPlainText(editor)
      setComposerText(draftRef.current)
      closeTrigger()
      runAction()
      requestMainFocus()

      return
    }

    const serialized = hermesDirectiveFormatter.serialize(item)
    const starter = serialized.endsWith(':')

    const finish = (keepOpen: boolean) => {
      draftRef.current = composerPlainText(editor)
      setComposerText(draftRef.current)
      requestMainFocus()
      keepOpen ? window.setTimeout(refreshTrigger, 0) : closeTrigger()
    }

    // Tab on a folder walks INTO it instead of committing it: re-type the
    // token as the bare path so the next `complete.path` lists that folder's
    // children, exactly as typing the path by hand would. Enter still commits
    // the folder itself — the two intents are distinct, so the keys are too.
    // Only `@` folders descend; a slash command's arg list has no hierarchy.
    const descendInto =
      options?.descend && trigger.kind === '@' && item.type === 'folder'
        ? String((item.metadata as { insertId?: unknown } | undefined)?.insertId ?? '')
        : ''

    if (descendInto) {
      const path = descendInto.endsWith('/') ? descendInto : `${descendInto}/`
      // Carry the browse scope down with the path. Dropping it turns an
      // explicit `@folder:` browse into a bare `@apps/foo/` token halfway
      // through, so the next completion silently widens back to files and the
      // committed chip has to re-guess the kind from a trailing slash.
      const scope = trigger.scope ? `${trigger.scope}:` : ''
      const fragment = document.createDocumentFragment()

      fragment.append(document.createTextNode(`@${scope}${path}`))

      if (!replaceBeforeCaret(editor, trigger.tokenLength, fragment)) {
        rebuildAround(`@${scope}${path}`)
      }

      return finish(true)
    }

    // Picking a bare arg-taking command (e.g. `/personality`) shouldn't commit
    // it — expand to its options step so the popover shows the inline list, just
    // as typing `/personality ` by hand would. A serialized value with a space is
    // already an arg pick (`/personality alice`), so it commits normally.
    const command = (item.metadata as { command?: string } | undefined)?.command ?? ''

    const expandsToArgs = trigger.kind === '/' && !serialized.includes(' ') && desktopSlashCommandTakesArgs(command)

    const text = starter || serialized.endsWith(' ') ? serialized : `${serialized} `
    const directive = !starter && serialized.match(/^@([^:]+):(.+)$/)
    // No pill while expanding — the bare command stays plain text until an arg
    // is picked, at which point a single pill is emitted for the full command.
    const slashKind = !expandsToArgs && trigger.kind === '/' ? slashChipKindForItem(item) : null
    const keepTriggerOpen = starter || expandsToArgs

    const chip = slashKind
      ? slashChipElement(serialized, slashKind)
      : directive
        ? refChipElement(directive[1], directive[2])
        : null

    // The trailing space is a convenience for "keep typing after the chip", so
    // it's wrong when the caret already has whitespace in front of it — a pick
    // made mid-sentence would leave a double space in the prose.
    const followedBySpace = /^\s/.test(composerPlainText(editor).slice(caretOffsetInEditor(editor)))
    const fragment = document.createDocumentFragment()

    chip
      ? fragment.append(chip, ...(followedBySpace ? [] : [document.createTextNode(' ')]))
      : fragment.append(document.createTextNode(followedBySpace ? text.trimEnd() : text))

    // In place first. The re-render fallback rebuilds the whole editor from
    // text, and the old code took it whenever the typed token wasn't wholly
    // inside ONE text node — which a contenteditable=false chip anywhere in the
    // line guarantees, because the engine fragments text nodes around it.
    if (!replaceBeforeCaret(editor, trigger.tokenLength, fragment)) {
      // The failed attempt never consumed the fragment, so the chip + trailing
      // space are re-inserted around the caret here. Moving the element rather
      // than re-serializing is what keeps a mid-message slash pill alive.
      rebuildAround(chip ? fragment : text)
    }

    finish(keepTriggerOpen)
  }

  /** Backspace inside an `@` path drops the last segment (`a/b/` → `a/`)
   *  instead of one character, and once the path is empty it drops the browse
   *  scope (`@folder:` → `@`) rather than nibbling `:`, `r`, `e`, `d`… back
   *  through the directive syntax the user never typed. Descending is one Tab
   *  per level, so climbing back out costs one key per level too. Returns
   *  false when the caret isn't in a path, so keydown falls through. */
  const ascendTriggerPath = () => {
    const editor = editorRef.current

    if (!editor || trigger?.kind !== '@') {
      return false
    }

    const scope = trigger.scope ? `${trigger.scope}:` : ''

    if (!trigger.value.includes('/') && !scope) {
      return false
    }

    // Trailing slash means we're listing a folder's children: drop that
    // folder. Otherwise a partial segment is typed — drop just that. With the
    // value already empty, the only thing left to drop is the scope itself.
    const trimmed = trigger.value.replace(/\/$/, '')
    const parent = trimmed.slice(0, trimmed.lastIndexOf('/') + 1)
    const next = trigger.value ? `${scope}${parent}` : ''

    recordUndoPoint?.()

    const fragment = document.createDocumentFragment()

    fragment.append(document.createTextNode(`@${next}`))

    if (!replaceBeforeCaret(editor, trigger.tokenLength, fragment)) {
      rebuildAroundCaret(editor, trigger.tokenLength, `@${next}`)
    }

    draftRef.current = composerPlainText(editor)
    setComposerText(draftRef.current)
    window.setTimeout(refreshTrigger, 0)

    return true
  }

  return {
    argStageEmpty,
    ascendTriggerPath,
    closeTrigger,
    commitTypedSlashDirective,
    refreshTrigger,
    replaceTriggerWithChip,
    setTriggerActive,
    trigger,
    triggerActive,
    triggerItems,
    triggerKeyConsumedRef,
    triggerLoading
  }
}
