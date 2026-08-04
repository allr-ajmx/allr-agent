import { type CSSProperties, useEffect } from 'react'

import { createParticleEmitter, ParticleField, type ParticleFieldConfig } from '@/components/particles/particle-field'
import { $petActive, flashPetActivity } from '@/store/pet'
import { forwardPetReaction } from '@/store/pet-reaction'

/**
 * TikTok-style floating hearts — a thin skin over {@link ParticleField} (pixel
 * heart glyph + pink). Placed two ways: rising from the composer when no pet is
 * out, or from the pet when one is. Fired by the core's `reaction` event (ily /
 * `<3` / good bot, see store/chat.ts) — or call {@link burstVibeHearts} directly.
 */

// Light pink reads on both light and dark chat surfaces.
const HEART_COLORS = ['#ff9ec4'] as const

/** Composer placement: hearts rise the thread height (rise = % of the tall lane). */
export const COMPOSER_HEART_CONFIG: Partial<ParticleFieldConfig> = {
  count: 12,
  size: [6, 13],
  rise: [6.75, 15.75],
  duration: [320, 700]
}

/** Pet placement: a compact puff off the pet. The field box spans feet→head, so
 *  rise ≥100% carries hearts from the feet to ~10-20% above the pet before fading. */
const PET_HEART_CONFIG: Partial<ParticleFieldConfig> = {
  count: 10,
  spawnWindowMs: 450,
  size: [6, 12],
  rise: [98, 118],
  duration: [480, 880],
  swayAmp: [5, 14],
  bank: [6, 14]
}

// Pixel-art heart from @nous-research/ui (14×12), crisp + `currentColor`.
const HEART_GLYPH = (
  <svg fill="none" shapeRendering="crispEdges" viewBox="0 0 14 12" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M13.2 0v5.65714h-1.8857v1.88572H9.42857v1.88571H7.54286v1.88573H5.65714V9.42857H3.77143V7.54286H1.88571V5.65714H0V0h5.65714v1.88571h1.88572V0z"
      fill="currentColor"
    />
  </svg>
)

const emitter = createParticleEmitter()

/** Play hearts in THIS window (whichever HeartField is mounted). */
export const playVibeHearts = (count?: number) => emitter.burst(count)

/**
 * Fire a vibe burst from anywhere (the `reaction` event, the DEV hotkey). When a
 * pet is out it celebrates alongside the hearts, which the mounted PetHeartField
 * then puffs off the sprite; with no pet, the composer field catches them.
 *
 * The reaction is also pushed onto the (currently consumer-less) `$petReaction`
 * bus. Desktop uses that to mirror the burst into a popped-out pet's own OS
 * window; universal is single-window, so it's carried for a future pop-out
 * rather than routed to — which is why this always plays locally, where desktop
 * plays locally OR forwards.
 */
export const burstVibeHearts = (count?: number) => {
  if ($petActive.get()) {
    flashPetActivity({ celebrate: true })
  }

  forwardPetReaction('vibe')
  playVibeHearts(count)
}

/** DEV-only preview: Shift+H, firing even while the composer is focused. Mount
 *  once in an always-present component (FloatingPet) — a single listener.
 *  Deliberately a raw listener rather than a registered keybind: it's a dev
 *  affordance, and registering it would surface a fake row in Settings →
 *  Shortcuts. (Desktop later dropped this hotkey in 1fa3886bc; universal keeps
 *  it, since the reaction path is harder to trigger by hand here.) */
export function useHeartPreviewHotkey() {
  useEffect(() => {
    if (!import.meta.env.DEV) {
      return
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.shiftKey || e.repeat || e.altKey || e.ctrlKey || e.metaKey || e.code !== 'KeyH') {
        return
      }

      e.preventDefault()
      burstVibeHearts()
    }

    window.addEventListener('keydown', onKeyDown)

    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}

export interface HeartFieldProps {
  config?: Partial<ParticleFieldConfig>
  className?: string
  style?: CSSProperties
}

/** Heart-skinned particle field. Caller supplies placement + a config preset. */
export function HeartField({ config, className, style }: HeartFieldProps) {
  return (
    <ParticleField
      className={className}
      colors={HEART_COLORS}
      config={config}
      emitter={emitter}
      glyph={HEART_GLYPH}
      style={style}
    />
  )
}

/**
 * Pet-anchored hearts, feet→~10-20% above. One place owns the geometry so the
 * pet's puff stays consistent wherever it's mounted. `petW`/`petH` are the
 * rendered sprite dimensions (frame × scale).
 */
export function PetHeartField({ petW, petH }: { petW: number; petH: number }) {
  return (
    <HeartField
      config={PET_HEART_CONFIG}
      style={{
        bottom: 0,
        height: Math.max(96, petH),
        left: '50%',
        pointerEvents: 'none',
        position: 'absolute',
        transform: 'translateX(-50%)',
        width: Math.max(90, petW * 1.5),
        zIndex: 2
      }}
    />
  )
}
