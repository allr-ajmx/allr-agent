/**
 * MJXHRM-393: a fresh chat opened detached from the project the user was
 * standing in.
 *
 * The first pass resolved the scope at TWO call sites (⌘N and ⌘T) and left the
 * resolver returning `''` for both "Home, detached on purpose" and "no opinion,
 * use the configured default dir". Two things followed from that, and both are
 * pinned here:
 *
 *  - the mobile bubble strip's new chat never came through either call site, so
 *    ⌘N on a phone stayed detached from the project exactly as before;
 *  - the Home branch was DEAD. `''` fell through to the configured default dir
 *    in `resetChat`, and again in `ensureSession` on first send.
 *
 * So these tests deliberately assert the COMPOSED result — the directory the
 * draft slice ends up with, and the one `session.create` is actually called with
 * — not just the resolver's return value. Testing the resolver alone is what let
 * the Home branch ship broken.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/store/gateway', async () => {
  const { atom } = await import('@/store/atom')

  return {
    addGatewayEventListener: () => () => {},
    requestGateway: vi.fn().mockResolvedValue({ session_id: 's_1' }),
    $gatewayState: atom('idle')
  }
})

import { $currentCwd, ensureSession, resetChat } from '@/store/chat'
import { $chatBubbles, newChatBubble } from '@/store/chat-bubbles'
import { $defaultProjectDir } from '@/store/default-project-dir'
import { requestGateway } from '@/store/gateway'
import { NO_PROJECT_ID } from '@/store/project-scope'
import { $projectScope, $projectTree, ALL_PROJECTS, resolveNewSessionCwd } from '@/store/projects'
import { $activeStoredSessionId, newSession } from '@/store/session'
import { resetSessionStates } from '@/test-sessions'

const project = (id: string, path: null | string, repoPath?: string) => ({
  id,
  label: id,
  path,
  repos: repoPath ? [{ id: `${id}-repo`, label: 'repo', path: repoPath, groups: [], sessionCount: 0 }] : [],
  sessionCount: 0
})

/** The default project dir is LOCAL-ONLY by design (`cwdForNewSession`), so the
 *  fallback rung of the ladder only exists on a local gateway. */
const configureDefaultDir = (dir: string) => {
  localStorage.setItem('hermes.gateway.mode', 'local')
  $defaultProjectDir.set(dir)
}

/** The cwd `session.create` was actually asked for — `undefined` when the RPC
 *  carried no `cwd` at all, which is what "detached" means on the wire. */
const createdCwd = () => {
  const call = vi.mocked(requestGateway).mock.calls.find(([method]) => method === 'session.create')

  return (call?.[1] as { cwd?: string } | undefined)?.cwd
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  $projectScope.set(ALL_PROJECTS)
  $projectTree.set([])
  $defaultProjectDir.set(null)
  $chatBubbles.set([])
  resetSessionStates()
  $activeStoredSessionId.set(null)
})

describe('resolveNewSessionCwd', () => {
  it('is the configured default project dir when the sidebar is not scoped', () => {
    configureDefaultDir('/home/user/configured')

    expect(resolveNewSessionCwd()).toBe('/home/user/configured')
  })

  it('is empty when nothing is scoped and no default dir is configured', () => {
    expect(resolveNewSessionCwd()).toBe('')
  })

  it("uses the scoped project's own folder", () => {
    $projectTree.set([project('p_1', '/repos/one'), project('p_2', '/repos/two')])
    $projectScope.set('p_2')

    expect(resolveNewSessionCwd()).toBe('/repos/two')
  })

  it("falls back to the project's first repo when it has no folder of its own", () => {
    $projectTree.set([project('p_3', null, '/repos/three')])
    $projectScope.set('p_3')

    expect(resolveNewSessionCwd()).toBe('/repos/three')
  })

  // The project's root OUTRANKS the configured default — otherwise drilling into
  // a project would change nothing for anyone who has a default dir set, which
  // is the ticket.
  it('prefers the scoped project over the configured default dir', () => {
    configureDefaultDir('/home/user/configured')
    $projectTree.set([project('p_1', '/repos/one')])
    $projectScope.set('p_1')

    expect(resolveNewSessionCwd()).toBe('/repos/one')
  })

  // A cold start can have a scope persisted from last run before the tree has
  // landed. Deferring to the default dir beats inventing a directory.
  it('falls through to the default dir when the scoped project is not in the tree yet', () => {
    configureDefaultDir('/home/user/configured')
    $projectScope.set('p_missing')

    expect(resolveNewSessionCwd()).toBe('/home/user/configured')
  })

  // THE BRANCH THAT SHIPPED DEAD. Home means "no folder", and it has to beat the
  // configured default — attaching one would silently move the chat out of the
  // bucket the user is standing in.
  it('stays detached in the Home bucket even with a default dir configured', () => {
    configureDefaultDir('/home/user/configured')
    $projectScope.set(NO_PROJECT_ID)
    $projectTree.set([project('p_1', '/repos/one')])

    expect(resolveNewSessionCwd()).toBe('')
  })
})

describe('every fresh draft, not just the two entry points that remembered', () => {
  it('seeds a plain newSession() from the sidebar scope', () => {
    $projectTree.set([project('p_1', '/repos/one')])
    $projectScope.set('p_1')

    newSession()

    expect($currentCwd.get()).toBe('/repos/one')
  })

  // The mobile half of ⌘N. It never passed through `startNewSession`'s desktop
  // branch, so resolving at that call site left the phone exactly as broken.
  it('seeds the mobile bubble strip’s new chat from the sidebar scope', () => {
    $projectTree.set([project('p_1', '/repos/one')])
    $projectScope.set('p_1')
    $activeStoredSessionId.set('a')

    newChatBubble()

    expect($chatBubbles.get().map(b => b.storedSessionId)).toEqual(['a', null])
    expect($currentCwd.get()).toBe('/repos/one')
  })

  it('leaves an explicit anchor alone', () => {
    $projectTree.set([project('p_1', '/repos/one')])
    $projectScope.set('p_1')

    resetChat('/repos/one/.worktrees/feature')

    expect($currentCwd.get()).toBe('/repos/one/.worktrees/feature')
  })
})

describe('the Home bucket stays detached at BOTH layers', () => {
  beforeEach(() => {
    configureDefaultDir('/home/user/configured')
    $projectScope.set(NO_PROJECT_ID)
  })

  it('does not seed the draft with the configured default dir', () => {
    newSession()

    expect($currentCwd.get()).toBe('')
  })

  // The second layer, and the one that would have undone the first on its own:
  // `ensureSession` re-resolves at send time, and it used to re-apply the
  // default dir to any draft whose slice cwd was empty.
  it('creates the backend session with no cwd at all', async () => {
    newSession()
    await ensureSession()

    expect(createdCwd()).toBeUndefined()
  })

  it('still carries a scoped project through to session.create', async () => {
    $projectTree.set([project('p_1', '/repos/one')])
    $projectScope.set('p_1')

    newSession()
    await ensureSession()

    expect(createdCwd()).toBe('/repos/one')
  })
})
