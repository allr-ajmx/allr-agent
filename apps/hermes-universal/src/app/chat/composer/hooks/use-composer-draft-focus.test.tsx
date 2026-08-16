/**
 * Who gets the caret when a composer ARRIVES (MJXHRM-406).
 *
 * `focus.ts`'s two predicates are unit-tested next door; the effect that
 * composes them was not, and the effect is where the behaviour lives. It runs
 * on mount, on a session swap, and — the case this file is named for — on the
 * COLD START transition, because a freshly launched window mounts its composer
 * disabled while the gateway connects and only becomes typeable when `ready`
 * lands. Nothing else in the app hands the caret over at that moment.
 *
 * The three ways it can go wrong, all pinned below: never focusing at all (a
 * launched app you have to click into before typing), focusing when a tile
 * mounts late and stealing the keystrokes of the chat the user is actually in
 * (MJXHRM-6), and focusing over an editor the user is already inside.
 */

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type ComposerState = { text: string }

const composerState: ComposerState = { text: '' }

const setText = vi.fn((value: string) => {
  composerState.text = value
})

// Stable identities, as the real hooks have: a fresh object per render would
// re-run every effect keyed on them (including the one that persists the draft
// on the way out) and the harness would be testing its own mock.
vi.mock('@assistant-ui/react', () => {
  const aui = { composer: () => ({ setText }) }
  const composerRuntime = { getState: () => composerState, subscribe: () => () => undefined }

  return {
    useAui: () => aui,
    useComposerRuntime: () => composerRuntime,
    useAuiState: (selector: (state: unknown) => unknown) => selector({ composer: { text: composerState.text } })
  }
})

const { getActiveComposer, markActiveComposer, requestComposerFocus } = await import('../focus')
const { RICH_INPUT_SLOT } = await import('../rich-editor')
const { ComposerScopeProvider, MAIN_COMPOSER_SCOPE } = await import('../scope')
const { useComposerDraft } = await import('./use-composer-draft')

function Composer({ inputDisabled }: { inputDisabled: boolean }) {
  const { editorRef } = useComposerDraft({
    activeQueueSessionKey: 's1',
    focusKey: 's1',
    inputDisabled,
    queueEditRef: { current: null },
    sessionId: 's1'
  })

  // The real editor root carries `data-slot={RICH_INPUT_SLOT}`; without it
  // `composerPlainText` treats the root as a block and appends a newline the
  // live composer never sees.
  return (
    <div
      contentEditable
      data-slot={RICH_INPUT_SLOT}
      data-testid="editor"
      ref={editorRef}
      suppressContentEditableWarning
      tabIndex={0}
    />
  )
}

/** The same composer under a session tile's scope (`tile:<id>`), which is what
 *  `openSessionTile` mounts once its async resume lands. */
function TileComposer({ id }: { id: string }) {
  return (
    <ComposerScopeProvider value={{ ...MAIN_COMPOSER_SCOPE, popoutAllowed: false, target: `tile:${id}` }}>
      <Composer inputDisabled={false} />
    </ComposerScopeProvider>
  )
}

const editor = () => document.querySelector<HTMLElement>('[data-testid="editor"]')

beforeEach(() => {
  composerState.text = ''
  setText.mockClear()
  // `activeTarget` is module state; a case that leaves a claim behind would
  // otherwise decide the next one. 'main' is the cold-start value.
  markActiveComposer('main')
})

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

describe('cold start', () => {
  it('takes the caret as soon as the composer is typeable', () => {
    expect(getActiveComposer()).toBe('main')

    render(<Composer inputDisabled={false} />)

    expect(document.activeElement).toBe(editor())
  })

  it('waits out the connecting window, then claims the caret when the gateway lands', () => {
    // A launched window mounts the composer DISABLED — there is no session to
    // type into until the socket is up.
    const view = render(<Composer inputDisabled />)

    expect(document.activeElement).not.toBe(editor())

    // `ready`. Nothing else focuses the composer at this moment, so without
    // this the user has to click into a freshly launched app before typing.
    view.rerender(<Composer inputDisabled={false} />)

    expect(document.activeElement).toBe(editor())
  })
})

describe('a composer arriving late', () => {
  it('does not take the caret from the chat that owns it (MJXHRM-6)', () => {
    // ⌘T claimed `main` before the tile's resume came home.
    render(<TileComposer id="abc" />)

    expect(getActiveComposer()).toBe('main')
    expect(document.activeElement).not.toBe(editor())
  })

  it('does take it when the focused zone already names this tile', () => {
    // `focusDraftTile` claims the zone as the tab is created, i.e. BEFORE the
    // mount — which is why a fresh tab still autofocuses.
    markActiveComposer('tile:abc')

    render(<TileComposer id="abc" />)

    expect(document.activeElement).toBe(editor())
  })

  it('leaves an editor the user is already inside alone', () => {
    // The edit composer inside this same chat: same target, live caret.
    const other = document.createElement('input')

    document.body.append(other)
    other.focus()

    render(<Composer inputDisabled={false} />)

    expect(document.activeElement).toBe(other)
  })
})

describe('an explicit request over the focus bus', () => {
  it('wins even where arriving would not have', async () => {
    const other = document.createElement('input')

    document.body.append(other)
    other.focus()

    render(<Composer inputDisabled={false} />)
    expect(document.activeElement).toBe(other)

    // Someone saying "put the caret here" — a panel handing focus back, a soft
    // Enter — is not a component announcing its arrival, so no guard applies.
    requestComposerFocus('main')
    // `dispatch` defers to a macrotask so click/keydown handlers settle first.
    await act(async () => void (await new Promise(resolve => window.setTimeout(resolve, 0))))

    expect(document.activeElement).toBe(editor())
  })

  it('appends a type-to-focus character rather than only focusing', async () => {
    render(<Composer inputDisabled={false} />)

    requestComposerFocus('main', { typeChar: 'h' })
    await act(async () => void (await new Promise(resolve => window.setTimeout(resolve, 0))))

    expect(composerState.text).toBe('h')
    expect(document.activeElement).toBe(editor())
  })

  it('is ignored by a composer it was not addressed to', async () => {
    render(<TileComposer id="abc" />)

    requestComposerFocus('main')
    await act(async () => void (await new Promise(resolve => window.setTimeout(resolve, 0))))

    expect(document.activeElement).not.toBe(editor())
  })
})
