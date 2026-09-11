/**
 * The composer's completion popover opens on the keystroke and fills a beat
 * later (60ms debounce + an RPC). Tab pressed inside that window fell through to
 * the browser and moved focus out of the composer — the popover appeared to eat
 * the key and take the caret with it.
 *
 * `swallowsTriggerTab` is that decision, and it is a function precisely so it can
 * be pinned here: the keydown handler it is called from lives inside `ChatBar`,
 * which cannot be mounted in a unit test.
 */

import { describe, expect, it } from 'vitest'

import { composerEnterIntent, swallowsTriggerTab } from './composer-utils'

const inFlight = { itemCount: 0, key: 'Tab', loading: true, open: true }

describe('swallowsTriggerTab', () => {
  it('swallows Tab while the open popover has nothing to offer yet', () => {
    expect(swallowsTriggerTab(inFlight)).toBe(true)
  })

  // Tab with items ACCEPTS the highlighted one (and descends into a folder), so
  // this branch must not claim it first.
  it('leaves Tab to the accept branch once items have landed', () => {
    expect(swallowsTriggerTab({ ...inFlight, itemCount: 3 })).toBe(false)
  })

  it('leaves Tab alone when nothing is in flight', () => {
    expect(swallowsTriggerTab({ ...inFlight, loading: false })).toBe(false)
  })

  // No popover, no claim: Tab out of the composer is how the keyboard reaches
  // the rest of the app, and swallowing it here would be a focus trap.
  it('never claims Tab with no popover open', () => {
    expect(swallowsTriggerTab({ ...inFlight, open: false })).toBe(false)
  })

  it('claims Tab only — every other key still types or navigates', () => {
    for (const key of ['Enter', ' ', 'ArrowDown', 'Escape', 'a', 'Backspace']) {
      expect(swallowsTriggerTab({ ...inFlight, key })).toBe(false)
    }
  })
})

/**
 * The Enter family. Four gestures share one key and the ORDER between them is
 * the entire rule, so it lives in one function rather than emerging from four
 * branches scattered through a 1400-line component.
 *
 * Two bugs were hiding in that order:
 *
 *  - Shift+Enter was never claimed at all. It fell through to the webview's own
 *    `insertLineBreak`, whose DOM differs per engine, and `normalizeComposerEditorDom`
 *    then deleted the newline on WebKit — "Shift+Enter does nothing on macOS".
 *    Claiming it has to happen BEFORE the completion menu, whose accept test was
 *    `Enter || Tab || space` with no shift guard.
 *  - The message-EDIT composer sent on `Enter && !shiftKey` with no modifier
 *    guard, so ⌘+Enter — the queue chord everywhere else — re-ran the turn and
 *    rewound the conversation, with no undo.
 */

const plain = { completionOpen: false, ctrlKey: false, key: 'Enter', metaKey: false, shiftKey: false }

describe('composerEnterIntent', () => {
  it('sends on a plain Enter', () => {
    expect(composerEnterIntent(plain)).toBe('send')
  })

  it('breaks the line on Shift+Enter', () => {
    expect(composerEnterIntent({ ...plain, shiftKey: true })).toBe('line-break')
  })

  it('queues on Cmd+Enter and on Ctrl+Enter', () => {
    expect(composerEnterIntent({ ...plain, metaKey: true })).toBe('queue')
    expect(composerEnterIntent({ ...plain, ctrlKey: true })).toBe('queue')
  })

  it('never sends on Cmd+Enter — a composer with no queue must do NOTHING', () => {
    // The edit composer's whole bug: `queue` is an intent it ignores, and
    // ignoring is the correct outcome. Anything that resolved to `send` here
    // would re-run the turn.
    expect(composerEnterIntent({ ...plain, metaKey: true })).not.toBe('send')
    expect(composerEnterIntent({ ...plain, ctrlKey: true })).not.toBe('send')
  })

  it('breaks the line even with the completion menu open', () => {
    // The regression that made Shift+Enter unreliable in the middle of a
    // sentence: typing `@fi` opens the menu, and the menu used to accept on any
    // Enter.
    expect(composerEnterIntent({ ...plain, completionOpen: true, shiftKey: true })).toBe('line-break')
  })

  it('gives a plain Enter to the open completion menu', () => {
    expect(composerEnterIntent({ ...plain, completionOpen: true })).toBe('accept-completion')
  })

  it('gives Cmd+Enter to the open completion menu too', () => {
    // Preserved from the shipped handler, where the popover branch ran ahead of
    // the queue branch and had no modifier guard. Changing it would be a
    // separate decision, not a side effect of this one.
    expect(composerEnterIntent({ ...plain, completionOpen: true, metaKey: true })).toBe('accept-completion')
  })

  it('leaves Shift+Cmd+Enter alone', () => {
    // Claimed by nothing today; it must not fall into `send` by accident.
    expect(composerEnterIntent({ ...plain, metaKey: true, shiftKey: true })).toBe('pass-through')
    expect(composerEnterIntent({ ...plain, ctrlKey: true, shiftKey: true })).toBe('pass-through')
  })

  it('ignores every key that is not Enter', () => {
    for (const key of ['Tab', ' ', 'Escape', 'ArrowUp', 'a', 'Backspace']) {
      expect(composerEnterIntent({ ...plain, key })).toBe('pass-through')
      expect(composerEnterIntent({ ...plain, key, shiftKey: true })).toBe('pass-through')
    }
  })
})
