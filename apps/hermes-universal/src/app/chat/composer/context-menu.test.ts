import { describe, expect, it, vi } from 'vitest'

import { attachRoute } from './context-menu'

// `Files…` / `Folder…` fan out to Local vs Remote — but only when both sides are
// real. The composer withholds the LOCAL folder pick off a local-mode gateway
// (a local path is not the folder the backend would resolve), and a two-item
// choice with one item permanently greyed out is a worse answer than no choice:
// the row must just do the one thing that works.
describe('attachRoute', () => {
  const local = vi.fn()
  const remote = vi.fn()

  it('fans out when both picks are available', () => {
    expect(attachRoute(local, remote)).toEqual({ kind: 'fan-out' })
  })

  it('runs the remote pick directly when there is no local one', () => {
    const route = attachRoute(undefined, remote)

    expect(route).toEqual({ kind: 'run', run: remote })
  })

  it('runs the local pick directly when there is no remote one', () => {
    const route = attachRoute(local, undefined)

    expect(route).toEqual({ kind: 'run', run: local })
  })

  it('reports nothing to do when neither pick exists', () => {
    expect(attachRoute(undefined, undefined)).toEqual({ kind: 'none' })
  })
})
