import { beforeEach, describe, expect, it, vi } from 'vitest'

import { requestComposerInsert } from '@/app/chat/composer/focus'
import { $currentCwd, $newChatWorkspaceCwd } from '@/store/chat'
import { $startWorkSessionRequest, requestStartWorkSession } from '@/store/projects'

vi.mock('@/app/chat/composer/focus', () => ({ requestComposerInsert: vi.fn() }))

// Side-effect import: registers the $startWorkSessionRequest listener.
import '@/store/start-work-session'

beforeEach(() => {
  vi.mocked(requestComposerInsert).mockClear()
  $startWorkSessionRequest.set(null)
  $newChatWorkspaceCwd.set(null)
  $currentCwd.set('')
})

describe('start-work session hand-off', () => {
  it('anchors a fresh chat to the new worktree and carries the draft over', () => {
    requestStartWorkSession('/repo/.worktrees/feature-x', 'fix the flake')

    // The anchor survives the newSession() reset so the first prompt's
    // session.create runs inside the worktree.
    expect($newChatWorkspaceCwd.get()).toBe('/repo/.worktrees/feature-x')
    expect($currentCwd.get()).toBe('/repo/.worktrees/feature-x')
    expect(requestComposerInsert).toHaveBeenCalledWith('fix the flake', { target: 'main' })
  })

  it('opens the worktree without touching the composer when there is no draft', () => {
    requestStartWorkSession('/repo/.worktrees/feature-y')

    expect($newChatWorkspaceCwd.get()).toBe('/repo/.worktrees/feature-y')
    expect(requestComposerInsert).not.toHaveBeenCalled()
  })
})
