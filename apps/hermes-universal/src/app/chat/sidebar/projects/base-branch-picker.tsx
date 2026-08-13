import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  dropdownMenuRow,
  DropdownMenuSearch,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import type { HermesGitBaseBranch } from '@/global'
import { useI18n } from '@/i18n'
import { registerRepoStatusCwd, repoStatusForCwd } from '@/store/coding-status'
import { notifyError } from '@/store/notifications'
import { listBaseBranches } from '@/store/projects'

// Filterable picker for the base branch of a new worktree. Lists local +
// remote-tracking branches, defaults to the default branch (origin/HEAD, or
// local main/master when no remote). The current session's branch is sorted to
// the top so it's one click away. The parent owns the selected value via
// `value` / `onValueChange`.
//
// Ported from desktop, with one substitution: desktop builds the combobox from
// cmdk (`components/ui/command`), which universal doesn't carry. A
// `DropdownMenuSearch` + filtered `DropdownMenuItem` list is the idiom universal
// already uses for exactly this shape (see app/shell/model-menu-panel), and it
// keeps arrow/enter/escape navigation without a new dependency.
export function BaseBranchPicker({
  disabled,
  repoPath,
  onValueChange,
  value
}: {
  disabled?: boolean
  repoPath: string
  onValueChange: (value: string) => void
  value: string
}) {
  const { t } = useI18n()
  const p = t.sidebar.projects
  // The dialog can be opened from a tile's rail, so the branch pinned to the top
  // is the one checked out in THIS repo — not whatever the sidebar has selected.
  const repoStatus = useStore(repoStatusForCwd(repoPath))
  const [branches, setBranches] = useState<HermesGitBaseBranch[]>([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')

  const currentBranch = repoStatus?.detached ? null : (repoStatus?.branch ?? null)

  // Nothing else guarantees this repo has been probed — the dialog can target a
  // project root that no rail is sitting in — so ask for it while we're open.
  useEffect(() => registerRepoStatusCwd(repoPath), [repoPath])

  const load = useCallback(async () => {
    if (!repoPath) {
      return
    }

    setLoading(true)

    try {
      const list = await listBaseBranches(repoPath)
      setBranches(list)

      // Default to the remote default (origin/HEAD). Fall back to the local
      // default branch (main/master) when no remote exists. The value is always
      // a concrete branch — never undefined.
      const defaultBranch = list.find(branch => branch.isDefault)

      onValueChange(defaultBranch?.name ?? list[0]?.name ?? '')
    } catch (err) {
      // Swallowing this left the trigger reading "branch off " with an empty
      // value, and submitting then sent no `base` at all — so the new worktree
      // was cut from whatever HEAD happened to be, not the trunk. A non-repo
      // folder answers with an empty list rather than an error, so reaching here
      // really does mean the call failed.
      setBranches([])
      notifyError(err, p.branchesFailed)
    } finally {
      setLoading(false)
    }
  }, [onValueChange, p.branchesFailed, repoPath])

  // Load on mount so the default branch fills in before the user opens the
  // menu — otherwise the button reads "branch off " with nothing after it.
  useEffect(() => {
    if (branches.length === 0 && !loading) {
      void load()
    }
  }, [branches.length, loading, load])

  // Pin the current session's branch to the top, keep the rest in git's
  // most-recently-committed order.
  const sorted = useMemo(() => {
    if (!currentBranch) {
      return branches
    }

    const idx = branches.findIndex(branch => branch.name === currentBranch)

    if (idx <= 0) {
      return branches
    }

    return [branches[idx], ...branches.slice(0, idx), ...branches.slice(idx + 1)]
  }, [branches, currentBranch])

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()

    return needle ? sorted.filter(branch => branch.name.toLowerCase().includes(needle)) : sorted
  }, [search, sorted])

  // The i18n function returns { before, after } so the branch name can be
  // wrapped in its own styled (underlined) span — works for any word order.
  const parts = p.branchOff()

  return (
    <div className="space-y-1.5">
      <DropdownMenu
        onOpenChange={next => {
          if (next) {
            setSearch('')

            if (branches.length === 0 && !loading) {
              void load()
            }
          }

          setOpen(next)
        }}
        open={open}
      >
        <DropdownMenuTrigger asChild>
          <Button
            className="group flex w-full min-w-0 items-center justify-start gap-1.5 hover:text-muted-foreground hover:no-underline"
            disabled={disabled || loading}
            size="inline"
            variant="text"
          >
            <Codicon className="shrink-0 text-(--ui-text-tertiary)" name="git-branch" size="0.8rem" />
            <span className="shrink-0">{parts.before}</span>
            <span className="shrink-0 text-primary decoration-current/20 underline-offset-4 group-hover:underline">
              {loading ? '...' : value}
            </span>
            <Codicon className="shrink-0 text-(--ui-text-tertiary)" name="chevron-down" size="0.75rem" />
            <span className="shrink-0">{parts.after}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="max-h-72 w-(--radix-dropdown-menu-trigger-width) min-w-56 overflow-y-auto p-0"
        >
          <DropdownMenuSearch
            aria-label={p.baseBranchPlaceholder}
            onValueChange={setSearch}
            placeholder={p.baseBranchPlaceholder}
            value={search}
          />
          <DropdownMenuSeparator className="mx-0" />

          {filtered.length === 0 ? (
            <div className="px-2.5 py-2 text-xs text-(--ui-text-tertiary)">{p.baseBranchNone}</div>
          ) : (
            filtered.map(branch => (
              <DropdownMenuItem
                className={dropdownMenuRow}
                key={branch.name}
                onSelect={() => {
                  onValueChange(branch.name)
                  setOpen(false)
                }}
              >
                <Codicon
                  className="shrink-0 text-(--ui-text-tertiary)"
                  name={branch.isRemote ? 'repo' : 'git-branch'}
                  size="0.8rem"
                />
                {branch.isDefault && <span className="shrink-0 text-[0.625rem] text-(--ui-text-tertiary)">★</span>}
                <span className="truncate">{branch.name}</span>
                {value === branch.name && (
                  <Codicon className="ms-auto shrink-0 text-(--ui-accent)" name="check" size="0.8rem" />
                )}
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
