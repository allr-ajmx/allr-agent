import { afterEach, describe, expect, it } from 'vitest'

import {
  $petActive,
  $petActivity,
  $petInfo,
  $petMotion,
  $petState,
  derivePetState,
  flashPetActivity,
  setPetActivity
} from './pet'

afterEach(() => {
  $petActivity.set({})
  $petMotion.set(null)
  $petInfo.set({ enabled: false })
})

describe('derivePetState', () => {
  it('rests at idle by default and uses waiting when awaiting input', () => {
    expect(derivePetState({})).toBe('idle')
    expect(derivePetState({ awaitingInput: true })).toBe('waiting')
  })

  it('runs when busy or a tool is executing', () => {
    expect(derivePetState({ busy: true })).toBe('run')
    expect(derivePetState({ toolRunning: true })).toBe('run')
  })

  it('reviews while reasoning (below tool, above bare busy)', () => {
    expect(derivePetState({ reasoning: true })).toBe('review')
    expect(derivePetState({ reasoning: true, busy: true })).toBe('review')
    expect(derivePetState({ reasoning: true, toolRunning: true })).toBe('run')
  })

  it('waits (blocked on the user) above the in-flight signals', () => {
    expect(derivePetState({ awaitingInput: true, toolRunning: true, busy: true })).toBe('waiting')
    // but a greeting beat still wins over waiting
    expect(derivePetState({ greeting: true, awaitingInput: true })).toBe('wave')
  })

  it('honors the full priority chain: error > greeting > awaitingInput', () => {
    expect(derivePetState({ error: true, greeting: true, busy: true })).toBe('failed')
    expect(derivePetState({ greeting: true, awaitingInput: true, toolRunning: true })).toBe('wave')
  })

  it('celebrates (jump) above everything — affection lands even mid-turn', () => {
    expect(derivePetState({ celebrate: true })).toBe('jump')
    expect(derivePetState({ celebrate: true, error: true, busy: true })).toBe('jump')
  })
})

describe('$petActive', () => {
  it('is true only once the pet is enabled AND its spritesheet has loaded', () => {
    $petInfo.set({ enabled: false })
    expect($petActive.get()).toBe(false)

    // Enabled but still fetching the sheet — nothing to draw, so no reactions.
    $petInfo.set({ enabled: true })
    expect($petActive.get()).toBe(false)

    $petInfo.set({ enabled: true, spritesheetBase64: 'AAAA' })
    expect($petActive.get()).toBe(true)
  })
})

describe('roam motion ($petState folding)', () => {
  it('shows the roam pose while wandering, but never overrides real activity', () => {
    $petActivity.set({})
    $petMotion.set('run')
    expect($petState.get()).toBe('run')

    // Hops/falls surface the jump pose.
    $petMotion.set('jump')
    expect($petState.get()).toBe('jump')

    // Activity wins over a wander in progress.
    $petActivity.set({ reasoning: true, busy: true })
    expect($petState.get()).toBe('review')

    // Back at rest, the wander resumes its pose; clearing it returns to idle.
    $petActivity.set({})
    expect($petState.get()).toBe('jump')
    $petMotion.set(null)
    expect($petState.get()).toBe('idle')
  })
})

describe('flashPetActivity', () => {
  it('clears stale sibling beats so a greeting never inherits a prior error', () => {
    // A turn errors (crying), then the app opens / a new chat starts (wave). The
    // greeting beat must win — error is highest priority, so a merge-only flash
    // would keep the pet on the failed pose.
    setPetActivity({ error: true })
    flashPetActivity({ greeting: true })

    expect($petActivity.get().error).toBe(false)
    expect($petState.get()).toBe('wave')
  })

  it('clears a stale celebrate so hearts do not pin the pet mid-jump', () => {
    flashPetActivity({ celebrate: true })
    expect($petState.get()).toBe('jump')

    // A later beat of a different kind must reset it — celebrate outranks
    // everything, so a merge-only flash would leave the pet stuck hopping.
    flashPetActivity({ error: true })

    expect($petActivity.get().celebrate).toBe(false)
    expect($petState.get()).toBe('failed')
  })
})
