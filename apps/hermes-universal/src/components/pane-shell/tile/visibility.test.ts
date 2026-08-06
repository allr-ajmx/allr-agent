/**
 * The one on-screen rule (MJXHRM-166).
 *
 * The headline test is the last one: it re-derives the TWO predicates this
 * replaced and asserts the resolver agrees with both across the entire state
 * space. That is the whole claim of this step — behaviour-preserving by
 * construction — checked rather than asserted in a commit message.
 */

import { describe, expect, it } from 'vitest'

import type { Tile } from './types'
import { type TileContext, tileGone, tileShown, tileVisibility } from './visibility'

const tile = (id: string, collapsible = false): Tile => ({
  id,
  kind: 'test',
  title: id,
  render: () => null,
  chrome: collapsible ? { collapsible: true } : undefined
})

const ctx = (over: Partial<TileContext> = {}): TileContext => ({
  editMode: false,
  hidden: new Set(),
  narrow: false,
  tileFor: id => (id === 'gone' ? undefined : tile(id, id === 'side')),
  ...over
})

describe('tileVisibility', () => {
  it('visible when registered, revealed and not enclosed', () => {
    expect(tileVisibility('files', ctx())).toBe('visible')
  })

  it('absent when nothing registered it — a plugin that has not loaded', () => {
    expect(tileVisibility('gone', ctx())).toBe('absent')
  })

  it('hidden when its owning store toggled it off', () => {
    expect(tileVisibility('review', ctx({ hidden: new Set(['review']) }))).toBe('hidden')
  })

  it('enclosed when a collapsible tile leaves the grid on a narrow viewport', () => {
    expect(tileVisibility('side', ctx({ narrow: true }))).toBe('enclosed')
  })
})

describe('edit mode', () => {
  it('reinstates a hidden tile so it can be rearranged', () => {
    const hidden = new Set(['review'])

    expect(tileVisibility('review', ctx({ hidden }))).toBe('hidden')
    expect(tileVisibility('review', ctx({ editMode: true, hidden }))).toBe('visible')
  })

  it('does NOT reinstate an enclosed one — at that width there is no slot to drag it into', () => {
    expect(tileVisibility('side', ctx({ editMode: true, narrow: true }))).toBe('enclosed')
  })

  it('cannot resurrect an absent tile', () => {
    expect(tileVisibility('gone', ctx({ editMode: true }))).toBe('absent')
  })
})

describe('tileShown / tileGone', () => {
  it('stay exact negations across every outcome', () => {
    for (const id of ['files', 'gone', 'review', 'side']) {
      for (const editMode of [false, true]) {
        for (const narrow of [false, true]) {
          for (const hidden of [new Set<string>(), new Set([id])]) {
            const c = ctx({ editMode, hidden, narrow })

            expect(tileGone(id, c)).toBe(!tileShown(id, c))
          }
        }
      }
    }
  })
})

describe('agreement with the predicates it replaced', () => {
  // Verbatim from tree-group.tsx and tree-split.tsx before this step.
  const paneShown = (id: string, c: TileContext) =>
    Boolean(c.tileFor(id)) && (c.editMode || !c.hidden.has(id)) && !(c.narrow && c.tileFor(id)?.chrome?.collapsible)

  const paneGone = (id: string, c: TileContext) =>
    !c.tileFor(id) || (!c.editMode && c.hidden.has(id)) || (c.narrow && Boolean(c.tileFor(id)?.chrome?.collapsible))

  it('matches both, for every combination of registered / hidden / narrow / editMode', () => {
    for (const id of ['files', 'gone', 'review', 'side']) {
      for (const editMode of [false, true]) {
        for (const narrow of [false, true]) {
          for (const hidden of [new Set<string>(), new Set([id])]) {
            const c = ctx({ editMode, hidden, narrow })

            expect(tileShown(id, c)).toBe(Boolean(paneShown(id, c)))
            expect(tileGone(id, c)).toBe(paneGone(id, c))
          }
        }
      }
    }
  })
})
