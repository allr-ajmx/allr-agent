/**
 * Floating tiles — the tree's non-tiling placement.
 *
 * `placement: 'floating'` opts a tile OUT of the layout tree: it never becomes
 * a track, never takes width from a zone, and never appears in a tab strip. The
 * tree renders it as a fixed card above itself, draggable by its header, with
 * position + collapse persisted per tile id. The geometry rules live in
 * floating-rect.ts.
 *
 * Ported from desktop `renderer/floating-panes.tsx`. Two universal changes:
 * it reads TILES (`useTiles` / `tileChrome`) rather than raw contributions,
 * and the reserved top chrome comes from the `--titlebar-height` CSS var —
 * universal has no `TITLEBAR_HEIGHT` constant, the same difference the pet's
 * roam-geometry carries.
 */

import { useStore } from '@nanostores/react'
import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef, useState } from 'react'

import { HUD_SURFACE } from '@/app/floating-hud'
import { Codicon } from '@/components/ui/codicon'
import { ContribBoundary } from '@/contrib/react/boundary'
import { readJson, writeJson } from '@/lib/storage'
import { cn } from '@/lib/utils'

import { useTiles } from '../../tile/registry'
import { type Tile, tileChrome, tileSizing } from '../../tile/types'
import { $hiddenTreePanes } from '../store'

import {
  anchoredRect,
  clampFloatingRect,
  FLOATING_PLACEMENT,
  floatingPx,
  type FloatingRect,
  type FloatingViewport,
  reflowRect
} from './floating-rect'

// `hermes.layout.*`, not desktop's `hermes.desktop.floatingPanes.v1` — this is
// a Tauri app, and the tree store already renamed its own keys that way. A new
// key has nothing to migrate, so it starts in the right namespace.
const POSITIONS_KEY = 'hermes.layout.floatingTiles.v1'

const DEFAULT_SIZE = { width: 240, height: 180 }

// Matches the pet's fallback; the var is authored in rem on the app shell.
const TITLEBAR_FALLBACK_PX = 34

interface StoredRect {
  x: number
  y: number
  collapsed?: boolean
}

const readStored = (): Record<string, StoredRect> => readJson<Record<string, StoredRect>>(POSITIONS_KEY) ?? {}

/** Reserved top chrome in px. Authored as a rem `--titlebar-height`, so resolve
 *  it against the root font size rather than parsing the number raw. */
function titlebarInsetPx(): number {
  if (typeof document === 'undefined') {
    return TITLEBAR_FALLBACK_PX
  }

  const root = getComputedStyle(document.documentElement)
  const raw = root.getPropertyValue('--titlebar-height').trim()

  if (raw.endsWith('rem')) {
    return (Number.parseFloat(raw) || 0) * (Number.parseFloat(root.fontSize) || 16)
  }

  return Number.parseFloat(raw) || TITLEBAR_FALLBACK_PX
}

const viewportNow = (): FloatingViewport => ({
  width: window.innerWidth,
  height: window.innerHeight,
  top: titlebarInsetPx()
})

function FloatingTile({ tile }: { tile: Tile }) {
  const anchor = tileChrome(tile).anchor ?? 'top-right'
  // Universal splits chrome from sizing (desktop had one flat blob), so the
  // card's dimensions come off `sizing` — the same `width`/`height` a tiling
  // tile uses to make its zone a fixed track.
  const sizing = tileSizing(tile)

  const size = {
    width: floatingPx(sizing.width, DEFAULT_SIZE.width),
    height: floatingPx(sizing.height, DEFAULT_SIZE.height)
  }

  const [rect, setRect] = useState<FloatingRect>(() => {
    const stored = readStored()[tile.id]
    const spawned = anchoredRect(anchor, size, viewportNow())

    return stored ? { ...spawned, x: stored.x, y: stored.y } : spawned
  })

  const [collapsed, setCollapsed] = useState(() => readStored()[tile.id]?.collapsed ?? false)

  const drag = useRef<{ x: number; y: number } | null>(null)
  const viewport = useRef<FloatingViewport>(viewportNow())

  const persist = useCallback(
    (next: FloatingRect, nextCollapsed: boolean) => {
      writeJson(POSITIONS_KEY, { ...readStored(), [tile.id]: { x: next.x, y: next.y, collapsed: nextCollapsed } })
    },
    [tile.id]
  )

  // Track the viewport so an edge-anchored card rides its edge on resize. The
  // previous-size read lives in the handler (not a useEffect body): it's window
  // geometry, not a mirrored reactive value.
  const handleResize = useCallback(() => {
    const next = viewportNow()

    setRect(current => reflowRect(current, anchor, viewport.current, next))
    viewport.current = next
  }, [anchor])

  useEffect(() => {
    window.addEventListener('resize', handleResize)

    return () => window.removeEventListener('resize', handleResize)
  }, [handleResize])

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest('[data-floating-no-drag]')) {
      return
    }

    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { x: event.clientX, y: event.clientY }
    event.preventDefault()
  }, [])

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const from = drag.current

    if (!from) {
      return
    }

    drag.current = { x: event.clientX, y: event.clientY }

    setRect(current =>
      clampFloatingRect(
        { ...current, x: current.x + event.clientX - from.x, y: current.y + event.clientY - from.y },
        viewport.current
      )
    )
  }, [])

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (!drag.current) {
        return
      }

      drag.current = null
      event.currentTarget.releasePointerCapture?.(event.pointerId)
      setRect(current => {
        persist(current, collapsed)

        return current
      })
    },
    [collapsed, persist]
  )

  const toggleCollapsed = () =>
    setCollapsed(current => {
      persist(rect, !current)

      return !current
    })

  return (
    <div
      className={cn('pointer-events-auto fixed z-45 flex flex-col overflow-hidden', HUD_SURFACE)}
      data-floating-tile={tile.id}
      style={{
        left: rect.x,
        top: rect.y,
        width: size.width,
        height: collapsed ? undefined : size.height
      }}
    >
      {/* Header IS the drag handle — the floating equivalent of a tab strip. */}
      <header
        className="flex shrink-0 cursor-grab items-center justify-between gap-2 px-2.5 py-1.5 text-[0.6875rem] text-(--ui-text-secondary) select-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        style={{ touchAction: 'none' }}
      >
        <span className="truncate font-medium">{tile.title}</span>
        <button
          className="rounded p-0.5 text-(--ui-text-quaternary) transition-colors hover:text-(--ui-text-primary)"
          data-floating-no-drag=""
          onClick={toggleCollapsed}
          type="button"
        >
          <Codicon name={collapsed ? 'chevron-down' : 'chevron-up'} size="0.75rem" />
        </button>
      </header>

      {!collapsed && (
        <div className="min-h-0 flex-1 overflow-auto">
          <ContribBoundary id={tile.id}>{tile.render()}</ContribBoundary>
        </div>
      )}
    </div>
  )
}

/** Every `placement: 'floating'` tile, rendered above the tree. */
export function FloatingTiles() {
  const tiles = useTiles()
  const hidden = useStore($hiddenTreePanes)

  // Reveal still applies: a floating tile's owner can hide it the same way it
  // hides a tiled one. Presence (dismissal) can't — a floating tile is never in
  // the tree to be dismissed FROM.
  const floating = tiles.filter(tile => tile.placement === FLOATING_PLACEMENT && !hidden.has(tile.id))

  if (floating.length === 0) {
    return null
  }

  return (
    <>
      {floating.map(tile => (
        <FloatingTile key={`${tile.source ?? 'core'}:${tile.id}`} tile={tile} />
      ))}
    </>
  )
}
