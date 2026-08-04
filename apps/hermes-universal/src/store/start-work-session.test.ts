import { beforeEach, describe, expect, it, vi } from 'vitest'

import { requestComposerInsert } from '@/app/chat/composer/focus'
import { $currentCwd, resetChat, setCurrentCwd } from '@/store/chat'
import { $startWorkSessionRequest, requestStartWorkSession } from '@/store/projects'
import { startSessionInWorkspace } from '@/store/session'

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

  // The SIDEBAR hand-off ("start work" in the project header) calls
  // `startSessionInWorkspace` straight from a click handler. Unlike the composer
  // path — which runs inside a `$startWorkSessionRequest` listener, where
  // nanostores coalesces nested writes — nothing collapses the writes here, so a
  // seed-then-correct sequence publishes the in-between directory for real.
  it('never publishes an intermediate directory on the sidebar hand-off', () => {
    setCurrentCwd('/previous/repo')

    const seen: string[] = []
    const unbind = $currentCwd.listen(cwd => seen.push(cwd))

    startSessionInWorkspace('/repo/.worktrees/feature-a')
    unbind()

    // One publish, straight to the target. An extra '' (or the configured
    // default dir) in front is what made `$effectiveCwd` fall back to the
    // workspace root, flipping the statusbar path and the file tree to a
    // directory the user never chose until the first prompt re-notified them.
    expect(seen).toEqual(['/repo/.worktrees/feature-a'])
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
