import { CONTEXT_KIT } from '@/components/ui/actions-menu'
import { Codicon } from '@/components/ui/codicon'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { paneTabCloseItems } from '@/components/ui/pane-tab'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { isMetaClose, middleClickHandlers } from '@/lib/middle-click'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import { setTerminalOpen } from '@/store/layout'
import {
  $activeTerminalId,
  $terminals,
  closeAllTerminals,
  closeOtherTerminals,
  closeTerminal,
  closeTerminalsToRight,
  createTerminal,
  selectTerminal,
  terminalCloseTargets,
  type TerminalEntry
} from '@/store/terminals'

// Ported/adapted from desktop's terminal/rail.tsx: a thin vertical icon strip on
// the terminal's right edge — a tab per terminal (terminal icon), a `+` to open
// another, and a hide button. Border-l separates it from the terminal content.

const RAIL_ACTION =
  'grid size-6 place-items-center rounded text-(--ui-text-tertiary) transition-colors hover:bg-(--chrome-action-hover) hover:text-foreground'

export function TerminalRail() {
  const { t } = useI18n()
  const terminals = useStore($terminals)
  const activeId = useStore($activeTerminalId)

  return (
    <div className="flex h-full w-9 shrink-0 flex-col items-center border-l border-(--ui-stroke-tertiary) bg-(--ui-editor-surface-background)">
      <ul
        aria-label={t.rightSidebar.terminalsAria}
        className="flex min-h-0 flex-1 flex-col items-center gap-0.5 self-stretch overflow-y-auto overflow-x-hidden py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        role="tablist"
      >
        {terminals.map((term, index) => (
          <TerminalRailItem active={term.id === activeId} index={index} key={term.id} term={term} />
        ))}
        <li className="flex w-full justify-center">
          <Tip label={t.rightSidebar.terminalNew}>
            <button
              aria-label={t.rightSidebar.terminalNew}
              className={cn(RAIL_ACTION, 'size-7 text-(--ui-text-quaternary)')}
              onClick={() => createTerminal()}
              type="button"
            >
              <Codicon name="add" size="0.8125rem" />
            </button>
          </Tip>
        </li>
      </ul>

      <div className="flex shrink-0 flex-col items-center pb-1.5">
        <Tip label={t.rightSidebar.terminalHide}>
          <button
            aria-label={t.rightSidebar.terminalHide}
            className={RAIL_ACTION}
            onClick={() => setTerminalOpen(false)}
            type="button"
          >
            <Codicon name="chevron-down" size="0.8125rem" />
          </button>
        </Tip>
      </div>
    </div>
  )
}

function TerminalRailItem({ active, index, term }: { active: boolean; index: number; term: TerminalEntry }) {
  const { t } = useI18n()
  const label = `${index + 1}. ${term.title}`

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <li className="relative flex w-full justify-center">
          {active && (
            <span aria-hidden className="absolute inset-y-0.5 right-0 w-0.5 rounded-l-sm bg-(--ui-stroke-primary)" />
          )}
          <Tip label={label}>
            <button
              aria-label={label}
              aria-selected={active}
              className={cn(
                'grid size-7 place-items-center rounded-md transition-colors',
                active
                  ? 'bg-(--chrome-action-hover) text-foreground'
                  : 'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
              )}
              // Middle-click closes — through `middleClickHandlers`, not
              // `auxclick`: the rail is a SCROLLER, and a middle press inside a
              // scroller starts the autoscroll pan on Windows/Linux, so the
              // mouseup is spent stopping the pan and `auxclick` never fires.
              // The gesture only ever worked on macOS, where there is no pan.
              {...middleClickHandlers(() => closeTerminal(term.id))}
              onClick={event => {
                // ⌘-click closes too — the Mac has no middle button, so this is
                // the trackpad equivalent, matching every tab strip in the app.
                if (isMetaClose(event)) {
                  event.preventDefault()
                  closeTerminal(term.id)

                  return
                }

                selectTerminal(term.id)
              }}
              role="tab"
              type="button"
            >
              <Codicon name="terminal" size="0.875rem" />
            </button>
          </Tip>
        </li>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {/* The SAME four close verbs, in the same order, disabled the same way,
            as every tab strip in the app — this rail used to hand-roll three of
            them under its own translation keys and never offered "to the
            right" at all. Hide stays below the separator: it is a verb about
            the RAIL, not about this terminal. */}
        {paneTabCloseItems(CONTEXT_KIT, {
          counts: terminalCloseTargets(term.id),
          onClose: () => closeTerminal(term.id),
          onCloseAll: closeAllTerminals,
          onCloseOthers: () => closeOtherTerminals(term.id),
          onCloseToRight: () => closeTerminalsToRight(term.id)
        })}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => setTerminalOpen(false)}>{t.rightSidebar.terminalHide}</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
