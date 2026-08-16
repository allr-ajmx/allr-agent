import type { Unstable_TriggerAdapter } from '@assistant-ui/core'
import { renderHook } from '@testing-library/react'
import { createRef } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { useComposerTrigger } from './hooks/use-composer-trigger'
import { useEmojiCompletions } from './hooks/use-emoji-completions'
import { renderComposerContents, RICH_INPUT_SLOT } from './rich-editor'

/**
 * The composer trigger engine, rendered at REST — nothing typed, no popover.
 *
 * This is where it died. `triggerAdapter` used to fall through to the emoji
 * adapter for any kind it didn't recognise, which includes "no trigger at all",
 * and `useEmojiCompletions` handed `useLiveCompletionAdapter` a bare inline
 * `isCached`. A new function per render meant a new `scheduleFetch`, so a new
 * adapter, so the item-fetch effect saw a changed dependency on EVERY render —
 * and its bail path called `setTriggerItems([])` with a fresh array, which
 * `Object.is` can never match. Mount the composer, do nothing, and React tore it
 * down with "Maximum update depth exceeded".
 *
 * Both halves are pinned below: the source's identity, and the engine's
 * tolerance for a source that has none.
 */

/** A completion source that behaves correctly but is rebuilt every render — the
 *  shape any un-memoised hook produces. The engine must not care. */
function churningAdapter(): Unstable_TriggerAdapter {
  return {
    categories: () => [],
    categoryItems: () => [],
    search: () => []
  }
}

describe('trigger adapter identity', () => {
  it('does not re-render forever when a completion source is rebuilt every render', () => {
    const editor = document.createElement('div')

    editor.contentEditable = 'true'
    editor.dataset.slot = RICH_INPUT_SLOT
    document.body.append(editor)
    // No `@`, `/` or `:` — the composer at rest, which is the state that looped.
    renderComposerContents(editor, 'plain prose')

    const editorRef = createRef<HTMLDivElement>() as { current: HTMLDivElement | null }

    editorRef.current = editor

    const draftRef = { current: 'plain prose' }
    let renders = 0

    const { rerender, result } = renderHook(() => {
      renders += 1

      // Bail out loudly. Unbounded, this loop runs the worker out of heap and
      // the run dies with a V8 stack dump instead of a failing test.
      if (renders > 50) {
        throw new Error(`render loop: ${renders} renders with a completion adapter rebuilt every render`)
      }

      return useComposerTrigger({
        at: { adapter: null, loading: false },
        draftRef,
        editorRef,
        emoji: { adapter: churningAdapter(), loading: false },
        requestMainFocus: vi.fn(),
        setComposerText: vi.fn(),
        slash: { adapter: null, loading: false }
      })
    })

    const afterMount = renders

    rerender()

    expect(result.current.trigger).toBeNull()
    expect(result.current.triggerItems).toHaveLength(0)
    // One render for the rerender itself. A cascade — the effect scheduling a
    // state update that schedules another render — shows up as more than that,
    // and unbounded it throws before ever reaching this line.
    expect(renders - afterMount).toBeLessThanOrEqual(1)
  })

  it('keeps the emoji adapter identity stable across renders', () => {
    const { rerender, result } = renderHook(() => useEmojiCompletions())
    const first = result.current.adapter

    rerender()

    expect(result.current.adapter).toBe(first)
  })
})
