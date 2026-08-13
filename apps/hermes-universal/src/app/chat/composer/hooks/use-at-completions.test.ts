/**
 * `@` path completions — the popover's live source (MJXHRM-406).
 *
 * Two things are pinned here, and the first is the reason the file exists.
 *
 * ONE NAME PER REFERENCE. `tui_gateway`'s `complete.path` emits a BASENAME in
 * `display` (`methods_complete.py`: `entry + suffix`) while its `text` carries
 * the full `@kind:value`. The chip a pick inserts is labelled from that value by
 * `refChipLabel`, so taking `display` verbatim gave one folder two names — the
 * row said `desktop/`, the editor said `apps/desktop/`. On the fuzzy branch,
 * which ranks matches from anywhere in the tree, it was worse: every `index.ts`
 * in the repo came back as an identical row. Both ends derive from
 * `refChipLabel` now, and the last case in the first block asserts the row and
 * the real chip agree by construction rather than by inspection.
 *
 * DE-DUPLICATION. Walking a path is repetitive — Tab in, Backspace out, retype
 * — and every step used to be a fresh listing + rank on the backend. A repeat
 * must cost no round trip AND skip the 60ms debounce, without ever flipping the
 * spinner on.
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { refChipElement } from '@/app/chat/composer/rich-editor'
import { queryClient } from '@/lib/query-client'

import { classify, useAtCompletions } from './use-at-completions'
import type { CompletionEntry } from './use-live-completion-adapter'

/** A row exactly as `complete.path` emits it. */
const row = (text: string, display = '', meta = ''): CompletionEntry => ({ text, display, meta })

/** The gateway stub, recording the `word` each request asked for. */
function gatewayStub(items: CompletionEntry[] = [row('@folder:apps/desktop/', 'desktop/', 'dir')]) {
  const words: string[] = []

  const gateway = {
    request: vi.fn(async (_method: string, params: { word: string }) => {
      words.push(params.word)
      await new Promise(resolve => setTimeout(resolve, 40))

      return { items }
    })
  }

  return { gateway, words }
}

type Adapter = { current: { adapter: { search?: (query: string) => unknown }; loading: boolean } }

function setup(options: { cwd?: null | string; items?: CompletionEntry[]; sessionId?: null | string } = {}) {
  const { gateway, words } = gatewayStub(options.items)

  const { result, rerender } = renderHook(
    (props: { cwd: null | string; sessionId: null | string }) =>
      useAtCompletions({ gateway: gateway as never, sessionId: props.sessionId, cwd: props.cwd }),
    { initialProps: { cwd: options.cwd ?? '/repo', sessionId: options.sessionId ?? 's1' } }
  )

  return { rerender, result: result as Adapter, words }
}

/** Type a query and let the debounce + the round trip settle. */
async function search(result: Adapter, query: string) {
  act(() => void result.current.adapter.search?.(query))
  await act(async () => void (await vi.advanceTimersByTimeAsync(200)))
}

beforeEach(() => {
  vi.useFakeTimers()
  queryClient.clear()
})

afterEach(() => {
  vi.useRealTimers()
  queryClient.clear()
})

describe('one name per reference', () => {
  it('labels a folder row with its PATH, not the basename the gateway sent', () => {
    // The gateway's own words for this row: text carries the path, display the
    // basename. Trusting `display` is what produced two names for one folder.
    expect(classify(row('@folder:apps/desktop/', 'desktop/', 'dir')).display).toBe('apps/desktop/')
    expect(classify(row('@file:apps/desktop/src/main.tsx', 'main.tsx', 'apps/desktop/src')).display).toBe(
      'apps/desktop/src/main.tsx'
    )
  })

  it('keeps two same-named files apart in the fuzzy list', () => {
    // `@index` ranks matches from anywhere in the tree; both rows carried the
    // display `index.ts`, so the popover offered the same row twice.
    const labels = [row('@file:src/index.ts', 'index.ts', 'src'), row('@file:lib/index.ts', 'index.ts', 'lib')].map(
      entry => classify(entry).display
    )

    expect(labels).toEqual(['src/index.ts', 'lib/index.ts'])
    expect(new Set(labels).size).toBe(2)
  })

  it('reads a url as host + path on the row, as the chip does', () => {
    // The gateway sends no display for a url, so the old fallback was the whole
    // raw value.
    expect(classify(row('@url:https://github.com/NousResearch/hermes-agent/pull/74533')).display).toBe(
      'github.com/NousResearch/hermes-agent/pull/74533'
    )
  })

  it('leaves a starter and a simple ref alone', () => {
    // `@folder:` has no value to label, so the gateway's own display stands.
    expect(classify(row('@folder:', '@folder:', 'attach folder'))).toMatchObject({
      display: '@folder:',
      insertId: '',
      type: 'folder'
    })

    // `@diff` is not a `@kind:value` at all.
    expect(classify(row('@diff', '@diff', 'git diff'))).toMatchObject({
      display: '@diff',
      insertId: '@diff',
      type: 'simple'
    })
  })

  // The invariant itself, asserted through the REAL chip builder the pick path
  // uses (`replaceTriggerWithChip` → `refChipElement(kind, value)`), so the two
  // ends cannot drift without this failing.
  it.each([
    ['@folder:apps/desktop/', 'desktop/'],
    ['@file:apps/desktop/src/main.tsx', 'main.tsx'],
    ['@url:https://github.com/NousResearch/hermes-agent/pull/74533', '']
  ])('the row and the chip it inserts read the same for %s', (text, display) => {
    const classified = classify(row(text, display))
    const chip = refChipElement(classified.type, classified.insertId)

    expect(chip.textContent).toBe(classified.display)
  })
})

describe('the popover item', () => {
  it('carries the raw wire text and the insertable value, keyed uniquely', async () => {
    const { result } = setup({ items: [row('@folder:apps/desktop/', 'desktop/', 'dir')] })

    await search(result, 'apps/')

    const [item] = result.current.adapter.search?.('apps/') as {
      id: string
      description?: string
      label: string
      metadata: Record<string, string>
      type: string
    }[]

    expect(item).toMatchObject({
      id: '@folder:apps/desktop/|0',
      description: 'dir',
      label: 'apps/desktop/',
      type: 'folder'
    })
    // `insertId` is the value the chip is built from; `rawText` is what the
    // gateway said, kept so nothing downstream has to re-derive it.
    expect(item.metadata).toMatchObject({
      icon: 'folder',
      insertId: 'apps/desktop/',
      rawText: '@folder:apps/desktop/'
    })
  })

  it('offers the ref starters when the gateway answers with nothing, and when it fails', async () => {
    const { result: empty } = setup({ items: [] })

    await search(empty, 'fi')

    expect((empty.current.adapter.search?.('fi') as { label: string }[]).map(item => item.label)).toEqual(['@file:'])

    // A thrown request must fall back to the same static list rather than
    // leaving the popover blank.
    const failing = {
      request: vi.fn(async () => {
        throw new Error('gateway down')
      })
    }

    const { result } = renderHook(() =>
      useAtCompletions({ gateway: failing as never, sessionId: 's1', cwd: '/repo' })
    ) as { result: Adapter }

    await search(result, 'fol')

    expect((result.current.adapter.search?.('fol') as { label: string }[]).map(item => item.label)).toEqual([
      '@folder:'
    ])
  })

  it('asks for the keyword form once a bare starter is fully typed', async () => {
    const { result, words } = setup()

    await search(result, 'fi')
    await search(result, 'file')

    // `@fi` is a path prefix; `@file` is the keyword, and the backend only
    // lists a directory for `@file:`.
    expect(words).toEqual(['@fi', '@file:'])
  })
})

describe('de-duplication', () => {
  it('serves a repeated query with no round trip and no spinner', async () => {
    const { result, words } = setup()

    await search(result, 'apps/')
    expect(words.length).toBe(1)

    // Tab in, Backspace out, retype — every step used to be a fresh listing.
    for (const query of ['apps/desktop/', 'apps/', 'apps/desktop/', 'apps/']) {
      await search(result, query)
    }

    expect(words).toEqual(['@apps/', '@apps/desktop/'])
    expect(result.current.loading).toBe(false)
  })

  it('paints a cached query without waiting out the debounce', async () => {
    const { result, words } = setup()

    await search(result, 'apps/')
    expect(words.length).toBe(1)

    act(() => void result.current.adapter.search?.('apps/'))
    // Far less than the 60ms debounce: a cached answer resolves in a microtask,
    // so it must paint on its own without the timer, and never flip the spinner.
    await act(async () => void (await vi.advanceTimersByTimeAsync(1)))

    expect(result.current.loading).toBe(false)
    expect(words.length).toBe(1)
  })

  it('never serves another directory tree listing after the cwd moves', async () => {
    const { rerender, result, words } = setup({ cwd: '/repo' })

    await search(result, 'src/')
    expect(words.length).toBe(1)

    // Same query, different working directory: the cache key carries the cwd,
    // so this must go back to the gateway rather than reuse /repo's listing.
    rerender({ cwd: '/other', sessionId: 's1' })
    await search(result, 'src/')

    expect(words.length).toBe(2)
  })
})
