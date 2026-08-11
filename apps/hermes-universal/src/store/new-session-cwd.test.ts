/**
 * MJXHRM-393: ⌘N / ⌘T opened a chat detached from the project the user was
 * standing in. The scope atom and the repo-root helper both already existed —
 * what was missing was the resolver between them, and its use at the two entry
 * points that were not the sidebar's own per-lane `+`.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { NO_PROJECT_ID } from '@/app/chat/sidebar/projects/workspace-groups'
import { $projectScope, $projectTree, ALL_PROJECTS, resolveNewSessionCwd } from '@/store/projects'

const project = (id: string, path: null | string, repoPath?: string) => ({
  id,
  label: id,
  path,
  repos: repoPath ? [{ id: `${id}-repo`, label: 'repo', path: repoPath, groups: [], sessionCount: 0 }] : [],
  sessionCount: 0
})

beforeEach(() => {
  $projectScope.set(ALL_PROJECTS)
  $projectTree.set([])
})

describe('resolveNewSessionCwd', () => {
  it('defers when the sidebar is not scoped to a project', () => {
    // '' means "no opinion" — `resetChat` then applies the configured default
    // project dir, which is the behaviour that existed before.
    expect(resolveNewSessionCwd()).toBe('')
  })

  it('is detached on purpose inside the Home / no-project bucket', () => {
    $projectScope.set(NO_PROJECT_ID)
    $projectTree.set([project('p_1', '/repos/one')])

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

  it('defers when the scoped project is not in the tree yet', () => {
    $projectScope.set('p_missing')

    expect(resolveNewSessionCwd()).toBe('')
  })
})
