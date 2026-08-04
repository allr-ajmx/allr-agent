import { beforeEach, describe, expect, it, vi } from 'vitest'

import { requestComposerInsert } from '@/app/chat/composer/focus'
import { $currentCwd, resetChat, setCurrentCwd } from '@/store/chat'
import { $startWorkSessionRequest, requestStartWorkSession } from '@/store/projects'

vi.mock('@/app/chat/composer/focus', () => ({ requestComposerInsert: vi.fn() }))

// Side-effect import: registers the $startWorkSessionRequest listener.
import '@/store/start-work-session'

beforeEach(() => {
  vi.mocked(requestComposerInsert).mockClear()
  $startWorkSessionRequest.set(null)
  resetChat()
  setCurrentCwd('')
})

describe('start-work session hand-off', () => {
  it('anchors a fresh chat to the new worktree and carries the draft over', () => {
    requestStartWorkSession('/repo/.worktrees/feature-x', 'fix the flake')

    // The anchor is the NEW draft's own slice cwd — written after the reset, so
    // `ensureSession` reads it back and creates the session inside the worktree.
    expect($currentCwd.get()).toBe('/repo/.worktrees/feature-x')
    expect(requestComposerInsert).toHaveBeenCalledWith('fix the flake', { target: 'main' })
  })

  it('opens the worktree without touching the composer when there is no draft', () => {
    requestStartWorkSession('/repo/.worktrees/feature-y')

    expect($currentCwd.get()).toBe('/repo/.worktrees/feature-y')
    expect(requestComposerInsert).not.toHaveBeenCalled()
  })

  it('does not leak the anchor into the next chat', () => {
    requestStartWorkSession('/repo/.worktrees/feature-z')
    expect($currentCwd.get()).toBe('/repo/.worktrees/feature-z')

    // A fresh draft owns its own slice; the worktree it was opened from has no
    // claim on it (this is what the old module-level anchor atom got wrong).
    resetChat()

    expect($currentCwd.get()).not.toBe('/repo/.worktrees/feature-z')
  })
})
