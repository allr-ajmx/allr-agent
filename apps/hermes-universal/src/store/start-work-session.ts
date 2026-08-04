import { requestComposerInsert } from '@/app/chat/composer/focus'
import { $startWorkSessionRequest } from '@/store/projects'
import { startSessionInWorkspace } from '@/store/session'

// Composer "branch off into a new worktree" hand-off, ported from desktop's
// contrib wiring effect. The composer owns the draft and creates the worktree
// (store/projects `startWorkInRepo`); this side is the session half: open a
// fresh chat anchored to the just-created tree, then put the task that kicked it
// off back into the composer.
//
// A module-level `listen` rather than a React effect (desktop's shape) because
// the hand-off must land regardless of which shell is mounted — and `listen`,
// unlike `subscribe`, doesn't replay the current value at import time. The token
// guard is belt-and-braces for a request that somehow re-emits unchanged.

let lastToken = 0

$startWorkSessionRequest.listen(request => {
  if (!request || request.token === lastToken) {
    return
  }

  lastToken = request.token
  startSessionInWorkspace(request.path)

  if (request.draft) {
    requestComposerInsert(request.draft, { target: 'main' })
  }
})
