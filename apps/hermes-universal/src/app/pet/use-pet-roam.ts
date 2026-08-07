import { type RefObject, useEffect } from 'react'

import { $petMotion, $petRoamDir, $petRoamWall, type PetMotion } from '@/store/pet'

import { chooseMove, dwellMs, PAUSE_DWELL, pickStrollTarget } from './roam-behavior'
import { overlaySurface, snapshotSurfaces, walkBox } from './roam-geometry'
import {
  type Axis,
  coordOn,
  cornerNeighbour,
  gravitySign,
  isRestingOn,
  normalAxis,
  resolveSurface,
  restCoord,
  spansOverlap,
  type Surface,
  SURFACE_EPS,
  tangentAxis,
  type Wall
} from './wall-geometry'

// Originally ported from apps/desktop/src/components/pet/use-pet-roam.ts. The
// physics is no longer floor-only: every integration runs along the current
// surface's NORMAL axis and every walk along its TANGENT, so the same state
// machine drives a pet strolling the bottom of the window and one climbing the
// right-hand edge of a phone. Which walls exist is the caller's choice — with
// `walls: false` this reduces to exactly the desktop behaviour.

interface Point {
  x: number
  y: number
}

// Foot-sync: advance this many body-widths per animation loop so the walk reads
// as steps, not a glide. Actual px/s is derived from the sprite's loop duration
// and on-screen size (see `walkSpeedPxS`).
const STRIDE_PER_LOOP = 0.8
// Acceleration toward the current surface — fast enough to read as a drop.
const GRAVITY_PX_S2 = 5200
// Time to spring up onto a higher ledge.
const JUMP_DUR_MS = 460
// Tiny settle after a drag release before the pet re-plans (and usually falls),
// so dropping it in mid-air snaps down promptly instead of hanging for a beat.
const DROP_SETTLE_MS = 90
// Arrived at a walk target.
const ARRIVE_EPS = 1.5
// Cap dt so a backgrounded/throttled tab can't teleport the pet on resume.
const MAX_DT_S = 0.05
// How close to a span's end counts as having reached it, for turning a corner.
const CORNER_EPS = 2
// How far around the corner to land. Must exceed CORNER_EPS, or the pet arrives
// already "at the end" of the new surface and turns straight back.
const CORNER_STEP_IN_PX = 8

type Phase = 'pause' | 'walk' | 'fall' | 'jump'

const rand = (min: number, max: number): number => min + Math.random() * (max - min)
const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3
const signDir = (n: number): -1 | 0 | 1 => (n > 0 ? 1 : n < 0 ? -1 : 0)

const writeCoord = (point: Point, axis: Axis, value: number): void => {
  if (axis === 'x') {
    point.x = value
  } else {
    point.y = value
  }
}

interface PetRoamOptions {
  /** Run the wander loop (roam opt-in + pet active + agent at rest). */
  enabled: boolean
  containerRef: RefObject<HTMLDivElement | null>
  /** True while the user is dragging — the loop yields so it never fights a drag. */
  isInteracting: () => boolean
  petW: number
  petH: number
  /** Sprite animation loop duration (ms) — paces the walk to the leg cadence. */
  loopMs: number
  /** A full-screen route overlay (settings/…) is up: patrol its base. */
  overlayOpen: boolean
  /** Walk all four edges rather than only the floor, and inset the walk area by
   *  the safe area + keyboard. Both are the phone's shape, not the desktop's. */
  mobile: boolean
  /** Persist the resting position back to React state when the loop settles. */
  commit: (point: Point) => void
}

/**
 * Drive the floating pet's wander as a platformer state machine: it loafs, then
 * walks along surfaces, springs up onto higher ones, and drops off them —
 * instead of drifting through empty space. Walkable surfaces come from
 * `roam-geometry` (re-measured from the live DOM every beat), the orientation
 * maths from `wall-geometry`, and the beat-to-beat choices from
 * `roam-behavior`; this hook owns only the physics and the DOM writes.
 *
 * Movement mutates `el.style.left/top` directly each frame — like the drag
 * handler — so a steady wander triggers no React re-renders. State is only
 * committed (via `commit`) when the pet settles. Three signals publish the
 * wander: `$petMotion` (`run`/`jump`) flips the sprite pose, `$petRoamDir`
 * (-1/0/1) picks the directional run row + mirror, and `$petRoamWall` rotates
 * the sprite so its feet stay against whatever it is standing on.
 */
export function usePetRoam({
  enabled,
  containerRef,
  isInteracting,
  petW,
  petH,
  loopMs,
  overlayOpen,
  mobile,
  commit
}: PetRoamOptions): void {
  useEffect(() => {
    if (!enabled) {
      $petMotion.set(null)
      $petRoamDir.set(0)

      return
    }

    const el = containerRef.current

    if (!el) {
      return
    }

    // Pace the stride to the sprite: one body-width per animation loop.
    const walkSpeedPxS = (petW * STRIDE_PER_LOOP) / (loopMs / 1000)

    // Seed from the live DOM rect so we resume from wherever the pet actually is
    // (after a drag, reclamp, or activity pause) rather than a stale closure.
    const rect = el.getBoundingClientRect()
    const cur: Point = { x: rect.left, y: rect.top }

    let phase: Phase = 'pause'
    let pauseUntil = performance.now() + rand(400, 1200)
    let last = performance.now()
    let raf = 0
    let paused = false

    let walkTarget = cur.x
    let curSurface: null | Surface = null
    let targetSurface: null | Surface = null
    // When set, the current walk is the approach run before a hop to this surface.
    let pendingHop: null | Surface = null
    // Fall / jump integrators, both along the target surface's normal axis.
    let fallVel = 0
    let jumpFrom = 0
    let jumpElapsed = 0

    const surfacesNow = (): Surface[] =>
      overlayOpen ? [overlaySurface(petW)] : snapshotSurfaces(petW, petH, { safeArea: mobile, walls: mobile })

    const applyDom = () => {
      el.style.left = `${cur.x}px`
      el.style.top = `${cur.y}px`
    }

    // One chokepoint for the wander signals: the pose (drives the sprite), the
    // travel direction (drives the directional row + mirror) and the wall (the
    // sprite's rotation).
    const signal = (pose: PetMotion | null, dir: -1 | 0 | 1, wall?: Wall) => {
      $petMotion.set(pose)
      $petRoamDir.set(dir)

      if (wall) {
        $petRoamWall.set(wall)
      }
    }

    const beginPause = (now: number) => {
      phase = 'pause'
      pauseUntil = now + dwellMs(PAUSE_DWELL)
      signal(null, 0, curSurface?.wall)
      commit({ ...cur })
    }

    // Land flush on a surface, then settle into the next idle beat.
    const settleOn = (surface: Surface, now: number) => {
      writeCoord(cur, normalAxis(surface.wall), restCoord(surface, petW, petH))
      curSurface = surface
      applyDom()
      beginPause(now)
    }

    const beginVertical = (surface: Surface) => {
      targetSurface = surface

      const normal = normalAxis(surface.wall)
      const rest = restCoord(surface, petW, petH)
      // "Up" is against gravity, whichever way gravity currently points — so a
      // pet moving toward the left wall springs leftward and falls rightward.
      const towardSurface = (rest - coordOn(cur, normal)) * gravitySign(surface.wall)

      if (towardSurface < -1) {
        phase = 'jump'
        jumpFrom = coordOn(cur, normal)
        jumpElapsed = 0
      } else {
        phase = 'fall'
        fallVel = 0
      }

      signal('jump', 0, surface.wall)
    }

    /**
     * A stroll that reached the end of its surface steps around the corner onto
     * the adjoining wall, when there is one. Without this the pet only ever
     * wall-walks because it was dragged there — it would never leave the floor
     * on its own, which is most of the point.
     */
    const tryCornerTurn = (surfaces: Surface[], surface: Surface): boolean => {
      if (!mobile) {
        return false
      }

      const tangent = tangentAxis(surface.wall)
      const at = coordOn(cur, tangent)
      const end = at <= surface.from + CORNER_EPS ? 'from' : at >= surface.to - CORNER_EPS ? 'to' : null

      if (!end) {
        return false
      }

      const wall = cornerNeighbour(surface.wall, end)
      const next = surfaces.find(s => s.wall === wall)

      if (!next || next === surface || next.to - next.from < CORNER_STEP_IN_PX * 2) {
        return false
      }

      // Land just around the corner — NOT flush against it.
      //
      // Flush would leave the pet within CORNER_EPS of the new surface's end,
      // so the very next beat would read "at the end" again and turn it
      // straight back. That is an infinite corner ping-pong, and the pet would
      // vibrate in the corner instead of walking. Stepping a few px in means
      // the next turn has to be earned by an actual stroll.
      //
      // Which end to land on falls out of the wall the pet came from: leaving a
      // surface whose gravity is positive (floor, right wall) means arriving at
      // the far end of the next one.
      const nextTangent = tangentAxis(next.wall)
      const nextNormal = normalAxis(next.wall)
      const corner = gravitySign(surface.wall) > 0 ? next.to - CORNER_STEP_IN_PX : next.from + CORNER_STEP_IN_PX

      writeCoord(cur, nextTangent, Math.min(Math.max(corner, next.from), next.to))
      writeCoord(cur, nextNormal, restCoord(next, petW, petH))
      applyDom()
      settleOn(next, performance.now())

      return true
    }

    const planNext = (now: number) => {
      // An open overlay swaps the surface set to just its bottom edge, so the pet
      // patrols along it; closing it restores the normal surfaces (and the pet
      // drops to whatever's below).
      const surfaces = surfacesNow()
      const box = walkBox(petH, mobile)

      curSurface = resolveSurface(surfaces, cur, petW, petH, box)

      if (!isRestingOn(curSurface, cur, petW, petH, SURFACE_EPS)) {
        // Dragged into the air, or the surface moved out from under it: fall
        // toward whichever wall is now nearest.
        beginVertical(curSurface)

        return
      }

      if (tryCornerTurn(surfaces, curSurface)) {
        return
      }

      const tangent = tangentAxis(curSurface.wall)

      // Only surfaces of the same orientation are step-across neighbours; a
      // different wall is reached by turning a corner, not by hopping.
      const reachable = surfaces.filter(
        s => s !== curSurface && s.wall === curSurface!.wall && spansOverlap(curSurface!, s)
      )

      const move = chooseMove(reachable.length > 0)

      if (move === 'rest') {
        // Stay put and loaf another beat — movement is the exception.
        beginPause(now)

        return
      }

      if (move === 'hop') {
        const next = reachable[Math.floor(Math.random() * reachable.length)]!
        const lo = Math.max(curSurface.from, next.from)
        const hi = Math.min(curSurface.to, next.to)
        pendingHop = next
        walkTarget = lo + Math.random() * (hi - lo)
      } else {
        pendingHop = null
        walkTarget = pickStrollTarget(curSurface, coordOn(cur, tangent))
      }

      phase = 'walk'
      signal('run', signDir(walkTarget - coordOn(cur, tangent)), curSurface.wall)
    }

    const step = (now: number) => {
      const dt = Math.min(MAX_DT_S, (now - last) / 1000)
      last = now

      // Yield to a drag: track the pet so we resume from the drop point, and
      // reset the idle beat so it doesn't bolt the instant it's let go.
      if (isInteracting()) {
        const live = el.getBoundingClientRect()
        cur.x = live.left
        cur.y = live.top
        phase = 'pause'
        pendingHop = null
        // Short settle so the pet falls right after you drop it, not seconds later.
        pauseUntil = now + DROP_SETTLE_MS
        signal(null, 0)
        raf = requestAnimationFrame(step)

        return
      }

      switch (phase) {
        case 'pause': {
          if (now >= pauseUntil) {
            planNext(now)
          }

          break
        }

        case 'walk': {
          const surface = curSurface

          if (!surface) {
            beginPause(now)

            break
          }

          const tangent = tangentAxis(surface.wall)
          const at = coordOn(cur, tangent)
          const remaining = walkTarget - at
          const stepDist = walkSpeedPxS * dt

          if (Math.abs(remaining) <= Math.max(ARRIVE_EPS, stepDist)) {
            writeCoord(cur, tangent, walkTarget)
            applyDom()

            if (pendingHop) {
              const next = pendingHop
              pendingHop = null
              beginVertical(next)
            } else {
              beginPause(now)
            }
          } else {
            writeCoord(cur, tangent, at + Math.sign(remaining) * stepDist)
            applyDom()
          }

          break
        }

        case 'fall': {
          if (!targetSurface) {
            beginPause(now)

            break
          }

          const normal = normalAxis(targetSurface.wall)
          const g = gravitySign(targetSurface.wall)
          const rest = restCoord(targetSurface, petW, petH)

          fallVel += GRAVITY_PX_S2 * dt

          const next = coordOn(cur, normal) + fallVel * dt * g

          // "Past the surface" is measured along gravity, so this reads the same
          // falling down onto the floor and sideways onto a wall.
          if ((next - rest) * g >= 0) {
            settleOn(targetSurface, now)
          } else {
            writeCoord(cur, normal, next)
            applyDom()
          }

          break
        }

        case 'jump': {
          if (!targetSurface) {
            beginPause(now)

            break
          }

          const normal = normalAxis(targetSurface.wall)

          jumpElapsed += dt * 1000
          const t = Math.min(1, jumpElapsed / JUMP_DUR_MS)

          writeCoord(cur, normal, jumpFrom + (restCoord(targetSurface, petW, petH) - jumpFrom) * easeOutCubic(t))

          if (t >= 1) {
            settleOn(targetSurface, now)
          } else {
            applyDom()
          }

          break
        }
      }

      raf = requestAnimationFrame(step)
    }

    // A hidden document still services rAF on some webviews and not others, and
    // a mascot pacing a screen nobody is looking at is pure battery. Stop the
    // loop outright rather than trusting the platform to throttle it.
    const onVisibility = () => {
      if (document.hidden) {
        if (!paused) {
          paused = true
          cancelAnimationFrame(raf)
          signal(null, 0)
        }

        return
      }

      if (paused) {
        paused = false
        // Reset the clock, or the first frame back integrates the whole time
        // spent hidden. MAX_DT_S caps it, but starting fresh is honest.
        last = performance.now()
        pauseUntil = last + DROP_SETTLE_MS
        raf = requestAnimationFrame(step)
      }
    }

    document.addEventListener('visibilitychange', onVisibility)

    if (!document.hidden) {
      raf = requestAnimationFrame(step)
    } else {
      paused = true
    }

    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      cancelAnimationFrame(raf)
      signal(null, 0)
      // Hand the final position back to React so its `style` matches the DOM once
      // the loop stops re-asserting it.
      commit({ ...cur })
    }
  }, [enabled, petW, petH, loopMs, overlayOpen, mobile, containerRef, isInteracting, commit])
}
