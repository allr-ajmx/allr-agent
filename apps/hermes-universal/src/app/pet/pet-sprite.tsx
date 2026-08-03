import { useEffect, useRef } from 'react'

import { useStore } from '@/store/atom'
import { $petInfo, $petState, type PetInfo, type PetState } from '@/store/pet'

const DEFAULT_FRAME_W = 192
const DEFAULT_FRAME_H = 208
const DEFAULT_FRAMES = 6
const DEFAULT_LOOP_MS = 1100
const DEFAULT_SCALE = 0.33

const DEFAULT_ROWS = [
  'idle',
  'running-right',
  'running-left',
  'waving',
  'jumping',
  'failed',
  'waiting',
  'running',
  'review'
]

// A PetState resolves to the first of these row names present in the sheet, so
// both the legacy (`wave`/`jump`/`run`) and Codex (`waving`/`jumping`/`running`)
// row names work. (Ported from desktop pet-sprite.tsx.)
const STATE_ALIASES: Record<PetState, string[]> = {
  idle: ['idle'],
  wave: ['wave', 'waving'],
  jump: ['jump', 'jumping'],
  run: ['run', 'running'],
  failed: ['failed'],
  review: ['review'],
  waiting: ['waiting']
}

// Reverse map: which PetState a concrete row name belongs to (for `rowOverride`
// frame-count fallback).
const ROW_TO_STATE: Record<string, PetState> = {
  idle: 'idle',
  wave: 'wave',
  waving: 'wave',
  jump: 'jump',
  jumping: 'jump',
  run: 'run',
  running: 'run',
  'running-right': 'run',
  'running-left': 'run',
  failed: 'failed',
  review: 'review',
  waiting: 'waiting'
}

/**
 * Pick the running row + mirror for a horizontal travel direction.
 *
 * The codex spritesheets' dedicated `running-left`/`running-right` rows are, in
 * practice, drawn facing the OPPOSITE of their name relative to travel here — so
 * moving right uses the `running-left` row (its art faces right) and vice-versa
 * (verified against the observed pet; this is the inverse of the desktop's
 * name=facing assumption). A pet without those rows falls back to the in-place
 * run row (faces left by convention), so rightward travel is mirrored; returns
 * no `row` there so the caller lets the normal run row resolve it.
 */
export function roamWalkRow(dir: -1 | 0 | 1, stateRows?: string[]): { row?: string; mirror: boolean } {
  if (dir === 0) {
    return { mirror: false }
  }

  const rows = stateRows ?? DEFAULT_ROWS
  const hasLeft = rows.includes('running-left')
  const hasRight = rows.includes('running-right')

  if (dir > 0) {
    // Moving right.
    if (hasLeft) {
      return { mirror: true, row: 'running-left' }
    }

    if (hasRight) {
      return { mirror: false, row: 'running-right' }
    }

    return { mirror: false }
  }

  // Moving left.
  if (hasRight) {
    return { mirror: true, row: 'running-right' }
  }

  if (hasLeft) {
    return { mirror: false, row: 'running-left' }
  }

  return { mirror: true }
}

// Canvas renderer for a petdex spritesheet (adapted from desktop pet-sprite.tsx).
// Draws the row matching the live `$petState` (idle / run / review / waiting /
// wave / failed / jump) — or a forced `stateOverride` (preview surfaces) or
// `rowOverride` (a concrete row name, e.g. `running-right`, used by the roam
// wander) — stepping frames across loopMs. State is read via a subscription, not
// a prop, so the frequent activity-driven changes during a turn update the
// canvas inside its RAF loop WITHOUT a React re-render.
export function PetSprite({
  stateOverride,
  zoom = 1,
  info: infoProp,
  rowOverride
}: {
  stateOverride?: PetState
  zoom?: number
  info?: PetInfo
  rowOverride?: string
}) {
  const stored = useStore($petInfo)
  const info = infoProp ?? stored
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const overrideRef = useRef(stateOverride)
  overrideRef.current = stateOverride
  const rowOverrideRef = useRef(rowOverride)
  rowOverrideRef.current = rowOverride

  const enabled = info.enabled && Boolean(info.spritesheetBase64)

  useEffect(() => {
    const canvas = canvasRef.current

    if (!canvas || !enabled || !info.spritesheetBase64) {
      return
    }

    const ctx = canvas.getContext('2d')

    if (!ctx) {
      return
    }

    const frameW = info.frameW ?? DEFAULT_FRAME_W
    const frameH = info.frameH ?? DEFAULT_FRAME_H
    const loopMs = info.loopMs ?? DEFAULT_LOOP_MS
    const scale = (info.scale ?? DEFAULT_SCALE) * zoom
    const frames = info.framesPerState ?? DEFAULT_FRAMES
    const framesByState = info.framesByState
    const framesByRow = info.framesByRow
    const rows = info.stateRows ?? DEFAULT_ROWS
    const drawW = Math.max(1, Math.round(frameW * scale))
    const drawH = Math.max(1, Math.round(frameH * scale))
    canvas.width = drawW
    canvas.height = drawH

    const rowIndexForState = (s: PetState): number => {
      for (const key of STATE_ALIASES[s] ?? [s]) {
        const idx = rows.indexOf(key)

        if (idx >= 0) {
          return idx
        }
      }

      return 0
    }

    // Resolve a state to its row + real frame count; a state with no real frames
    // (ragged sheet, empty row) falls back to idle rather than flashing blank.
    const resolve = (s: PetState): { row: number; count: number } => {
      const real = framesByState?.[s] ?? frames

      if (real > 0) {
        return { row: rowIndexForState(s), count: real }
      }

      return { row: rowIndexForState('idle'), count: Math.max(1, framesByState?.idle ?? frames) }
    }

    const resolveRow = (rowName: string): { row: number; count: number } => {
      const row = rows.indexOf(rowName)
      const state = ROW_TO_STATE[rowName]

      const count = Math.max(
        1,
        framesByRow?.[rowName] ?? framesByState?.[rowName] ?? (state ? framesByState?.[state] : 0) ?? frames
      )

      return { row: row >= 0 ? row : rowIndexForState(state ?? 'idle'), count }
    }

    // Track state via subscription, not a prop — no re-render on activity ticks.
    let liveState: PetState = $petState.get()

    const unsubState = $petState.listen(next => {
      liveState = next
    })

    const img = new Image()
    img.src = `data:${info.mime ?? 'image/webp'};base64,${info.spritesheetBase64}`

    let raf = 0
    let frame = 0
    let last = performance.now()
    let activeRow = -1
    let activeCount = -1

    const draw = (now: number) => {
      // Priority: a forced roam row (running-left/right) > a preview override >
      // the live activity/roam state.
      const forcedRow = rowOverrideRef.current

      const { row: index, count } = forcedRow ? resolveRow(forcedRow) : resolve(overrideRef.current ?? liveState)

      if (index !== activeRow || count !== activeCount) {
        activeRow = index
        activeCount = count
        frame = 0
        last = now
      }

      if (now - last >= loopMs / count) {
        frame = (frame + 1) % count
        last = now
      }

      frame %= count

      ctx.clearRect(0, 0, drawW, drawH)

      if (img.complete && img.naturalWidth > 0) {
        ctx.imageSmoothingEnabled = false
        ctx.drawImage(img, frame * frameW, index * frameH, frameW, frameH, 0, 0, drawW, drawH)
      }

      raf = requestAnimationFrame(draw)
    }

    raf = requestAnimationFrame(draw)

    return () => {
      cancelAnimationFrame(raf)
      unsubState()
    }
  }, [
    enabled,
    info.spritesheetBase64,
    info.spritesheetRevision,
    info.mime,
    info.frameW,
    info.frameH,
    info.loopMs,
    info.scale,
    info.framesPerState,
    info.stateRows,
    info.framesByState,
    info.framesByRow,
    zoom
  ])

  if (!enabled) {
    return null
  }

  return <canvas className="[image-rendering:pixelated]" ref={canvasRef} />
}
