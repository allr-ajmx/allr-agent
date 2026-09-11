import { describe, expect, it } from 'vitest'

import { reuseUnchanged } from './structural-share'

describe('reuseUnchanged', () => {
  it('returns the previous reference when the snapshot is content-identical', () => {
    const previous = [{ id: 'a', title: 'one' }]
    const incoming = [{ id: 'a', title: 'one' }]

    // Not just deep-equal: the SAME array, which is what makes nanostores skip
    // the publish and React skip the re-render entirely.
    expect(reuseUnchanged(previous, incoming)).toBe(previous)
  })

  it('reuses every row that did not change when one row did', () => {
    const previous = [
      { id: 'a', last_active: 1 },
      { id: 'b', last_active: 2 },
      { id: 'c', last_active: 3 }
    ]

    const incoming = [
      { id: 'a', last_active: 1 },
      { id: 'b', last_active: 99 },
      { id: 'c', last_active: 3 }
    ]

    const shared = reuseUnchanged(previous, incoming)

    expect(shared).not.toBe(previous)
    expect(shared[0]).toBe(previous[0])
    expect(shared[1]).toBe(incoming[1])
    expect(shared[2]).toBe(previous[2])
  })

  it('matches by id, so a reorder does not cost the moved rows their identity', () => {
    // Exactly what the recents list does when a session gets a message: it jumps
    // to the head and shifts everything below it. Index-aligned sharing would
    // report all three changed.
    const previous = [
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' },
      { id: 'c', title: 'C' }
    ]

    const incoming = [
      { id: 'c', title: 'C' },
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' }
    ]

    const shared = reuseUnchanged(previous, incoming)

    expect(shared[0]).toBe(previous[2])
    expect(shared[1]).toBe(previous[0])
    expect(shared[2]).toBe(previous[1])
  })

  it('keeps the result structurally equal to the incoming snapshot', () => {
    const previous = [{ id: 'a', title: 'old' }]
    const incoming = [
      { id: 'a', title: 'new' },
      { id: 'b', title: 'added' }
    ]

    expect(reuseUnchanged(previous, incoming)).toEqual(incoming)
  })

  it('does not reuse a row whose value changed to a falsy one', () => {
    const previous = [{ id: 'a', title: 'named' }]
    const incoming = [{ id: 'a', title: null }]

    expect(reuseUnchanged(previous, incoming)[0]).not.toBe(previous[0])
    expect(reuseUnchanged(previous, incoming)[0].title).toBeNull()
  })

  it('treats a differing key SET as a change even when the shared values match', () => {
    // `{a: 1}` and `{a: 1, b: undefined}` spread differently, so they are not
    // interchangeable as props.
    const previous = { id: 'a', title: 'x' }
    const incoming = { id: 'a', title: 'x', archived: undefined }

    expect(reuseUnchanged(previous, incoming)).not.toBe(previous)
    expect(Object.hasOwn(reuseUnchanged(previous, incoming), 'archived')).toBe(true)
  })

  it('shares nested lanes, so an unchanged project tree comes back untouched', () => {
    const previous = [
      {
        id: 'p1',
        repos: [{ id: 'r1', groups: [{ id: 'g1', sessions: [{ id: 's1', title: 'chat' }] }] }]
      }
    ]

    const incoming = structuredClone(previous)

    expect(reuseUnchanged(previous, incoming)).toBe(previous)
  })

  it('rebuilds only the branch of the tree that moved', () => {
    const previous = [
      { id: 'p1', repos: [{ id: 'r1', sessions: [{ id: 's1', title: 'chat' }] }] },
      { id: 'p2', repos: [{ id: 'r2', sessions: [{ id: 's2', title: 'other' }] }] }
    ]

    const incoming = structuredClone(previous)
    incoming[1].repos[0].sessions[0].title = 'renamed'

    const shared = reuseUnchanged(previous, incoming)

    expect(shared[0]).toBe(previous[0])
    expect(shared[1]).not.toBe(previous[1])
    // The sibling repo/session objects under the changed project are shared too
    // where they did not move — only the spine up to the change is rebuilt.
    expect(shared[1].repos[0].sessions[0]).not.toBe(previous[1].repos[0].sessions[0])
  })

  it('handles a null previous, a null incoming and mismatched shapes', () => {
    expect(reuseUnchanged(null, [{ id: 'a' }])).toEqual([{ id: 'a' }])
    expect(reuseUnchanged([{ id: 'a' }], null)).toBeNull()
    expect(reuseUnchanged({ id: 'a' }, [{ id: 'a' }])).toEqual([{ id: 'a' }])
    expect(reuseUnchanged([{ id: 'a' }], 'text')).toBe('text')
  })

  it('shares positionally for elements with no id', () => {
    const previous = [{ path: '/a' }, { path: '/b' }]
    const incoming = [{ path: '/a' }, { path: '/c' }]

    const shared = reuseUnchanged(previous, incoming)

    expect(shared[0]).toBe(previous[0])
    expect(shared[1]).toBe(incoming[1])
  })

  it('passes non-plain objects through rather than claiming they are equal', () => {
    // A Date with the same instant is NOT the same object; reporting it shared
    // would hand a memo a stale reference. Nothing in the sidebar's payloads is
    // a Date today — this pins the conservative branch so it stays that way.
    const previous = { at: new Date(0) }
    const incoming = { at: new Date(0) }

    expect(reuseUnchanged(previous, incoming).at).toBe(incoming.at)
    expect(reuseUnchanged(previous, incoming)).not.toBe(previous)
  })

  it('never mutates either argument', () => {
    const previous = [{ id: 'a', title: 'old' }]
    const incoming = [{ id: 'a', title: 'new' }]
    const previousSnapshot = structuredClone(previous)
    const incomingSnapshot = structuredClone(incoming)

    reuseUnchanged(previous, incoming)

    expect(previous).toEqual(previousSnapshot)
    expect(incoming).toEqual(incomingSnapshot)
  })
})
