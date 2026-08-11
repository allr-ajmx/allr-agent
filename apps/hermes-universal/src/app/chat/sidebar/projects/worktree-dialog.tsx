import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { RowButton } from '@/components/ui/row-button'
import { SanitizedInput } from '@/components/ui/sanitized-input'
import { SearchField } from '@/components/ui/search-field'
import type { HermesGitBranch } from '@/global'
import { useI18n } from '@/i18n'
import { gitRef } from '@/lib/sanitize'
import { notifyError } from '@/store/notifications'
import {
  $projectTree,
  $worktreeDialog,
  closeWorktreeDialog,
  listRepoBranches,
  projectIdForCwd,
  projectRootCwd,
  requestStartWorkSession,
  startWorkInRepo,
  switchBranchInRepo
} from '@/store/projects'

import { BaseBranchPicker } from './base-branch-picker'

interface BranchActionCopy {
  branchCreateWorktree: string
  branchOpenExisting: string
  branchSwitchHome: string
  branchTrackRemote: string
}

/**
 * What selecting this row will actually do. A remote-only row (`origin/foo`,
 * no local head) does NOT just open a worktree: the gateway first creates a
 * local `foo` tracking it, so it gets its own label rather than borrowing
 * "create worktree".
 *
 * Exported for the unit test — the branching is the whole contract of the row.
 */
export const branchActionLabel = (branch: HermesGitBranch, copy: BranchActionCopy) => {
  if (branch.checkedOut) {
    return copy.branchOpenExisting
  }

  if (branch.isRemote) {
    return copy.branchTrackRemote
  }

  return branch.isDefault ? copy.branchSwitchHome : copy.branchCreateWorktree
}

/**
 * The "new worktree" dialog. It is mounted exactly ONCE, in the sidebar beside
 * ProjectDialog, and the `$worktreeDialog` atom drives it. Every entry point
 * (⌘⇧B, the coding rail's kebab, the sidebar's + button) publishes its intent to
 * that atom; no entry point mounts its own copy. N composers on screen used to
 * give N stacked dialogs for one keypress.
 *
 * Features:
 * - Project picker: change the repo before you name the branch
 * - Branch name input (sanitized as a git ref)
 * - Base branch picker (BaseBranchPicker)
 * - Convert mode: check out an existing branch into a worktree
 *
 * Ported from desktop. Desktop's pickers are cmdk `Command` comboboxes;
 * universal has no cmdk, so both are a `SearchField` over a plain filtered list
 * here — same substring filter, same labels.
 */
export function WorktreeDialog() {
  const { t } = useI18n()
  const p = t.sidebar.projects
  const state = useStore($worktreeDialog)
  const open = state !== null
  const projectTree = useStore($projectTree)

  const [name, setName] = useState('')
  const [pending, setPending] = useState(false)
  const [convertMode, setConvertMode] = useState(false)
  const [branches, setBranches] = useState<HermesGitBranch[]>([])
  const [branchesLoading, setBranchesLoading] = useState(false)
  const [branchFilter, setBranchFilter] = useState('')
  const [selectedBase, setSelectedBase] = useState('')
  // The repo the dialog targets. Seeded from the resolved intent, then owned by
  // this component so the project picker can retarget without a reopen.
  const [repoPath, setRepoPath] = useState('')
  const [projectOpen, setProjectOpen] = useState(false)
  const [projectFilter, setProjectFilter] = useState('')

  // Every project with a working root is a valid target, deduped by path — an
  // auto project and a user project can share one folder.
  const projectOptions = useMemo(() => {
    const seen = new Set<string>()

    return projectTree.flatMap(node => {
      const path = projectRootCwd(node)

      if (!path || seen.has(path)) {
        return []
      }

      seen.add(path)

      return [{ id: node.id, label: node.label, path }]
    })
  }, [projectTree])

  // The project that owns the target repo. `repoPath` is often a linked worktree
  // (`<repo>/.worktrees/<branch>`), and no project row has that exact path, so an
  // equality test against the rows matches nothing and the label falls back to
  // the last path segment — which is the name of the BRANCH, not the project.
  // Ask which project owns the path instead, then fall back to a path match: two
  // projects can share a folder and the dedupe above keeps only the first, so the
  // owner's own row can be the one it dropped.
  const activeOption = useMemo(() => {
    const owner = projectTree.length > 0 ? projectIdForCwd(repoPath) : null

    return projectOptions.find(o => o.id === owner) ?? projectOptions.find(o => o.path === repoPath) ?? null
  }, [projectOptions, projectTree, repoPath])

  const activeProjectLabel = activeOption?.label ?? repoPath.split('/').pop() ?? repoPath

  const filteredProjects = useMemo(() => {
    const needle = projectFilter.trim().toLowerCase()

    return needle ? projectOptions.filter(o => `${o.label} ${o.path}`.toLowerCase().includes(needle)) : projectOptions
  }, [projectFilter, projectOptions])

  // Reset to a fresh state each time the dialog opens, applying the resolved
  // repo and the base branch the caller selected (e.g. "branch off from main" in
  // the coding row's dropdown menu).
  useEffect(() => {
    if (state) {
      setName('')
      setConvertMode(false)
      setBranchFilter('')
      setProjectFilter('')
      setSelectedBase(state.base ?? '')
      setRepoPath(state.repoPath)
      setBranches([])
    }
  }, [state])

  const onOpenChange = (next: boolean) => {
    if (!next && !pending) {
      closeWorktreeDialog()
    }
  }

  const loadBranches = useCallback(async () => {
    if (!repoPath) {
      return
    }

    setBranchesLoading(true)

    try {
      setBranches(await listRepoBranches(repoPath))
    } catch (err) {
      // An empty list is a legitimate answer (a repo with no other branches), so
      // failing silently made a dead gateway look like an empty repo — with a
      // "no branches" placeholder and nothing to act on. Say which it was.
      setBranches([])
      notifyError(err, p.branchesFailed)
    } finally {
      setBranchesLoading(false)
    }
  }, [p.branchesFailed, repoPath])

  // Give the new worktree to a fresh session, then close the dialog.
  const started = (path: string) => {
    requestStartWorkSession(path)
    closeWorktreeDialog()
  }

  const submit = async () => {
    const branch = name.trim()

    if (pending || !repoPath || !branch) {
      return
    }

    setPending(true)

    try {
      const result = await startWorkInRepo(repoPath, { base: selectedBase || undefined, branch, name: branch })

      if (result) {
        started(result.path)
        setName('')
      }
    } catch (err) {
      notifyError(err, p.startWorkFailed)
    } finally {
      setPending(false)
    }
  }

  const convert = async (branch: HermesGitBranch) => {
    if (pending || !repoPath || !branch) {
      return
    }

    setPending(true)

    try {
      let result: null | { branch: string; path: string }

      if (branch.worktreePath) {
        result = { branch: branch.name, path: branch.worktreePath }
      } else if (branch.isDefault) {
        await switchBranchInRepo(repoPath, branch.name)
        result = { branch: branch.name, path: repoPath }
      } else {
        result = await startWorkInRepo(repoPath, { existingBranch: branch.name })
      }

      if (result) {
        started(result.path)
      }
    } catch (err) {
      notifyError(err, p.startWorkFailed)
    } finally {
      setPending(false)
    }
  }

  const enterConvert = () => {
    setConvertMode(true)
    setBranchFilter('')
    void loadBranches()
  }

  const filteredBranches = useMemo(() => {
    const needle = branchFilter.trim().toLowerCase()

    return needle ? branches.filter(branch => branch.name.toLowerCase().includes(needle)) : branches
  }, [branchFilter, branches])

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{convertMode ? p.convertBranchTitle : p.newWorktreeTitle}</DialogTitle>
          <DialogDescription>{convertMode ? p.convertBranchDesc : p.newWorktreeDesc}</DialogDescription>
        </DialogHeader>

        {/* Project picker: change the repo the worktree is cut from. Shown only
            when there is another project to pick. */}
        {projectOptions.length > 1 && (
          <Popover onOpenChange={setProjectOpen} open={projectOpen}>
            <PopoverTrigger asChild>
              <Button
                className="group flex w-full min-w-0 items-center justify-start gap-1.5 hover:text-muted-foreground hover:no-underline"
                disabled={pending}
                size="inline"
                variant="text"
              >
                <Codicon className="shrink-0 text-(--ui-text-tertiary)" name="folder" size="0.8rem" />
                <span className="shrink-0">{p.worktreeProjectLabel}</span>
                <span className="truncate text-primary decoration-current/20 underline-offset-4 group-hover:underline">
                  {activeProjectLabel}
                </span>
                <Codicon className="shrink-0 text-(--ui-text-tertiary)" name="chevron-down" size="0.75rem" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="z-(--z-modal-popover) min-w-(--radix-popover-trigger-width) p-0">
              <SearchField
                containerClassName="w-full px-2"
                onChange={setProjectFilter}
                placeholder={p.worktreeProjectPlaceholder}
                value={projectFilter}
              />
              <div className="max-h-64 overflow-y-auto border-t border-(--ui-stroke-tertiary) p-1">
                {filteredProjects.length === 0 ? (
                  <div className="px-2 py-3 text-center text-xs text-(--ui-text-tertiary)">{p.worktreeProjectNone}</div>
                ) : (
                  filteredProjects.map(option => (
                    <RowButton
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-(--ui-control-active-background)"
                      key={option.path}
                      onClick={() => {
                        setRepoPath(option.path)
                        // The new repo has its own branches: drop the old list
                        // and the old base so nothing stale carries over.
                        setBranches([])
                        setSelectedBase('')
                        setProjectOpen(false)
                      }}
                    >
                      <Codicon className="shrink-0 text-(--ui-text-tertiary)" name="repo" size="0.8rem" />
                      <span className="truncate">{option.label}</span>
                      {option.path === activeOption?.path && (
                        <Codicon className="ml-auto shrink-0 text-(--ui-accent)" name="check" size="0.8rem" />
                      )}
                    </RowButton>
                  ))
                )}
              </div>
            </PopoverContent>
          </Popover>
        )}

        {convertMode ? (
          <div className="rounded-md border border-(--ui-stroke-tertiary)">
            <SearchField
              containerClassName="w-full px-2"
              onChange={setBranchFilter}
              placeholder={p.convertBranchPlaceholder}
              value={branchFilter}
            />
            <div className="max-h-64 overflow-y-auto border-t border-(--ui-stroke-tertiary) p-1">
              {filteredBranches.length === 0 ? (
                <div className="px-2 py-3 text-center text-xs text-(--ui-text-tertiary)">
                  {branchesLoading ? p.branchesLoading : p.noBranches}
                </div>
              ) : (
                filteredBranches.map(branch => (
                  <RowButton
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-(--ui-control-active-background) disabled:pointer-events-none disabled:opacity-50"
                    disabled={pending}
                    key={branch.name}
                    onClick={() => void convert(branch)}
                  >
                    {/* A remote-only row is a repo glyph, matching the base
                        picker, so `origin/foo` reads as "not here yet". */}
                    <Codicon
                      className="shrink-0 text-(--ui-text-tertiary)"
                      name={branch.isRemote ? 'repo' : 'git-branch'}
                      size="0.8rem"
                    />
                    <span className="truncate">{branch.name}</span>
                    <span className="ml-auto shrink-0 text-[0.625rem] text-(--ui-text-tertiary)">
                      {branchActionLabel(branch, p)}
                    </span>
                  </RowButton>
                ))
              )}
            </div>
          </div>
        ) : (
          <>
            <SanitizedInput
              autoFocus
              disabled={pending}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void submit()
                } else if (event.key === 'Escape') {
                  onOpenChange(false)
                }
              }}
              onValueChange={setName}
              placeholder={p.branchPlaceholder}
              sanitize={gitRef}
              value={name}
            />
            <BaseBranchPicker
              disabled={pending}
              // Remount on a repo change so the picker loads the new repo's
              // branches instead of showing the previous project's.
              key={repoPath}
              onValueChange={setSelectedBase}
              repoPath={repoPath}
              value={selectedBase}
            />
          </>
        )}

        {convertMode ? (
          <DialogFooter className="sm:justify-start">
            <Button
              className="px-0 text-(--ui-text-secondary) hover:text-foreground"
              disabled={pending}
              onClick={() => setConvertMode(false)}
              type="button"
              variant="link"
            >
              {t.common.cancel}
            </Button>
          </DialogFooter>
        ) : (
          <DialogFooter className="sm:justify-between">
            <Button
              className="px-0 text-(--ui-text-secondary) hover:text-foreground"
              disabled={pending}
              onClick={enterConvert}
              type="button"
              variant="link"
            >
              {p.convertBranchInstead}
            </Button>
            <div className="flex items-center gap-2">
              <Button disabled={pending} onClick={() => onOpenChange(false)} type="button" variant="ghost">
                {t.common.cancel}
              </Button>
              <Button disabled={pending || !name.trim()} onClick={() => void submit()} type="button">
                {p.startWork}
              </Button>
            </div>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
