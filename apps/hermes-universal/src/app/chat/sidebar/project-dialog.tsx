import { useEffect, useRef, useState } from 'react'

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
import { GenerateButton } from '@/components/ui/generate-button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useI18n } from '@/i18n'
import { IS_DESKTOP } from '@/lib/platform'
import { type ProjectIdeaTemplate, randomIdeaTemplates } from '@/lib/project-idea-templates'
import { useStore } from '@/store/atom'
import { notifyError } from '@/store/notifications'
import {
  $projectDialog,
  addProjectFolder,
  closeProjectDialog,
  createProject,
  generateProjectIdea,
  pickProjectFolder,
  renameProject
} from '@/store/projects'

// Single dialog mounted in the sidebar; opens create / rename / add-folder flows
// off `$projectDialog`. Ported picture-perfect from desktop `project-dialog.tsx`
// (overlaid sparkle Generate, template chips + Shuffle, folders list), with a
// manual folder-path fallback for platforms without a native directory picker.
export function ProjectDialog() {
  const dialog = useStore($projectDialog)
  const { t } = useI18n()
  const p = t.sidebar.projects
  const nameRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState('')
  const [folders, setFolders] = useState<string[]>([])
  const [idea, setIdea] = useState('')
  const [templates, setTemplates] = useState<ProjectIdeaTemplate[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [generatingIdea, setGeneratingIdea] = useState(false)
  const [manualPath, setManualPath] = useState('')

  useEffect(() => {
    if (dialog) {
      setName(dialog.name ?? '')
      setFolders([])
      setIdea('')
      setTemplates(randomIdeaTemplates())
      setManualPath('')

      if (dialog.mode !== 'add-folder') {
        window.setTimeout(() => nameRef.current?.select(), 0)
      }
    }
  }, [dialog])

  if (!dialog) {
    return null
  }

  const mode = dialog.mode
  const isCreate = mode === 'create'
  const isRename = mode === 'rename'
  const title = isCreate ? p.createTitle : isRename ? p.renameTitle : p.addFolderTitle

  const addResolvedFolder = (dir: string) => {
    if (mode === 'add-folder' && dialog.projectId) {
      void addProjectFolder(dialog.projectId, dir)
      closeProjectDialog()
    } else {
      setFolders(prev => (prev.includes(dir) ? prev : [...prev, dir]))
    }
  }

  // Native directory picker (desktop only). The always-visible manual path input
  // below is the reliable cross-platform way to add + see a folder.
  const pickFolder = async () => {
    const dir = await pickProjectFolder()

    if (dir) {
      addResolvedFolder(dir)
    }
  }

  const addManualFolder = () => {
    const dir = manualPath.trim()

    if (!dir) {
      return
    }

    addResolvedFolder(dir)
    setManualPath('')
  }

  const canSubmit = name.trim().length > 0 && (!isCreate || folders.length > 0)

  const submit = async () => {
    if (submitting || !canSubmit) {
      return
    }

    setSubmitting(true)

    try {
      if (isRename && dialog.projectId) {
        await renameProject(dialog.projectId, name.trim())
      } else if (isCreate) {
        await createProject({
          folders,
          idea: idea.trim() || undefined,
          name: name.trim(),
          primaryPath: folders[0],
          use: true
        })
      }

      closeProjectDialog()
    } catch (err) {
      notifyError(err, p.createFailed)
    } finally {
      setSubmitting(false)
    }
  }

  const generateIdea = async () => {
    if (generatingIdea) {
      return
    }

    setGeneratingIdea(true)

    try {
      // Build on the current idea/template when present, else invent a fresh one.
      const text = await generateProjectIdea(name, idea)

      if (text) {
        setIdea(text)
      }
    } finally {
      setGeneratingIdea(false)
    }
  }

  const manualRow = (
    <div className="flex items-center gap-1.5">
      <Input
        disabled={submitting}
        onChange={e => setManualPath(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && addManualFolder()}
        placeholder={p.folderPath}
        value={manualPath}
      />
      <Button
        aria-label={p.addFolder}
        className="shrink-0"
        disabled={submitting || !manualPath.trim()}
        onClick={addManualFolder}
        size="icon-sm"
        type="button"
        variant="ghost"
      >
        <Codicon name="add" size="0.875rem" />
      </Button>
    </div>
  )

  return (
    <Dialog onOpenChange={next => !next && closeProjectDialog()} open>
      <DialogContent className="max-w-md" onInteractOutside={e => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {isCreate && <DialogDescription>{p.createDesc}</DialogDescription>}
        </DialogHeader>

        {mode !== 'add-folder' && (
          <Input
            autoFocus
            disabled={submitting}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void submit()
              } else if (e.key === 'Escape') {
                closeProjectDialog()
              }
            }}
            placeholder={p.namePlaceholder}
            ref={nameRef}
            value={name}
          />
        )}

        {isCreate && (
          <div className="flex flex-col gap-1.5">
            <span className="text-[0.6875rem] font-medium text-(--ui-text-tertiary)">{p.foldersLabel}</span>
            {folders.length === 0 ? (
              <span className="text-[0.75rem] text-(--ui-text-quaternary)">{p.noFolders}</span>
            ) : (
              <ul className="flex flex-col gap-1">
                {folders.map((folder, index) => (
                  <li
                    className="flex items-center gap-2 rounded-md bg-(--ui-control-hover-background) px-2 py-1 text-[0.75rem]"
                    key={folder}
                  >
                    <Codicon className="shrink-0 text-(--ui-text-tertiary)" name="folder" size="0.75rem" />
                    <span className="min-w-0 flex-1 truncate" title={folder}>
                      {folder}
                    </span>
                    {index === 0 && (
                      <span className="shrink-0 text-[0.625rem] uppercase text-(--ui-text-quaternary)">
                        {p.primaryBadge}
                      </span>
                    )}
                    <Button
                      aria-label={p.removeFolder}
                      className="size-5 shrink-0 text-(--ui-text-quaternary) hover:text-foreground"
                      onClick={() => setFolders(prev => prev.filter(f => f !== folder))}
                      size="icon-xs"
                      type="button"
                      variant="ghost"
                    >
                      <Codicon name="close" size="0.75rem" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {manualRow}
            {IS_DESKTOP && (
              <Button
                className="size-auto self-start"
                disabled={submitting}
                onClick={() => void pickFolder()}
                size="sm"
                type="button"
                variant="ghost"
              >
                <Codicon name="folder-opened" size="0.75rem" />
                {p.addFolder}
              </Button>
            )}
          </div>
        )}

        {isCreate && (
          <div className="flex flex-col gap-1.5">
            <span className="text-[0.6875rem] font-medium text-(--ui-text-tertiary)">{p.ideaLabel}</span>
            <div className="relative">
              <Textarea
                className="min-h-20 pe-8 text-[0.8125rem]"
                disabled={submitting}
                onChange={e => setIdea(e.target.value)}
                placeholder={p.ideaPlaceholder}
                value={idea}
              />
              <GenerateButton
                className="absolute top-1 end-1"
                disabled={submitting}
                generating={generatingIdea}
                generatingLabel={p.ideaGenerating}
                label={p.ideaGenerate}
                onGenerate={() => void generateIdea()}
              />
            </div>
            <div className="flex flex-wrap items-center gap-1">
              {templates.map(template => (
                <button
                  className="flex items-center gap-1 rounded-full border border-(--ui-stroke-tertiary) px-2 py-0.5 text-[0.6875rem] text-(--ui-text-secondary) transition-colors hover:border-(--ui-stroke-secondary) hover:bg-(--ui-control-hover-background) hover:text-foreground disabled:opacity-50"
                  disabled={submitting}
                  key={template.label}
                  onClick={() => setIdea(template.idea)}
                  type="button"
                >
                  <span aria-hidden>{template.emoji}</span>
                  {template.label}
                </button>
              ))}
              <Button
                aria-label={p.ideaShuffle}
                className="size-5 text-(--ui-text-quaternary) hover:text-foreground"
                disabled={submitting}
                onClick={() => setTemplates(randomIdeaTemplates())}
                size="icon-xs"
                type="button"
                variant="ghost"
              >
                <Codicon name="refresh" size="0.75rem" />
              </Button>
            </div>
          </div>
        )}

        {mode === 'add-folder' && (
          <div className="flex flex-col gap-1.5">
            {manualRow}
            {IS_DESKTOP && (
              <Button className="w-full" disabled={submitting} onClick={() => void pickFolder()} type="button">
                <Codicon name="folder-opened" size="0.875rem" />
                {p.addFolder}
              </Button>
            )}
          </div>
        )}

        {mode !== 'add-folder' && (
          <DialogFooter>
            <Button disabled={submitting} onClick={closeProjectDialog} type="button" variant="ghost">
              {t.common.cancel}
            </Button>
            <Button disabled={submitting || !canSubmit} onClick={() => void submit()} type="button">
              {isRename ? t.common.save : p.create}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
