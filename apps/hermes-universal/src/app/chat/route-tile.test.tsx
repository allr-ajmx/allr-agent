/**
 * Route (page) tiles: `$routeTiles` mirrors into `panes` contributions, a tile
 * resolves its page through the `routes` area (core and plugin pages alike), and
 * closing it takes the pane with it.
 */

import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ROUTES_AREA } from '@/app/routes'
import { $panesWithCloser } from '@/components/pane-shell/tree/store'
import { registry } from '@/contrib/registry'
import { $routeTiles, closeRouteTile, openRouteTile } from '@/store/route-tiles'

import { watchRouteTiles } from './route-tile'

const disposers: Array<() => void> = []

const paneFor = (path: string) => registry.getArea('panes').find(c => c.id === `route-tile:${path}`)

beforeEach(() => {
  watchRouteTiles()
})

afterEach(() => {
  for (const tile of $routeTiles.get()) {
    closeRouteTile(tile.path)
  }

  while (disposers.length) {
    disposers.pop()?.()
  }
})

describe('route tiles', () => {
  it('registers a pane for an open tile and drops it on close', () => {
    openRouteTile('/kanban')

    expect(paneFor('/kanban')).toBeTruthy()

    closeRouteTile('/kanban')

    expect(paneFor('/kanban')).toBeUndefined()
  })

  // MJXHRM-390. The mirror registered a pane closer per tile and never handed it
  // back: `paneClosers` — and `$panesWithCloser`, rebuilt from its keys — grew by
  // one entry for every tab ever opened, each pinning a closure over a tile that
  // is gone. Closing has to release what opening took.
  it('hands the pane closer back when the tile goes', () => {
    openRouteTile('/kanban')

    expect($panesWithCloser.get().has('route-tile:/kanban')).toBe(true)

    closeRouteTile('/kanban')

    expect($panesWithCloser.get().has('route-tile:/kanban')).toBe(false)
  })

  it('titles the tab from the page contribution, humanizing an untitled path', () => {
    disposers.push(
      registry.register({
        area: ROUTES_AREA,
        data: { path: '/kanban' },
        id: 'demo:kanban',
        render: () => null,
        source: 'plugin:demo',
        title: 'Kanban board'
      })
    )

    openRouteTile('/kanban')
    openRouteTile('/my-atlas')

    expect(paneFor('/kanban')?.title).toBe('Kanban board')
    expect(paneFor('/my-atlas')?.title).toBe('My Atlas')
  })

  it('renders the contributed page inside the tile', () => {
    disposers.push(
      registry.register({
        area: ROUTES_AREA,
        data: { path: '/kanban' },
        id: 'demo:kanban',
        render: () => <div data-testid="board" />,
        source: 'plugin:demo'
      })
    )

    openRouteTile('/kanban')
    render(<>{paneFor('/kanban')?.render?.()}</>)

    expect(screen.getByTestId('board')).toBeInTheDocument()
  })

  it('says so rather than blanking when the tile outlives its page', () => {
    openRouteTile('/gone')
    render(<>{paneFor('/gone')?.render?.()}</>)

    expect(screen.getByText(/no page at \/gone/)).toBeInTheDocument()
  })
})
