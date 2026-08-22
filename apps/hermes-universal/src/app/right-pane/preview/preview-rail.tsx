import { CONTEXT_KIT } from '@/components/ui/actions-menu'
import { Codicon } from '@/components/ui/codicon'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import { paneTabCloseItems } from '@/components/ui/pane-tab'
import { useI18n } from '@/i18n'
import { isMetaClose, middleClickHandlers } from '@/lib/middle-click'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import { useDisplayPath } from '@/store/display-home'
import {
  $activePreviewTarget,
  $previewTabs,
  isArtifactTab,
  previewCloseTargets,
  type PreviewTarget,
  requestCloseAllPreviewTabs,
  requestCloseOtherPreviewTabs,
  requestClosePreviewTab,
  requestClosePreviewTabsToRight,
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
  // The tab's tooltip is the file's absolute path on the GATEWAY (MJXHRM-394).
  // An `artifact:<id>` tab has no home prefix, so it passes through untouched.
  const displayPath = useDisplayPath()

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            'group/tab flex min-w-0 max-w-40 shrink-0 cursor-pointer items-center gap-1.5 border-e border-(--ui-stroke-tertiary) px-2 text-xs',
            active
              ? 'bg-(--ui-editor-surface-background) text-foreground'
              : 'text-(--ui-text-tertiary) hover:text-foreground'
          )}
          // Middle-click closes — through `middleClickHandlers`, not
          // `auxclick`. This strip is `overflow-x-auto`, and a middle press
          // inside a scroller starts the AUTOSCROLL pan on Windows and Linux:
          // the mouseup is spent stopping the pan, so `auxclick` never arrives
          // and the gesture only ever worked on macOS. Every other tab surface
          // in the app already used the shared handlers; this one was the
          // holdout.
          {...middleClickHandlers(() => requestClosePreviewTab(tab.path))}
          onClick={event => {
            // ⌘-click closes too, the trackpad equivalent of the middle button.
            if (isMetaClose(event)) {
              event.preventDefault()
              requestClosePreviewTab(tab.path)

              return
            }

            selectPreviewTab(tab.path)
          }}
          title={displayPath(tab.path)}
        >
          <span className="min-w-0 flex-1 truncate">{tab.name}</span>
          <button
            aria-label={p.closeTab(tab.name)}
            className="inline-flex size-4 shrink-0 items-center justify-center rounded hover:bg-(--chrome-action-hover)"
            onClick={event => {
              event.stopPropagation()
              requestClosePreviewTab(tab.path)
            }}
            type="button"
          >
            {/* A dirty tab shows a dot where the × goes, and hover swaps them.
                On touch that leaves a control you can tap but can't identify —
                so there the × always wins. The dirty state is not lost: the
                Workspace's Editor tab carries its own dirty badge. */}
            {dirty ? (
              <span
                aria-hidden
                className="size-1.5 rounded-full bg-(--ui-yellow) group-hover/tab:hidden coarse:hidden"
              />
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
        {/* The SAME four close verbs as every tab strip in the app. This rail
            used to hand-roll three of them under `preview.*` labels of its own
            and never offered "to the right"; those labels are gone now and the
            group reads from `zones.*`, like every other strip. */}
        {paneTabCloseItems(CONTEXT_KIT, {
          counts: previewCloseTargets(tab.path),
          onClose: () => requestClosePreviewTab(tab.path),
          onCloseAll: () => requestCloseAllPreviewTabs(),
          onCloseOthers: () => requestCloseOtherPreviewTabs(tab.path),
          onCloseToRight: () => requestClosePreviewTabsToRight(tab.path)
        })}
      </ContextMenuContent>
    </ContextMenu>
  )
}
