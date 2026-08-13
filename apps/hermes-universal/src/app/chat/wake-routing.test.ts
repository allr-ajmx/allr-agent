/**
 * Where a wake phrase lands.
 *
 * The bug this replaces was silent: `wake.detected` carries the profile whose
 * phrase fired, the client received it, and the conversation opened in whatever
 * chat was on screen under whatever profile the app was already in. So the
 * assertions worth making are about ROUTING, and each one is written so it fails
 * if the profile is dropped again — the fields must hold DIFFERENT values, or a
 * "routed correctly" test passes on a router that does nothing.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { WakeDetection } from '@/store/wake-word'

const newSessionInProfile = vi.fn()
const startNewSession = vi.fn()
const announceProfileChatScope = vi.fn()

vi.mock('@/store/new-session', () => ({
  newSessionInProfile: (name: string) => newSessionInProfile(name),
  startNewSession: () => startNewSession()
}))

vi.mock('@/store/profile-chat-scope', () => ({
  announceProfileChatScope: (target: null | string) => announceProfileChatScope(target)
}))

const detection = (over: Partial<WakeDetection> = {}): WakeDetection => ({
  phrase: 'hey hermes',
  profile: null,
  startNewSession: true,
  ...over
})

/** The app is operating as `scout`, so a `research` phrase is a real crossing. */
async function setActive(profile: null | string): Promise<void> {
  const { setActiveProfile } = await import('@/store/profiles')
  setActiveProfile(profile)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('routeWakeDetection', () => {
  it("opens a chat in the phrase's OWN profile, not the active one", async () => {
    await setActive('scout')
    const { routeWakeDetection } = await import('./wake-routing')

    routeWakeDetection(detection({ phrase: 'hey research', profile: 'research' }))

    expect(newSessionInProfile).toHaveBeenCalledWith('research')
    expect(startNewSession).not.toHaveBeenCalled()
  })

  it('says what happened to the live chat, because re-scoping does not move it', async () => {
    await setActive('scout')
    const { routeWakeDetection } = await import('./wake-routing')

    routeWakeDetection(detection({ profile: 'research' }))

    expect(announceProfileChatScope).toHaveBeenCalledWith('research')
  })

  it('names the default profile as null, the shape the connection layer wants', async () => {
    await setActive('scout')
    const { routeWakeDetection } = await import('./wake-routing')

    routeWakeDetection(detection({ profile: 'default' }))

    expect(newSessionInProfile).toHaveBeenCalledWith('default')
    expect(announceProfileChatScope).toHaveBeenCalledWith(null)
  })

  it('does not re-scope for a phrase belonging to the profile already active', async () => {
    await setActive('scout')
    const { routeWakeDetection } = await import('./wake-routing')

    routeWakeDetection(detection({ profile: 'scout' }))

    expect(newSessionInProfile).not.toHaveBeenCalled()
    expect(announceProfileChatScope).not.toHaveBeenCalled()
    // Still a fresh chat — `start_new_session` is a separate decision.
    expect(startNewSession).toHaveBeenCalledTimes(1)
  })

  it('treats the primary gateway profile and the name "default" as the same profile', async () => {
    await setActive(null)
    const { routeWakeDetection } = await import('./wake-routing')

    routeWakeDetection(detection({ profile: 'default' }))

    expect(newSessionInProfile).not.toHaveBeenCalled()
    expect(startNewSession).toHaveBeenCalledTimes(1)
  })

  it('honours start_new_session: false by continuing the chat on screen', async () => {
    await setActive('scout')
    const { routeWakeDetection } = await import('./wake-routing')

    routeWakeDetection(detection({ startNewSession: false }))

    expect(startNewSession).not.toHaveBeenCalled()
    expect(newSessionInProfile).not.toHaveBeenCalled()
  })

  it('still leaves for a cross-profile phrase even when start_new_session is false', async () => {
    await setActive('scout')
    const { routeWakeDetection } = await import('./wake-routing')

    // "Stay in the current chat" cannot mean "put research's turn inside
    // scout's conversation" — the current chat is what the phrase is leaving.
    routeWakeDetection(detection({ profile: 'research', startNewSession: false }))

    expect(newSessionInProfile).toHaveBeenCalledWith('research')
  })

  it('ignores a blank profile from a single-phrase engine', async () => {
    await setActive('scout')
    const { routeWakeDetection } = await import('./wake-routing')

    routeWakeDetection(detection({ profile: '  ' }))

    expect(newSessionInProfile).not.toHaveBeenCalled()
    expect(startNewSession).toHaveBeenCalledTimes(1)
  })
})
