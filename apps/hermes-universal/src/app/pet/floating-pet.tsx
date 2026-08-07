import { useCallback, useEffect, useRef, useState } from 'react'

import { PetHeartField, useHeartPreviewHotkey } from '@/components/chat/vibe-hearts'
import { useMediaQuery } from '@/hooks/use-media-query'
import { triggerHaptic } from '@/lib/haptics'
import { IS_MOBILE } from '@/lib/platform'
import { useStore } from '@/store/atom'
import { $busy } from '@/store/chat'
import { $petInfo, $petRoam, $petRoamDir, $petRoamWall, flashPetActivity, type PetRoamWall } from '@/store/pet'
import { syncPetInfo } from '@/store/pet-gallery'
import { useTheme } from '@/themes/context'

import { PetSprite, roamWalkRow } from './pet-sprite'
import { walkBox } from './roam-geometry'
import { usePetRoam } from './use-pet-roam'
import { clampToBox, facingSign, spriteRotation, tangentAxis } from './wall-geometry'

// The in-app pet, ported from the desktop in-app mascot: a top-level,
// draggable, roaming sprite mounted at the app root (mobile-controller) so it
// floats over every route. The desktop's separate-OS-window pop-out is excluded
// (Tauri has one window; can't work on mobile). Position is top/left-anchored,
// persisted to localStorage, and clamped inside the window.
//
// On a phone it walks all four edges rather than only the floor, so the sprite
// rotates to keep its feet on whatever it is standing on, and the walk area is
// inset by the safe area and the keyboard. See wall-geometry.ts.

const POSITION_KEY = 'hermes.pet-position.v2'
// Stand-in pet size for the pre-load clamp (real size flows in with `info`).
const NOMINAL_PET_PX = 96

// The picked-up look. A haptic alone is easy to miss (and silent on a device
// with vibration off), so the sprite also swells and casts a shadow the moment
// it is lifted — the drag has an unmistakable start.
const HELD_SCALE = 1.12
const HELD_SHADOW = 'drop-shadow(0 0.375rem 0.625rem rgb(0 0 0 / 0.35))'

// Long enough to outlast the soft keyboard's open/close animation.
const RECLAMP_DEBOUNCE_MS = 150

// `touch-action: none`, on every platform and at all times.
//
// The pet used to pass vertical panning through (`pan-y`) so a scroll starting
// on it still scrolled the thread, and claim the box back once a long press
// armed. That cannot work: `touch-action` is latched when the browser decides
// what a gesture is, so re-assigning it mid-gesture is a no-op — the scroller
// took the touch and fired `pointercancel`, killing the pickup before it could
// ever fire. The dev HUDs drag correctly precisely because theirs is static.
//
// So the pet swallows a scroll that starts inside its ~63×69 box. That is the
// accepted cost of a mascot you can actually pick up, and it is a box the user
// can now move out of the way.
const PET_TOUCH_ACTION = 'none'

// The pet floats above the app, but not above things that block. `.composer-bars`
// — approval / clarify / sudo / secret prompts — is z-31, and the mobile drawers
// are z-50, so a z-60 mascot could sit on top of a prompt the user has to answer.
// Desktop keeps 60 deliberately: the pet patrols the Settings overlay's edge, and
// the layering there is provider-connect z-70 > settings z-50 > pet z-60.
const PET_Z_INDEX = IS_MOBILE ? 29 : 60

interface Point {
  x: number
  y: number
}

// Keep a w×h box fully inside the area the pet is allowed to occupy. That used
// to be the raw viewport, which on a phone put the pet under the notch and
// standing on the home indicator; `walkBox` insets it by the safe area and the
// soft keyboard, and is the same box the roam loop walks.
function clampPoint(x: number, y: number, w: number, h: number): Point {
  return clampToBox({ x, y }, w, h, walkBox(h, IS_MOBILE))
}

// Which way a resting pet faces: inward along the surface it is standing on,
// toward the middle of that surface's walk. On the floor and ceiling that is the
// horizontal midpoint; on a side wall it is the vertical one — comparing against
// the window's WIDTH there (as this used to) asks a question about an axis the
// pet cannot walk, so a wall-standing pet faced whichever way its x happened to
// fall. `facingSign` then converts that screen-space answer into the sprite's
// own, which the rotation has turned.
//
// Returns a transform *fragment* (possibly empty) so it can compose with the
// wall rotation rather than replacing it.
function facingTransform(pos: Point, petW: number, petH: number, wall: PetRoamWall): string {
  const vertical = tangentAxis(wall) === 'y'
  const centre = vertical ? pos.y + petH / 2 : pos.x + petW / 2
  const midpoint = (vertical ? window.innerHeight || 600 : window.innerWidth || 800) / 2
  // The sprite art faces left by default, so "inward" is un-mirrored when the
  // pet is past the midpoint and mirrored when it is short of it.
  const inward = centre < midpoint ? 1 : -1

  return inward * facingSign(wall) > 0 ? 'scaleX(-1)' : ''
}

const spriteTransform = (wall: PetRoamWall): string => {
  const deg = spriteRotation(wall)

  return deg === 0 ? '' : `rotate(${deg}deg)`
}

function persistPosition(p: Point): void {
  try {
    localStorage.setItem(POSITION_KEY, JSON.stringify(p))
  } catch {
    // ignore (private mode / quota)
  }
}

function loadPosition(): Point {
  try {
    const raw = localStorage.getItem(POSITION_KEY)

    if (raw) {
      const parsed = JSON.parse(raw) as Point

      if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
        return clampPoint(parsed.x, parsed.y, NOMINAL_PET_PX, NOMINAL_PET_PX)
      }
    }
  } catch {
    // fall through to default
  }

  // Default: lower-left corner (top/left anchored).
  return clampPoint(24, (window.innerHeight || 600) - 220, NOMINAL_PET_PX, NOMINAL_PET_PX)
}

/** `overlayOpen` = a full-window route overlay (Settings) is up, so the pet
 *  patrols its bottom edge instead of the normal surfaces. */
export function FloatingPet({ overlayOpen = false }: { overlayOpen?: boolean }) {
  const { resolvedMode } = useTheme()
  const info = useStore($petInfo)
  const busy = useStore($busy)
  const roamEnabled = useStore($petRoam)
  // Activity pauses the wander: the pet reacts in place, then resumes when idle.
  const atRest = !busy
  const roamDir = useStore($petRoamDir)
  const roamWall = useStore($petRoamWall)
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')

  const [position, setPosition] = useState<Point>(loadPosition)
  const containerRef = useRef<HTMLDivElement | null>(null)
  // The facing mirror lives on the sprite wrapper so any container child stays upright.
  const spriteWrapRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ dx: number; dy: number; x: number; y: number } | null>(null)

  const petW = (info.frameW ?? 192) * (info.scale ?? 0.33)
  const petH = (info.frameH ?? 208) * (info.scale ?? 0.33)
  // Live size for the dep-free drag callbacks, which must not be rebuilt on
  // every scale change just to read it.
  const petSizeRef = useRef({ h: petH, w: petW })
  petSizeRef.current = { h: petH, w: petW }
  // Soft contact shadow, sized off the pet. Lighter on light backgrounds.
  const shadowW = Math.round(petW * 0.55)
  const shadowH = Math.max(3, Math.round(shadowW * 0.28))
  const shadowAlpha = resolvedMode === 'light' ? 0.2 : 0.55

  const active = info.enabled && Boolean(info.spritesheetBase64)

  // Self-heal the active pet on mount: `$petInfo` is only otherwise populated by
  // the connect effect, so it goes empty across an HMR store reload — and a pet
  // enabled via `/pet` while the app runs wouldn't appear until reconnect. A
  // one-shot sync here repopulates it (the pet only mounts while connected).
  // Also greet the user with a wave when the app opens.
  useEffect(() => {
    void syncPetInfo()
    flashPetActivity({ greeting: true })
  }, [])

  // Keep the whole pet on-screen at its current size (shared by drag + reclamp).
  const clamp = useCallback(({ x, y }: Point): Point => clampPoint(x, y, petW, petH), [petW, petH])

  // Re-clamp (and persist) whenever the viewport shrinks or the pet's size changes.
  useEffect(() => {
    const reclamp = () =>
      setPosition(prev => {
        const next = clamp(prev)

        if (next.x === prev.x && next.y === prev.y) {
          return prev
        }

        persistPosition(next)

        return next
      })

    // Debounced, because on a phone `resize` fires throughout the soft
    // keyboard's open/close animation. Clamping on every one of those frames
    // made the pet hop across the screen while you were only typing.
    let timer: null | ReturnType<typeof setTimeout> = null

    const onResize = () => {
      if (timer !== null) {
        clearTimeout(timer)
      }

      timer = setTimeout(reclamp, RECLAMP_DEBOUNCE_MS)
    }

    reclamp()
    window.addEventListener('resize', onResize)

    return () => {
      if (timer !== null) {
        clearTimeout(timer)
      }

      window.removeEventListener('resize', onResize)
    }
  }, [clamp])

  // Lift the pet: capture the pointer and put on the held look.
  const beginDrag = useCallback((clientX: number, clientY: number, pointerId: number) => {
    const el = containerRef.current

    if (!el) {
      return
    }

    const rect = el.getBoundingClientRect()
    dragRef.current = { dx: clientX - rect.left, dy: clientY - rect.top, x: rect.left, y: rect.top }
    el.setPointerCapture?.(pointerId)
    el.style.cursor = 'grabbing'
    el.style.filter = HELD_SHADOW
    void triggerHaptic('selection')

    if (spriteWrapRef.current) {
      const { h, w } = petSizeRef.current
      // 'floor' because a carried pet is held upright — see onPointerMove.
      spriteWrapRef.current.style.transform = `${facingTransform({ x: rect.left, y: rect.top }, w, h, 'floor')} scale(${HELD_SCALE})`
    }
    // Dep-free: `petW` is read through a live ref so this callback never needs
    // to be rebuilt, and the pointer handlers below stay stable with it.
  }, [])

  // Put the sprite back the way React draws it at rest. The composed transform
  // is reasserted on the next render, when the roam loop re-homes the pet.
  const clearHeldLook = useCallback((el: HTMLElement) => {
    el.style.cursor = 'grab'
    el.style.filter = ''
  }, [])

  // Any pointer lifts the pet on contact — mouse, touch and pen alike. There is
  // no hold to wait through: with `touch-action: none` the box owns the gesture
  // from the first event, so a hold would only add latency to a drag that is
  // already ours, and the scroll it used to protect is gone either way.
  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      beginDrag(e.clientX, e.clientY, e.pointerId)
    },
    [beginDrag]
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragRef.current
      const el = containerRef.current

      if (!drag || !el) {
        return
      }

      const next = clamp({ x: e.clientX - drag.dx, y: e.clientY - drag.dy })
      drag.x = next.x
      drag.y = next.y
      // Mutate the DOM directly — no setState, so no re-render while dragging.
      el.style.left = `${next.x}px`
      el.style.top = `${next.y}px`

      if (spriteWrapRef.current) {
        // Upright while it's in your hand — a pet carried across the screen
        // still rotated onto a wall it left reads as a bug. React reasserts the
        // composed transform on release, when the roam loop re-homes it.
        spriteWrapRef.current.style.transform = `${facingTransform(next, petW, petH, 'floor')} scale(${HELD_SCALE})`
      }
    },
    [clamp, petH, petW]
  )

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragRef.current

      if (drag) {
        dragRef.current = null
        const committed = { x: drag.x, y: drag.y }
        setPosition(committed)
        persistPosition(committed)
      }

      const el = containerRef.current

      if (el) {
        clearHeldLook(el)
        el.releasePointerCapture?.(e.pointerId)
      }
    },
    [clearHeldLook]
  )

  // A system interruption — an incoming call, a gesture the OS claims. Drop the
  // drag where it stands rather than leaving the pet stuck to a dead pointer.
  const onPointerCancel = useCallback(
    (e: React.PointerEvent) => {
      dragRef.current = null

      const el = containerRef.current

      if (el) {
        clearHeldLook(el)
        el.releasePointerCapture?.(e.pointerId)
      }
    },
    [clearHeldLook]
  )

  // Commit a roamed-to position back to React state + storage when the loop settles.
  const commitRoamPosition = useCallback((point: Point) => {
    setPosition(point)
    persistPosition(point)
  }, [])

  const isDragging = useCallback(() => dragRef.current !== null, [])

  // Roam only while idle (agent at rest) and not being dragged. Activity pauses
  // the wander; the pet reacts in place, then resumes strolling when the turn ends.
  usePetRoam({
    commit: commitRoamPosition,
    containerRef,
    // Reduced motion disables the wander outright. A mascot that wanders the
    // screen on its own is exactly what that setting exists to stop; the pet
    // still appears, reacts and drags.
    enabled: roamEnabled && active && atRest && !reducedMotion,
    isInteracting: isDragging,
    loopMs: info.loopMs ?? 1100,
    mobile: IS_MOBILE,
    overlayOpen,
    petH,
    petW
  })

  // DEV Shift+H heart preview lives here — FloatingPet is mounted app-shell-wide,
  // so one listener covers every route. Called above the early return so the hook
  // order stays stable when no pet is installed.
  useHeartPreviewHotkey()

  // While roaming, drive the directional run row + mirror from travel direction;
  // at rest, fall back to the inward-facing static mascot. The pose itself comes
  // from `$petState` (activity + roam motion), read inside PetSprite.
  //
  // `roamDir` is a sign along the surface's TANGENT, which is vertical on a side
  // wall — and the mirror it feeds is composed after the wall rotation, in the
  // sprite's own frame. `facingSign` converts between the two; without it the
  // pet moonwalks up the right wall and along the ceiling.
  const roaming = roamDir !== 0
  const walk = roamWalkRow((roamDir * facingSign(roamWall)) as -1 | 0 | 1, info.stateRows)

  if (!info.enabled || !info.spritesheetBase64) {
    return null
  }

  return (
    <div
      onPointerCancel={onPointerCancel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      ref={containerRef}
      style={{
        cursor: 'grab',
        left: position.x,
        pointerEvents: 'auto',
        position: 'fixed',
        top: position.y,
        touchAction: PET_TOUCH_ACTION,
        userSelect: 'none',
        zIndex: PET_Z_INDEX
      }}
    >
      {/* Rotate the sprite so its feet stay against the surface. Mirroring
          alone would leave a wall-walking pet lying on its side with its feet
          pointing into the room. The contact shadow moved INSIDE this wrapper
          so it rotates along and lands on the contact side by construction —
          a symmetric ellipse is mirror-invariant, so `scaleX(-1)` leaves it
          alone. */}
      <div
        ref={spriteWrapRef}
        style={{
          lineHeight: 0,
          position: 'relative',
          transform:
            `${spriteTransform(roamWall)} ${roaming ? (walk.mirror ? 'scaleX(-1)' : '') : facingTransform(position, petW, petH, roamWall)}`.trim(),
          transformOrigin: 'center center',
          zIndex: 1
        }}
      >
        <div
          aria-hidden
          style={{
            background: `radial-gradient(ellipse at center, rgba(0,0,0,${shadowAlpha}) 0%, rgba(0,0,0,0) 70%)`,
            bottom: -shadowH * 0.4,
            height: shadowH,
            left: '50%',
            pointerEvents: 'none',
            position: 'absolute',
            transform: 'translateX(-50%)',
            width: shadowW,
            zIndex: 0
          }}
        />
        <PetSprite info={info} rowOverride={walk.row} />
      </div>
      {/* Hearts puff off the pet; its celebrate ("yay"/jump) pose is driven by
          burstVibeHearts's router. */}
      <PetHeartField petH={petH} petW={petW} />
    </div>
  )
}
