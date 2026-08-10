import type { ReactNode } from 'react'

import { ActionsContextMenu, ActionsMenu, type MenuKit, renderActionItem } from '@/components/ui/actions-menu'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { useI18n } from '@/i18n'
import { dismissAutoProject } from '@/store/layout'
import {
  deleteProject,
  openProjectAddFolder,
  openProjectRename,
  setActiveProject,
  setProjectAppearance
} from '@/store/projects'

import type { SidebarProjectTree } from './model'
import { ProjectAppearancePicker } from './project-appearance'

// One action set for the project row, rendered identically by the kebab
// dropdown and the row's right-click menu so the two can never drift. Explicit
// projects get rename / add-folder / set-active / delete; auto (git-derived)
// projects can only be hidden. Both get Appearance, since theming an auto
// project materializes it (see `setProjectAppearance`).
function useProjectItems(project: SidebarProjectTree) {
  const { t } = useI18n()
  const p = t.sidebar.projects
  const explicit = !project.isAuto && !project.isNoProject
  // The "No project" bucket has no row behind it, and an auto node without a
  // path has nothing to anchor a materialized project to.
  const canTheme = !project.isNoProject && (!project.isAuto || Boolean(project.path))

  return (kit: MenuKit) => (
    <>
      {renderActionItem(kit, {
        icon: 'edit',
        key: 'rename',
        label: p.menuRename,
        onSelect: () => openProjectRename({ id: project.id, name: project.label })
      })}
      {canTheme && (
        <kit.Sub>
          <kit.SubTrigger>
            <Codicon name="symbol-color" size="0.875rem" />
            <span>{p.menuAppearance}</span>
          </kit.SubTrigger>
          <kit.SubContent className="p-2">
            <ProjectAppearancePicker
              color={project.color ?? null}
              icon={project.icon ?? null}
              noColorLabel={p.noColor}
              onColor={color => void setProjectAppearance(project, { color })}
              onIcon={icon => void setProjectAppearance(project, { icon })}
            />
          </kit.SubContent>
        </kit.Sub>
      )}
      {explicit ? (
        <>
          {renderActionItem(kit, {
            icon: 'new-folder',
            key: 'add-folder',
            label: p.menuAddFolder,
            onSelect: () => openProjectAddFolder({ id: project.id, name: project.label })
          })}
          {renderActionItem(kit, {
            icon: 'check',
            key: 'set-active',
            label: p.menuSetActive,
            onSelect: () => void setActiveProject(project.id)
          })}
          {renderActionItem(kit, {
            icon: 'trash',
            key: 'delete',
            label: p.menuDelete,
            onSelect: () => void deleteProject(project.id),
            variant: 'destructive'
          })}
        </>
      ) : project.isAuto ? (
        renderActionItem(kit, {
          icon: 'eye-closed',
          key: 'dismiss',
          label: p.removeFromSidebar,
          onSelect: () => dismissAutoProject(project.id)
        })
      ) : null}
    </>
  )
}

// Per-project overflow menu (kebab).
export function ProjectMenu({ project }: { project: SidebarProjectTree }) {
  const { t } = useI18n()
  const p = t.sidebar.projects
  const items = useProjectItems(project)

  return (
    <ActionsMenu ariaLabel={p.menu} contentClassName="w-40" items={items} sideOffset={4}>
      <Button
        aria-label={p.menu}
        className="size-5 rounded-[4px] bg-transparent text-transparent transition-colors hover:bg-(--ui-control-active-background) hover:text-foreground group-hover:text-(--ui-text-tertiary) coarse:text-(--ui-text-tertiary) data-[state=open]:bg-(--ui-control-active-background) data-[state=open]:text-foreground [&_svg]:size-3.5!"
        size="icon"
        variant="ghost"
      >
        <Codicon name="kebab-vertical" size="0.875rem" />
      </Button>
    </ActionsMenu>
  )
}

/** Wrap a project row so right-clicking it opens the same menu as its kebab. */
export function ProjectContextMenu({ children, project }: { children: ReactNode; project: SidebarProjectTree }) {
  const { t } = useI18n()
  const p = t.sidebar.projects
  const items = useProjectItems(project)

  return (
    <ActionsContextMenu ariaLabel={p.menu} contentClassName="w-40" items={items}>
      {children}
    </ActionsContextMenu>
  )
}
