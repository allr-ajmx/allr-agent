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
import { RowButton } from '@/components/ui/row-button'
import { SanitizedInput } from '@/components/ui/sanitized-input'
import { SearchField } from '@/components/ui/search-field'
import type { HermesGitBranch } from '@/global'
import { useI18n } from '@/i18n'
import { gitRef } from '@/lib/sanitize'
import { notifyError } from '@/store/notifications'
import { listRepoBranches, startWorkInRepo, switchBranchInRepo } from '@/store/projects'

import { BaseBranchPicker } from './base-branch-picker'

interface BranchActionCopy {
  branchCreateWorktree: string
  branchOpenExisting: string
  branchSwitchHome: string
}

const branchActionLabel = (branch: HermesGitBranch, copy: BranchActionCopy) => {
  if (branch.checkedOut) {
    return copy.branchOpenExisting
  }

  return branch.isDefault ? copy.branchSwitchHome : copy.branchCreateWorktree
}

export interface WorktreeDialogProps {
  /** Repo root path for git operations. */
  repoPath: string
  /** Called with the new/converted worktree path on success. */
  onStarted: (path: string) => void
  /** Controlled open state. */
  open: boolean
  /** Called when the user requests the dialog to close (cancel, Esc, backdrop). */
  onOpenChange: (open: boolean) => void
  /** Pre-select a base branch when opening (from "branch off from X" menus). */
  initialBase?: string
}

/**
 * Shared "new worktree" dialog — used by the composer's coding row (its kebab
 * menu and the ⌘⇧B shortcut), and by any future sidebar start-work button.
 * Features:
 * - Branch name input (sanitized as a git ref)
 * - Base branch picker (BaseBranchPicker)
 * - Convert mode: check out an existing branch into a worktree
 *
 * The caller owns the open state so several triggers can drive one instance.
 *
 * Ported from desktop. Desktop's convert-mode list is a cmdk `Command`
 * combobox; universal has no cmdk, so it's a `SearchField` over a plain filtered
 * list here — same substring filter, same three-way action labels.
 */
export function WorktreeDialog({ repoPath, onStarted, open, onOpenChange, initialBase }: WorktreeDialogProps) {
  const { t } = useI18n()
  const p = t.sidebar.projects
  const [name, setName] = useState('')
  const [pending, setPending] = useState(false)
  const [convertMode, setConvertMode] = useState(false)
  const [branches, setBranches] = useState<HermesGitBranch[]>([])
  const [branchesLoading, setBranchesLoading] = useState(false)
  const [branchFilter, setBranchFilter] = useState('')
  const [selectedBase, setSelectedBase] = useState('')

  // Reset to a fresh state each time the dialog opens, applying any pre-selected
  // base branch from the caller (e.g. "branch off from main" in the coding row's
  // dropdown menu). When `initialBase` changes while open (shouldn't happen in
  // practice), the effect re-syncs.
  useEffect(() => {
    if (open) {
      setName('')
      setConvertMode(false)
      setBranchFilter('')
      setSelectedBase(initialBase ?? '')
    }
  }, [open, initialBase])

  const loadBranches = useCallback(async () => {
    if (!repoPath) {
      return
    }

    setBranchesLoading(true)

    try {
      setBranches(await listRepoBranches(repoPath))
    } catch {
      setBranches([])
    } finally {
      setBranchesLoading(false)
    }
  }, [repoPath])

  const submit = async () => {
    const branch = name.trim()

    if (pending || !repoPath || !branch) {
      return
    }

    setPending(true)

    try {
      const result = await startWorkInRepo(repoPath, { base: selectedBase || undefined, branch, name: branch })

      if (result) {
        onStarted(result.path)
        onOpenChange(false)
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
        onStarted(result.path)
        onOpenChange(false)
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
    <Dialog onOpenChange={next => !pending && onOpenChange(next)} open={open}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{convertMode ? p.convertBranchTitle : p.newWorktreeTitle}</DialogTitle>
          <DialogDescription>{convertMode ? p.convertBranchDesc : p.newWorktreeDesc}</DialogDescription>
        </DialogHeader>

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
                    <Codicon className="shrink-0 text-(--ui-text-tertiary)" name="git-branch" size="0.8rem" />
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
