import type { Unstable_TriggerItem } from '@assistant-ui/core'

import type { SlashChipKind } from '@/components/assistant-ui/directive-text'
import type { ComposerAttachment } from '@/store/composer'
import { setSessionPickerOpen } from '@/store/session'

// Quiet period after the last keystroke before persisting the draft;
// unmount/pagehide flushes bypass it.
export const DRAFT_PERSIST_DEBOUNCE_MS = 400

export const pickPlaceholder = (pool: readonly string[]) => pool[Math.floor(Math.random() * pool.length)]

/** Completion items can carry an `action` (set in use-slash-completions) that
 *  runs a side effect on pick instead of inserting a chip — e.g. the session
 *  picker's "Browse all…" entry opens the overlay. Table-driven so new action
 *  items are a registry row, not a composer branch. */
export const COMPLETION_ACTIONS: Record<string, () => void> = {
  'session-picker': () => setSessionPickerOpen(true)
}

/** Map a picked `/` completion to its pill accent. Driven by the completion
 *  group set in use-slash-completions (Skills / Themes / Commands|Options). */
export function slashChipKindForItem(item: Unstable_TriggerItem): SlashChipKind {
  const group = (item.metadata as { group?: unknown } | undefined)?.group

  if (group === 'Skills') {
    return 'skill'
  }

  if (group === 'Themes') {
    return 'theme'
  }

  return 'command'
}

/** Is this completion a SKILL? The one kind that reads as a reference inside
 *  prose, so it is the only kind an inline `/` offers. */
export const isSkillItem = (item: Unstable_TriggerItem) => slashChipKindForItem(item) === 'skill'

/**
 * Should this keypress be swallowed because the completion popover is open but
 * its items have not landed yet?
 *
 * Only Tab, and only in that window. Tab is the one key whose default action
 * leaves the composer entirely, so pressing it a beat before the results paint
 * moved focus to the next control — from the user's side, the popover ate the
 * keypress and then stole the caret. Every other key either edits text (fine) or
 * is handled by the open-with-items branch below it.
 *
 * A predicate rather than an inline condition so the rule is pinned by a test:
 * the composer's keydown handler cannot be mounted in a unit test, and this is
 * the whole of the decision it makes.
 */
export function swallowsTriggerTab(options: {
  key: string
  itemCount: number
  loading: boolean
  open: boolean
}): boolean {
  return options.open && options.loading && options.itemCount === 0 && options.key === 'Tab'
}

/** A `/` query is at its arg stage once it's past the command name. */
export const slashArgStage = (query: string) => query.includes(' ')

/** The `/command` token of a slash query (`personality x` → `/personality`). */
export const slashCommandToken = (query: string) => `/${query.split(/\s+/, 1)[0]?.toLowerCase() ?? ''}`

export interface QueueEditState {
  attachments: ComposerAttachment[]
  draft: string
  entryId: string
  sessionKey: string
}

export const cloneAttachments = (attachments: ComposerAttachment[]) => attachments.map(a => ({ ...a }))

export interface PendingDraftPersist {
  scope: string | null
  text: string
}

/**
 * Defense-in-depth for #54527: the debounce timer and the `pagehide` flush
 * both write a captured `{ scope, text }` pair some time after it was
 * scheduled. Before either commits the write, this checks the pair is still
 * the one currently on file — i.e. nothing cleared or replaced it in the
 * meantime (a session swap, a newer keystroke). The scope-capture fix
 * upstream (`draftScopeRef`) already makes every captured pair correct by
 * construction; this guard exists so that if a future change reintroduces a
 * stale/live-ref read at one of these call sites, the write is dropped
 * instead of silently filing one session's text under another session's key.
 */
export function isPendingDraftPersistCurrent(
  pending: PendingDraftPersist | null,
  expected: PendingDraftPersist | null
): boolean {
  return pending !== null && expected !== null && pending.scope === expected.scope && pending.text === expected.text
}
