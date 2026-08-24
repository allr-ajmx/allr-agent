import { describe, expect, it } from 'vitest'

import { budgetForGroup, buildGroups, consolidationVerdict, firstVisibleGroupIndex, type MessageGroup } from './list'

// Signature rows are `${index}:${id}:${role}:${weight}` (see the useAuiState
// selector in list.tsx).
const signature = (rows: [string, string, number][]) =>
  rows.map(([id, role, weight], index) => `${index}:${id}:${role}:${weight}`).join('\n')

describe('buildGroups', () => {
  it('returns no groups for an empty signature', () => {
    expect(buildGroups('')).toEqual([])
  })

  it('groups a user message with the assistant turn(s) that follow it', () => {
    const groups = buildGroups(
      signature([
        ['u1', 'user', 1],
        ['a1', 'assistant', 4],
        ['a2', 'assistant', 2],
        ['u2', 'user', 1],
        ['a3', 'assistant', 3]
      ])
    )

    expect(groups).toEqual([
      { id: 'u1', indices: [0, 1, 2], kind: 'turn', weight: 7 },
      { id: 'u2', indices: [3, 4], kind: 'turn', weight: 4 }
    ])
  })

  it('keeps leading non-user messages as standalone groups', () => {
    const groups = buildGroups(
      signature([
        ['s1', 'system', 1],
        ['a0', 'assistant', 2],
        ['u1', 'user', 1],
        ['a1', 'assistant', 5]
      ])
    )

    expect(groups).toEqual([
      { id: 's1', index: 0, kind: 'standalone', weight: 1 },
      { id: 'a0', index: 1, kind: 'standalone', weight: 2 },
      { id: 'u1', indices: [2, 3], kind: 'turn', weight: 6 }
    ])
  })

  it('defaults a missing/zero weight to 1', () => {
    const groups = buildGroups('0:a:assistant:0')

    expect(groups).toEqual([{ id: 'a', index: 0, kind: 'standalone', weight: 1 }])
  })
})

describe('firstVisibleGroupIndex', () => {
  const group = (id: string, weight: number): MessageGroup => ({ id, index: 0, kind: 'standalone', weight })

  it('shows everything when total weight fits the budget', () => {
    const groups = [group('a', 10), group('b', 10), group('c', 10)]

    expect(firstVisibleGroupIndex(groups, 100)).toBe(0)
  })

  it('walks newest-first and hides everything before the turn that meets the budget', () => {
    const groups = [group('old', 50), group('mid', 30), group('new', 30)]

    // newest-first: 30 (new) < 60, +30 (mid) = 60 >= 60 → mid is the first
    // visible group, old is hidden.
    expect(firstVisibleGroupIndex(groups, 60)).toBe(1)
  })

  it('keeps whole turns intact — the turn that crosses the budget stays visible', () => {
    const groups = [group('old', 5), group('huge', 500)]

    expect(firstVisibleGroupIndex(groups, 60)).toBe(1)
  })

  it('returns groups.length for an empty list', () => {
    expect(firstVisibleGroupIndex([], 60)).toBe(0)
  })
})

describe('budgetForGroup', () => {
  const group = (id: string, weight: number): MessageGroup => ({ id, index: 0, kind: 'standalone', weight })
  const groups = [group('old', 50), group('mid', 30), group('new', 30)]

  it('asks for exactly the budget that makes a hidden turn the first visible one', () => {
    // The round trip is the property that matters: the rail raises the budget to
    // this and the turn it wants is mounted — not the one after it.
    for (let index = 0; index < groups.length; index++) {
      expect(firstVisibleGroupIndex(groups, budgetForGroup(groups, index))).toBe(index)
    }
  })

  it('asks for the whole transcript to reach the oldest turn', () => {
    expect(budgetForGroup(groups, 0)).toBe(110)
  })

  it('asks for nothing more than the newest turn to reach it', () => {
    expect(budgetForGroup(groups, 2)).toBe(30)
  })

  it('clamps an index below the list rather than reading off the end', () => {
    expect(budgetForGroup(groups, -5)).toBe(110)
  })

  it('asks for nothing on an empty list', () => {
    expect(budgetForGroup([], 0)).toBe(0)
  })
})

// The reveal gate (ALLR-32). Each case below is a way the transcript can LOOK
// settled while it is not — every one of them was reachable when the old settle
// loop gave up after 15 frames, and every one of them reads to a user as the
// transcript reflowing after it was shown.
describe('consolidationVerdict', () => {
  const settled = { elapsedMs: 100, pendingMedia: 0, rowsPending: false, sinceProgressMs: 20, stableFrames: 2 }

  it('reveals once nothing is pending and the height has held', () => {
    expect(consolidationVerdict(settled)).toBe('reveal')
  })

  it('waits while rows are still being mounted', () => {
    // The gap BETWEEN two backfill steps: nothing moved this frame, and a whole
    // page of transcript is still to come.
    expect(consolidationVerdict({ ...settled, rowsPending: true })).toBe('wait')
  })

  it('waits while media is still resolving', () => {
    // Twelve images in flight, each a one-line placeholder that becomes a
    // full-size image. The height is steady precisely because none has landed.
    expect(consolidationVerdict({ ...settled, pendingMedia: 12 })).toBe('wait')
  })

  it('waits on a single steady frame', () => {
    expect(consolidationVerdict({ ...settled, stableFrames: 1 })).toBe('wait')
  })

  it('keeps waiting while work is still ARRIVING, however long it takes', () => {
    // The first version capped consolidation at 900ms flat and revealed a chat
    // 40% assembled, with 545ms of forced layout still to come — the flicker
    // moved rather than went away. Elapsed time is not evidence that a
    // transcript has stopped coming.
    expect(consolidationVerdict({ ...settled, elapsedMs: 2_500, rowsPending: true, sinceProgressMs: 30 })).toBe('wait')
  })

  it('reveals when progress stalls', () => {
    // A gateway that stopped answering: media still pending, nothing changing.
    expect(consolidationVerdict({ ...settled, pendingMedia: 3, sinceProgressMs: 900 })).toBe('timeout')
  })

  it('reveals at the hard cap even while progress continues', () => {
    // A transcript resumed mid-stream grows forever; the placeholder must not.
    expect(consolidationVerdict({ ...settled, elapsedMs: 9_000, rowsPending: true, sinceProgressMs: 10 })).toBe(
      'timeout'
    )
  })

  it('prefers a real reveal to a timeout when both are true', () => {
    // Settled AND past a limit is a settled transcript, not a failure —
    // `deadline: 1` in the span means "shown before it was ready".
    expect(consolidationVerdict({ ...settled, elapsedMs: 9_000, sinceProgressMs: 5_000 })).toBe('reveal')
  })
})
