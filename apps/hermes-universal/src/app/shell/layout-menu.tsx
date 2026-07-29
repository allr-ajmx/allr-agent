import { isLayoutNode, type LayoutNode } from '@/components/pane-shell/tree/model'
import { $activePresetId, applyTree, resetLayoutTree } from '@/components/pane-shell/tree/store'
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
// workspace rearranges its tiles/panes, or reset to the default. Presets are the
// registered `layouts` contributions (Default / Focus / Terminal deck / Quad);
// each carries a LayoutNode applied via the tree store.
export function LayoutMenu() {
  const { t } = useI18n()
  // Re-render if the set of layout presets changes (plugins can add them).
  useStore($registryVersion)
  const activeId = useStore($activePresetId)
  const presets = [...registry.getArea('layouts')]

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={t.zones.editTitle}
          className="size-5 rounded-[4px] bg-transparent text-muted-foreground/85 [&_.codicon]:text-[0.875rem] hover:bg-[var(--ui-control-hover-background)] hover:text-foreground"
          size="icon"
          title={t.zones.editTitle}
          type="button"
          variant="ghost"
        >
          <Codicon name="layout" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" aria-label={t.zones.editTitle} className="w-44">
        {presets.map(preset => (
          <DropdownMenuItem
            key={preset.id}
            onSelect={() => {
              if (isLayoutNode(preset.data)) {
                applyTree(preset.data as LayoutNode, preset.id)
              }
            }}
          >
            <Codicon className={preset.id === activeId ? 'opacity-100' : 'opacity-0'} name="check" size="0.875rem" />
            <span>{preset.title ?? preset.id}</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => resetLayoutTree()}>
          <Codicon name="discard" size="0.875rem" />
          <span>{t.zones.reset}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
