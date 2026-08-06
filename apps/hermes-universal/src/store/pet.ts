import { Codecs, persistentAtom } from '@/lib/persisted'
import { atom, computed } from '@/store/atom'

// The active pet's live info (spritesheet for the in-app animated sprite, K10.b).
// Populated from the `pet.info` gateway RPC.
export interface PetInfo {
  enabled: boolean
  slug?: string
  displayName?: string
  mime?: string
  spritesheetBase64?: string
  spritesheetRevision?: string
  frameW?: number
  frameH?: number
  framesPerState?: number
  framesByState?: Record<string, number>
  // Concrete Codex row counts (e.g. running-right may have 8 frames even though
  // the Hermes "run" activity state uses the in-place running row). Optional —
  // falls back to framesByState / framesPerState when absent.
  framesByRow?: Record<string, number>
  loopMs?: number
  scale?: number
  stateRows?: string[]
}

export const $petInfo = atom<PetInfo>({ enabled: false })

export const setPetInfo = (info: PetInfo) => $petInfo.set(info)

/** Pet installed + enabled with a loaded spritesheet (ready to show/react). */
export const $petActive = computed($petInfo, info => info.enabled && Boolean(info.spritesheetBase64))

// The animated pose the sprite draws. Ported from desktop's PetState taxonomy
// (mirrors agent.pet.state) so every Codex row can come alive.
export type PetState = 'idle' | 'wave' | 'run' | 'failed' | 'review' | 'jump' | 'waiting'

/**
 * Coarse activity signals that drive the pose. Fed from `store/chat.ts` (the
 * gateway event stream + prompt/response paths) — never computed here, so this
 * store stays decoupled from the chat/gateway chain that the pet tests mock (in
 * particular we do NOT import chat `$busy`; it arrives as the `busy` flag).
 *
 * - `busy` / `reasoning` / `toolRunning`: steady in-turn flags set + cleared by
 *   the stream.
 * - `awaitingInput`: a clarify/approval question is blocking on the user.
 * - `error` / `greeting` / `celebrate`: transient reaction beats fired via
 *   `flashPetActivity` (crying on failure; waving on app-open / new-chat;
 *   hopping when the user sends affection), auto-decaying back.
 */
export interface PetActivity {
  busy?: boolean
  awaitingInput?: boolean
  toolRunning?: boolean
  reasoning?: boolean
  error?: boolean
  greeting?: boolean
  celebrate?: boolean
}

export const $petActivity = atom<PetActivity>({})

/**
 * Merge steady flags into the activity atom (leaves siblings intact).
 *
 * The no-op guard is load-bearing, not tidiness. `event-router` calls
 * `setPetActivity({ reasoning: true })` on EVERY reasoning delta — unbatched,
 * once per token — and the spread produced a fresh object each time. nanostores
 * compares by identity, so every subscriber of this atom re-ran per token while
 * the value was, in every case after the first, identical. Returning early when
 * nothing actually changed turns a per-token notification storm into one
 * notification per real state transition.
 */
export const setPetActivity = (next: Partial<PetActivity>) => {
  const current = $petActivity.get()

  for (const [key, value] of Object.entries(next) as [keyof PetActivity, boolean | undefined][]) {
    if (current[key] !== value) {
      $petActivity.set({ ...current, ...next })

      return
    }
  }
}

let flashTimer: ReturnType<typeof setTimeout> | undefined

/**
 * Fire a transient reaction beat (`error` / `greeting` / `celebrate`) that
 * decays back to the steady state after `ms`. Each beat first clears its
 * siblings so a stale one can't win the priority race in `derivePetState` (e.g.
 * a lingering `error` outranking a fresh `greeting`).
 */
export const flashPetActivity = (next: Partial<PetActivity>, ms = 1600) => {
  setPetActivity({ celebrate: false, error: false, greeting: false, ...next })
  clearTimeout(flashTimer)
  flashTimer = setTimeout(() => setPetActivity({ celebrate: false, error: false, greeting: false }), ms)
}

/**
 * Resolve the animation state from coarse activity signals. Priority (highest
 * first) mirrors desktop `derivePetState` (adapted: `justCompleted` collapses
 * into `greeting`, since universal only waves on app-open/new-chat):
 * celebrate → error → greeting → awaitingInput → toolRunning → reasoning →
 * busy → idle. `celebrate` outranks everything because it's the reply to a
 * direct bit of affection — it should land even mid-turn. `awaitingInput`
 * outranks the in-flight signals because the turn is paused on the user, not
 * working.
 *
 * `celebrate` maps to `jump`: universal's PetState taxonomy has no dedicated
 * celebrate row, and hopping is the existing "yay" pose.
 */
export function derivePetState(activity: PetActivity): PetState {
  if (activity.celebrate) {
    return 'jump'
  }

  if (activity.error) {
    return 'failed'
  }

  if (activity.greeting) {
    return 'wave'
  }

  if (activity.awaitingInput) {
    return 'waiting'
  }

  if (activity.toolRunning) {
    return 'run'
  }

  if (activity.reasoning) {
    return 'review'
  }

  if (activity.busy) {
    return 'run'
  }

  return 'idle'
}

// Roam (autonomous wander), ported from desktop store/pet.ts.
// - `$petRoam` is the opt-in toggle (persisted per-device).
// - `$petMotion` / `$petRoamDir` are published by the roam loop (use-pet-roam) to
//   drive the sprite's pose + facing without a prop change.
// (The "at rest" gate lives in FloatingPet — computed from chat `$busy` there —
// so this store stays decoupled from the gateway/chat chain that pet tests mock.)
export type PetMotion = 'run' | 'jump'

export const $petRoam = persistentAtom<boolean>('hermes.pet-roam', true, Codecs.bool)
export const setPetRoam = (on: boolean) => $petRoam.set(on)

export const $petMotion = atom<PetMotion | null>(null)
export const $petRoamDir = atom<-1 | 0 | 1>(0)

/**
 * The live pose the sprite draws. Activity always wins; only when the agent is
 * at rest (base `idle`) does a roam pose (walking → `run`, hopping/falling →
 * `jump`) show through — so the wander reads as deliberate movement and a
 * drop-from-height plays the jump pose. (`PetMotion` values are a subset of
 * `PetState`, so the fold is type-safe.)
 */
export const $petState = computed([$petActivity, $petMotion], (activity, motion): PetState => {
  const base = derivePetState(activity)

  return base === 'idle' && motion ? motion : base
})
