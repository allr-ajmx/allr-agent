import type * as React from 'react'

import type { SessionInfo } from '@/types/hermes'

import { flattenProjectSessions, type SidebarProjectTree } from './model'

// The entered project's sessions, flattened newest-first across its repos/lanes.
// (Desktop nests linked git worktrees into their own lanes via a `repoWorktrees`
// prop + `mergeRepoWorktreeGroups`/`overlayRepoLanes`; here the backend tree is
// rendered flat — FIXME(MJX-107) for lane nesting.)
export function EnteredProjectContent({
  project,
  renderRows
}: {
  project: SidebarProjectTree
  renderRows: (sessions: SessionInfo[]) => React.ReactNode
}) {
  return <>{renderRows(flattenProjectSessions(project))}</>
}
