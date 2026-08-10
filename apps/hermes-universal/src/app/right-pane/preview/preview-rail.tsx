import { Codicon } from '@/components/ui/codicon'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import {
  $activePreviewTarget,
  $previewTabs,
  closeAllPreviewTabs,
  closeOtherPreviewTabs,
  closePreviewTab,
  isArtifactTab,
  type PreviewTarget,
  selectPreviewTab
} from '@/store/preview'
import { $dirtyPreviewPaths } from '@/store/preview-edit'

import { ArtifactPreview } from './preview-artifact'
import { PreviewFile } from './preview-file'

// The VS Code-style tabbed file viewer/editor rail — for the shells that have
// NO LAYOUT TREE: the phone Workspace's Editor tab and the narrow AppShell
// drawer. In the tree, a preview is a tile (app/chat/preview-tile.tsx) and the
// ZONE owns its tab, so this rail's own strip is not a second bar there — it
// simply isn't on that path at all.
//
// It reads the same `$previewTabs` / `$activePreviewPath` / view-mode stores the
// tiles do, so a file opened on one shell is the same open file on the other.

export function PreviewRail() {
  const tabs = useStore($previewTabs)
  const active = useStore($activePreviewTarget)
  const dirty = useStore($dirtyPreviewPaths)

  return (
    <div className="flex h-full min-h-0 flex-col bg-(--ui-editor-surface-background)">
      {tabs.length > 0 && (
        <div className="flex h-8 shrink-0 items-stretch overflow-x-auto border-t border-b border-(--ui-stroke-tertiary) bg-(--ui-sidebar-surface-background)">
          {tabs.map(tab => (
            <PreviewTab active={active?.path === tab.path} dirty={dirty.has(tab.path)} key={tab.path} tab={tab} />
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden">
        {active ? (
          // An artifact tab names a registry entry, not a file on disk — a
          // different reader entirely, sharing only the tab strip above.
          isArtifactTab(active.path) ? (
            <ArtifactPreview key={active.path} target={active} />
          ) : (
            <PreviewFile key={active.path} target={active} />
          )
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground/60">
            <Codicon name="file-code" size="1.5rem" />
          </div>
        )}
      </div>
    </div>
  )
}

function PreviewTab({ active, dirty, tab }: { active: boolean; dirty: boolean; tab: PreviewTarget }) {
  const { t } = useI18n()
  const p = t.preview

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            'group/tab flex min-w-0 max-w-40 shrink-0 cursor-pointer items-center gap-1.5 border-r border-(--ui-stroke-tertiary) px-2 text-xs',
            active
              ? 'bg-(--ui-editor-surface-background) text-foreground'
              : 'text-(--ui-text-tertiary) hover:text-foreground'
          )}
          onAuxClick={event => {
            if (event.button === 1) {
              event.preventDefault()
              closePreviewTab(tab.path)
            }
          }}
          onClick={() => selectPreviewTab(tab.path)}
          title={tab.path}
        >
          <span className="min-w-0 flex-1 truncate">{tab.name}</span>
          <button
            aria-label={p.closeTab(tab.name)}
            className="inline-flex size-4 shrink-0 items-center justify-center rounded hover:bg-(--chrome-action-hover)"
            onClick={event => {
              event.stopPropagation()
              closePreviewTab(tab.path)
            }}
            type="button"
          >
            {/* A dirty tab shows a dot where the × goes, and hover swaps them.
                On touch that leaves a control you can tap but can't identify —
                so there the × always wins. The dirty state is not lost: the
                Workspace's Editor tab carries its own dirty badge. */}
            {dirty ? (
              <span aria-hidden className="size-1.5 rounded-full bg-amber-500 group-hover/tab:hidden coarse:hidden" />
            ) : null}
            <Codicon
              className={cn(dirty && 'hidden group-hover/tab:inline coarse:inline')}
              name="close"
              size="0.7rem"
            />
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-44">
        <ContextMenuItem onSelect={() => closePreviewTab(tab.path)}>{p.closeTab(tab.name)}</ContextMenuItem>
        <ContextMenuItem onSelect={() => closeOtherPreviewTabs(tab.path)}>{p.closeOthers}</ContextMenuItem>
        <ContextMenuItem onSelect={() => closeAllPreviewTabs()}>{p.closeAll}</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
