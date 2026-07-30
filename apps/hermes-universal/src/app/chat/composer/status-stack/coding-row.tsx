// STUB — FIXME(MJX-106): the desktop CodingStatusRow (branch / worktree status +
// branch-off / convert / switch actions) is not ported yet. This is UI-only work:
// the data is already here — `store/coding-status.ts` exports `$repoStatus` and
// `$repoWorktrees`, and `lib/desktop-git.ts` exposes `repoStatus`/`branchList`/
// `branchSwitch`/`worktreeList` over the gateway's `/api/git/*`. Rendered as
// nothing meanwhile; kept as a file so the composer's import site mirrors
// desktop's structure. Needs `WorktreeDialog` too — shared with MJX-107.
//
// Accepts (and ignores) the desktop ChatBar's handler props so index.tsx wires
// up verbatim; every prop is optional so the null render never touches them.
interface CodingStatusRowProps {
  onBranchOff?: (...args: any[]) => any

  onConvertBranch?: (...args: any[]) => any

  onListBranches?: (...args: any[]) => any

  onOpen?: (...args: any[]) => any

  onOpenWorktree?: (...args: any[]) => any

  onSwitchBranch?: (...args: any[]) => any
}

export function CodingStatusRow(_props: CodingStatusRowProps = {}) {
  return null
}
