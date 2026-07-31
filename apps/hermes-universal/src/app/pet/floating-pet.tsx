import { useCallback, useEffect, useRef, useState } from 'react'

import { PetHeartField, useHeartPreviewHotkey } from '@/components/chat/vibe-hearts'
import { useStore } from '@/store/atom'
import { $busy } from '@/store/chat'
import { $petInfo, $petRoam, $petRoamDir, flashPetActivity } from '@/store/pet'
import { syncPetInfo } from '@/store/pet-gallery'
import { useTheme } from '@/themes/context'

import { PetSprite, roamWalkRow } from './pet-sprite'
import { usePetRoam } from './use-pet-roam'

// The in-app pet (K10.b), ported from the desktop in-app mascot: a top-level,
// draggable, roaming sprite mounted at the app root (mobile-controller) so it
// floats over every route. The desktop's separate-OS-window pop-out is excluded
// (Tauri has one window; can't work on mobile). Position is top/left-anchored,
// persisted to localStorage, and clamped inside the window.

const POSITION_KEY = 'hermes.pet-position.v2'
// Stand-in pet size for the pre-load clamp (real size flows in with `info`).
const NOMINAL_PET_PX = 96

interface Point {
  x: number
  y: number
}

// Keep a w×h box fully inside the viewport.
function clampPoint(x: number, y: number, w: number, h: number): Point {
  return {
    x: Math.min(Math.max(0, x), Math.max(0, (window.innerWidth || 800) - w)),
    y: Math.min(Math.max(0, y), Math.max(0, (window.innerHeight || 600) - h))
  }
}

// The sprite art faces left by default, so mirror it when the pet's center sits
// on the left half of the window — it always faces inward, toward the content.
function facing(leftX: number, petW: number): string {
  return leftX + petW / 2 < (window.innerWidth || 800) / 2 ? 'scaleX(-1)' : 'none'
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

  const [position, setPosition] = useState<Point>(loadPosition)
  const containerRef = useRef<HTMLDivElement | null>(null)
  // The facing mirror lives on the sprite wrapper so any container child stays upright.
  const spriteWrapRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ dx: number; dy: number; x: number; y: number } | null>(null)

  const petW = (info.frameW ?? 192) * (info.scale ?? 0.33)
  const petH = (info.frameH ?? 208) * (info.scale ?? 0.33)
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

    reclamp()
    window.addEventListener('resize', reclamp)

    return () => window.removeEventListener('resize', reclamp)
  }, [clamp])

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    const el = containerRef.current

    if (!el) {
      return
    }

    const rect = el.getBoundingClientRect()
    dragRef.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top, x: rect.left, y: rect.top }
    el.setPointerCapture(e.pointerId)
    el.style.cursor = 'grabbing'
  }, [])

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
        spriteWrapRef.current.style.transform = facing(next.x, petW)
      }
    },
    [clamp, petW]
  )

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current

    if (drag) {
      dragRef.current = null
      const committed = { x: drag.x, y: drag.y }
      setPosition(committed)
      persistPosition(committed)
    }

    const el = containerRef.current

    if (el) {
      el.style.cursor = 'grab'
      el.releasePointerCapture?.(e.pointerId)
    }
  }, [])

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
    enabled: roamEnabled && active && atRest,
    isInteracting: isDragging,
    loopMs: info.loopMs ?? 1100,
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
  const roaming = roamDir !== 0
  const walk = roamWalkRow(roamDir, info.stateRows)

  if (!info.enabled || !info.spritesheetBase64) {
    return null
  }

  return (
    <div
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
        touchAction: 'none',
        userSelect: 'none',
        zIndex: 60
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
      <div
        ref={spriteWrapRef}
        style={{
          lineHeight: 0,
          position: 'relative',
          transform: roaming ? (walk.mirror ? 'scaleX(-1)' : 'none') : facing(position.x, petW),
          zIndex: 1
        }}
      >
        <PetSprite info={info} rowOverride={walk.row} />
      </div>
      {/* Hearts puff off the pet; its celebrate ("yay"/jump) pose is driven by
          burstVibeHearts's router. */}
      <PetHeartField petH={petH} petW={petW} />
    </div>
  )
}
