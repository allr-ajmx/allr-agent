import { describe, expect, it } from 'vitest'

import {
  LANDING_CAP_MS,
  type LandingState,
  landingVerdict,
  TURN_PAIR_SLOT,
  TURN_TOP_MARGIN_PX,
  turnScrollTop,
  turnStartElement
} from './turn-scroll'

const SETTLED: LandingState = { deltaPx: 0, elapsedMs: 40, pendingMedia: 0, stableFrames: 2 }

describe('turnScrollTop', () => {
  it('scrolls forward by the gap between the turn and the viewport top', () => {
    // The turn sits 500px below a viewport whose own top is at 100.
    expect(turnScrollTop({ margin: 0, scrollTop: 1000, turnTop: 600, viewportTop: 100 })).toBe(1500)
  })

  it('scrolls backward for a turn above the viewport', () => {
    expect(turnScrollTop({ margin: 0, scrollTop: 1000, turnTop: -400, viewportTop: 100 })).toBe(500)
  })

  it('leaves the margin above the turn', () => {
    expect(turnScrollTop({ margin: TURN_TOP_MARGIN_PX, scrollTop: 1000, turnTop: 600, viewportTop: 100 })).toBe(
      1500 - TURN_TOP_MARGIN_PX
    )
  })

  it('never asks for a negative scrollTop', () => {
    // The first turn of a thread, with the margin pulling past the top.
    expect(turnScrollTop({ margin: TURN_TOP_MARGIN_PX, scrollTop: 0, turnTop: 100, viewportTop: 100 })).toBe(0)
  })
})

describe('landingVerdict', () => {
  it('settles once the turn has held still with nothing left in flight', () => {
    expect(landingVerdict(SETTLED)).toBe('settled')
  })

  it('keeps correcting while the turn is still moving', () => {
    expect(landingVerdict({ ...SETTLED, deltaPx: 40, stableFrames: 0 })).toBe('correct')
  })

  it('keeps correcting when it has only just stopped', () => {
    expect(landingVerdict({ ...SETTLED, stableFrames: 1 })).toBe('correct')
  })

  it('keeps correcting while media is still resolving, however still it looks', () => {
    // The reason distance alone is not enough: an image that has not loaded
    // holds the rows below it at the wrong height without moving them.
    expect(landingVerdict({ ...SETTLED, pendingMedia: 3 })).toBe('correct')
  })

  it('gives up at the cap rather than chasing forever', () => {
    expect(landingVerdict({ ...SETTLED, deltaPx: 40, elapsedMs: LANDING_CAP_MS, stableFrames: 0 })).toBe('timeout')
  })

  it('prefers a real settle to the cap when both are true', () => {
    expect(landingVerdict({ ...SETTLED, elapsedMs: LANDING_CAP_MS })).toBe('settled')
  })
})

describe('turnStartElement', () => {
  it('climbs from the sticky human bubble to the turn wrapper', () => {
    const host = document.createElement('div')
    host.innerHTML = `
      <div data-slot="${TURN_PAIR_SLOT}" id="pair">
        <div data-message-id="m1" id="bubble"></div>
      </div>`

    const bubble = host.querySelector<HTMLElement>('#bubble')!

    expect(turnStartElement(bubble).id).toBe('pair')
  })

  it('falls back to the node for a message with no turn wrapper', () => {
    // Standalone messages — anything not led by a human prompt — get no wrapper.
    const host = document.createElement('div')
    host.innerHTML = '<div data-message-id="m1" id="lone"></div>'

    const lone = host.querySelector<HTMLElement>('#lone')!

    expect(turnStartElement(lone).id).toBe('lone')
  })
})
