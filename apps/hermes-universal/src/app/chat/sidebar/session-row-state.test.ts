import { describe, expect, it } from 'vitest'

import { sessionDotState, sessionShowsRunningArc } from './session-row-state'

const base = { isStalled: false, isUnread: false, isWorking: false, needsInput: false }

describe('sessionDotState', () => {
  it('falls back to idle when nothing is happening', () => {
    expect(sessionDotState(base)).toBe('idle')
  })

  it('shows unread when a background turn finished unseen', () => {
    expect(sessionDotState({ ...base, isUnread: true })).toBe('unread')
  })

  it('shows working while a turn streams', () => {
    expect(sessionDotState({ ...base, isWorking: true })).toBe('working')
  })

  it('shows stalled when a running turn has gone quiet', () => {
    expect(sessionDotState({ ...base, isStalled: true, isWorking: true })).toBe('stalled')
  })

  it('ignores a stale stall flag when the session is not working', () => {
    expect(sessionDotState({ ...base, isStalled: true })).toBe('idle')
  })

  it('lets a blocking prompt outrank a running turn', () => {
    expect(sessionDotState({ ...base, isStalled: true, isUnread: true, isWorking: true, needsInput: true })).toBe(
      'needs-input'
    )
  })

  it('lets a running turn outrank an unread marker', () => {
    expect(sessionDotState({ ...base, isUnread: true, isWorking: true })).toBe('working')
  })
})

describe('sessionShowsRunningArc', () => {
  it('draws the arc for a running turn', () => {
    expect(sessionShowsRunningArc({ isWorking: true, needsInput: false })).toBe(true)
  })

  it('drops the arc once a prompt blocks the turn', () => {
    expect(sessionShowsRunningArc({ isWorking: true, needsInput: true })).toBe(false)
  })

  it('draws nothing when idle', () => {
    expect(sessionShowsRunningArc({ isWorking: false, needsInput: false })).toBe(false)
  })
})
