import { render } from '@testing-library/react'
import { act, createRef, type RefObject } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $petMotion, $petRoamDir } from '@/store/pet'

import { usePetRoam } from './use-pet-roam'

const PET_W = 63
const PET_H = 69

let frames: FrameRequestCallback[] = []
let nextFrame = 1

function flushFrame(now: number): void {
  const due = frames
  frames = []
  act(() => {
    for (const cb of due) {
      cb(now)
    }
  })
}

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { configurable: true, value: hidden, writable: true })
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'))
  })
}

interface HarnessProps {
  containerRef: RefObject<HTMLDivElement | null>
  enabled?: boolean
  commit?: (p: { x: number; y: number }) => void
}

function Harness({ commit = () => {}, containerRef, enabled = true }: HarnessProps) {
  usePetRoam({
    commit,
    containerRef,
    enabled,
    isInteracting: () => false,
    loopMs: 1100,
    mobile: true,
    overlayOpen: false,
    petH: PET_H,
    petW: PET_W
  })

  return <div ref={containerRef} />
}

function mount(props: Omit<HarnessProps, 'containerRef'> = {}) {
  const containerRef = createRef<HTMLDivElement>()

  return render(<Harness containerRef={containerRef} {...props} />)
}

beforeEach(() => {
  frames = []
  nextFrame = 1
  setHidden(false)

  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 400, writable: true })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800, writable: true })

  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frames.push(cb)

    return nextFrame++
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  $petMotion.set(null)
  $petRoamDir.set(0)
})

describe('usePetRoam', () => {
  it('does not run while disabled, and clears the wander signals', () => {
    $petMotion.set('run')
    $petRoamDir.set(1)

    mount({ enabled: false })

    expect(frames).toHaveLength(0)
    expect($petMotion.get()).toBeNull()
    expect($petRoamDir.get()).toBe(0)
  })

  it('drives a frame loop while enabled', () => {
    mount()

    expect(frames.length).toBeGreaterThan(0)

    flushFrame(16)
    expect(frames.length).toBeGreaterThan(0)
  })

  it('stops the loop when the document is hidden', () => {
    mount()
    flushFrame(16)

    setHidden(true)
    frames = []
    // Nothing re-arms the loop: a mascot pacing a screen nobody is looking at
    // is pure battery, and webviews differ on whether they throttle rAF at all.
    expect(frames).toHaveLength(0)
    expect($petMotion.get()).toBeNull()
  })

  it('resumes when the document comes back', () => {
    mount()
    flushFrame(16)
    setHidden(true)
    frames = []

    setHidden(false)
    expect(frames.length).toBeGreaterThan(0)
  })

  it('does not start at all if mounted while hidden', () => {
    setHidden(true)
    mount()

    expect(frames).toHaveLength(0)
  })

  it('commits the final position and clears the signals on unmount', () => {
    const commit = vi.fn()
    const view = mount({ commit })

    flushFrame(16)
    $petMotion.set('run')

    act(() => view.unmount())

    expect(commit).toHaveBeenCalled()
    expect($petMotion.get()).toBeNull()
    expect($petRoamDir.get()).toBe(0)
  })
})
