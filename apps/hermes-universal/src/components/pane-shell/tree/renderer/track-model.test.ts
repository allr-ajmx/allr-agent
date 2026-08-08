/**
 * The CASCADING FOLD predicate and the axis contract it feeds.
 *
 * Two claims are pinned here, and they are the whole safety story of the fold:
 *  - `subtreeFolded` SUBSUMES the old `group.minimized` check, so nothing that
 *    used to fold stops folding and nothing new folds by accident (a gone child
 *    neither counts nor blocks; an all-gone subtree stays a `collapsed`, not a
 *    fold);
 *  - a folded node is a 1.75rem strip ONLY along the split's own orientation.
 *    Report it fixed ACROSS that axis and an ancestor track collapses the whole
 *    row/column to a rail — the bug the axis branch exists to prevent.
 */

import { describe, expect, it } from 'vitest'

import { group, split } from '../model'

import { fixedTrackSize, MINIMIZED_TRACK, subtreeFolded, type TrackContext } from './track-model'

/** Panes are registered, sized-less and on screen unless listed in `gone`. */
const ctx = (gone: string[] = []): TrackContext => ({
  paneFor: id => ({ id, kind: 'test', title: id, render: () => null }),
  paneGone: id => gone.includes(id),
  overrides: {}
})

const min = (pane: string) => group([pane], { minimized: true })

describe('subtreeFolded', () => {
  it('is exactly `minimized` for a zone', () => {
    expect(subtreeFolded(min('files'), ctx())).toBe(true)
    expect(subtreeFolded(group(['files']), ctx())).toBe(false)
  })

  it('folds a split whose every visible zone is minimized', () => {
    expect(subtreeFolded(split('column', [min('files'), min('review'), min('terminal')]), ctx())).toBe(true)
  })

  it('is blocked by one open zone — including a header-hidden one', () => {
    expect(subtreeFolded(split('column', [min('files'), group(['terminal'])]), ctx())).toBe(false)
    expect(subtreeFolded(split('column', [min('files'), group(['terminal'], { headerHidden: true })]), ctx())).toBe(
      false
    )
  })

  it('ignores gone children — they neither count nor block', () => {
    // The open zone is off screen, so the remaining strip still folds.
    expect(subtreeFolded(split('column', [min('files'), group(['terminal'])]), ctx(['terminal']))).toBe(true)
  })

  it('is false when EVERYTHING is gone — that is a collapse, not a fold', () => {
    expect(subtreeFolded(split('column', [min('files'), group(['terminal'])]), ctx(['files', 'terminal']))).toBe(false)
  })

  it('cascades upward through nested splits', () => {
    expect(
      subtreeFolded(split('row', [min('sessions'), split('column', [min('files'), min('terminal')])]), ctx())
    ).toBe(true)
  })
})

// The contract is expressed by the PARENT split's child map (a node never
// reports its own strip size — the axis it folded on is its parent's), so
// every case here asks the parent.
describe('fixedTrackSize axis contract', () => {
  const foldedColumn = split('column', [min('files'), min('terminal')])

  it('sizes a fully-folded column as one strip along the row', () => {
    // Two strips side by side: 1.75rem each, so the folded COLUMN reported the
    // same track a plain minimized zone does.
    expect(fixedTrackSize(split('row', [min('sessions'), foldedColumn]), 'row', ctx())).toBe(
      `calc(${MINIMIZED_TRACK} + ${MINIMIZED_TRACK})`
    )
  })

  it('lets that strip stretch across the row — flex, not 1.75rem', () => {
    // Cross-axis the fixed children set the size; reporting 1.75rem here is
    // what used to collapse the whole row to a rail.
    expect(fixedTrackSize(split('row', [group(['workspace']), foldedColumn]), 'column', ctx())).toBeNull()
  })

  it('keeps the same contract for plain minimized zones', () => {
    expect(fixedTrackSize(min('files'), 'row', ctx())).toBe(MINIMIZED_TRACK)
    // Stacked strips still SUM along their own orientation…
    expect(fixedTrackSize(split('column', [min('files'), min('terminal')]), 'column', ctx())).toBe(
      `calc(${MINIMIZED_TRACK} + ${MINIMIZED_TRACK})`
    )
    // …and an open flex sibling still makes the run flex.
    expect(fixedTrackSize(split('column', [min('files'), group(['terminal'])]), 'column', ctx())).toBeNull()
  })
})
