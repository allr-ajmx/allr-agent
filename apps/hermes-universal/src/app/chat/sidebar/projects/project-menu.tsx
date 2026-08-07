import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useI18n } from '@/i18n'
import { dismissAutoProject } from '@/store/layout'
import { deleteProject, openProjectAddFolder, openProjectRename, setActiveProject } from '@/store/projects'

import type { SidebarProjectTree } from './model'

// Per-project overflow menu (kebab). Explicit projects get rename / add-folder /
// set-active / delete; auto (git-derived) projects can only be hidden.
export function ProjectMenu({ project }: { project: SidebarProjectTree }) {
  const { t } = useI18n()
  const p = t.sidebar.projects
  const explicit = !project.isAuto && !project.isNoProject

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={p.menu}
          className="size-5 rounded-[4px] bg-transparent text-transparent transition-colors hover:bg-(--ui-control-active-background) hover:text-foreground group-hover:text-(--ui-text-tertiary) coarse:text-(--ui-text-tertiary) data-[state=open]:bg-(--ui-control-active-background) data-[state=open]:text-foreground [&_svg]:size-3.5!"
          size="icon"
          variant="ghost"
        >
          <Codicon name="kebab-vertical" size="0.875rem" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuItem onSelect={() => openProjectRename({ id: project.id, name: project.label })}>
          <Codicon name="edit" size="0.875rem" />
          <span>{p.menuRename}</span>
        </DropdownMenuItem>
        {explicit ? (
          <>
            <DropdownMenuItem onSelect={() => openProjectAddFolder({ id: project.id, name: project.label })}>
              <Codicon name="new-folder" size="0.875rem" />
              <span>{p.menuAddFolder}</span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void setActiveProject(project.id)}>
              <Codicon name="check" size="0.875rem" />
              <span>{p.menuSetActive}</span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void deleteProject(project.id)} variant="destructive">
              <Codicon name="trash" size="0.875rem" />
              <span>{p.menuDelete}</span>
            </DropdownMenuItem>
          </>
        ) : project.isAuto ? (
          <DropdownMenuItem onSelect={() => dismissAutoProject(project.id)}>
            <Codicon name="eye-closed" size="0.875rem" />
            <span>{p.removeFromSidebar}</span>
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
