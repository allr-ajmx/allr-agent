import { toggleLayoutEditMode } from '@/components/pane-shell/edit-mode'
import { isLayoutNode, type LayoutNode } from '@/components/pane-shell/tree/model'
import { applyLayoutPreset, deleteUserPreset, isUserPreset, LAYOUTS_AREA } from '@/components/pane-shell/tree/presets'
import { $activePresetId, resetLayoutTree } from '@/components/pane-shell/tree/store'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { $registryVersion, registry } from '@/contrib/registry'
import { useI18n } from '@/i18n'
import { useStore } from '@/store/atom'

// The top-bar layout ("tile preview") button: pick a named layout preset so the
// workspace rearranges its tiles/panes, delete one you saved, reset to the
// default, or open edit mode to author a new one. Presets are the registered
// `layouts` contributions — the bundled four, plus anything a plugin or the zone
// editor added; each carries a LayoutNode.
export function LayoutMenu() {
  const { t } = useI18n()
  // Re-render if the set of layout presets changes (plugins and the zone editor
  // both add them).
  useStore($registryVersion)
  const activeId = useStore($activePresetId)
  const presets = [...registry.getArea(LAYOUTS_AREA)]

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={t.zones.editTitle}
          className="size-5 rounded-[4px] bg-transparent text-muted-foreground/85 [&_.codicon]:text-[0.875rem] hover:bg-[var(--ui-control-hover-background)] hover:text-foreground"
          // No tip: DropdownMenu triggers don't take one (a tooltip fights the
          // open menu) — aria-label names it for assistive tech.
          size="icon"
          type="button"
          variant="ghost"
        >
          <Codicon name="layout" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" aria-label={t.zones.editTitle} className="w-44">
        {presets.map(preset => (
          <DropdownMenuItem
            className="group/preset"
            key={`${preset.source ?? 'core'}:${preset.id}`}
            onSelect={() => {
              if (isLayoutNode(preset.data)) {
                // Deep-cloned by applyLayoutPreset: applying the registered node
                // by reference lets live edits mutate the preset itself.
                applyLayoutPreset(preset.id, preset.data as LayoutNode)
              }
            }}
          >
            <Codicon className={preset.id === activeId ? 'opacity-100' : 'opacity-0'} name="check" size="0.875rem" />
            <span className="min-w-0 flex-1 truncate">{preset.title ?? preset.id}</span>
            {isUserPreset(preset.id) && (
              <button
                aria-label={t.zones.deletePreset(preset.title ?? preset.id)}
                className="grid size-4 shrink-0 place-items-center rounded text-(--ui-text-quaternary) opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/preset:opacity-100"
                onClick={event => {
                  // Don't let the row's onSelect apply the preset we're deleting.
                  event.preventDefault()
                  event.stopPropagation()
                  deleteUserPreset(preset.id)
                }}
                type="button"
              >
                <Codicon name="close" size="0.7rem" />
              </button>
            )}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        {/* The door into authoring: the floating palette, where a layout can be
            saved, deleted, or drawn from scratch in the zone editor. */}
        <DropdownMenuItem onSelect={() => toggleLayoutEditMode()}>
          <Codicon name="edit" size="0.875rem" />
          <span>{t.zones.editTitle}</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => resetLayoutTree()}>
          <Codicon name="discard" size="0.875rem" />
          <span>{t.zones.reset}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
