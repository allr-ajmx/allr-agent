import { memo, type ReactNode } from 'react'

import { StatusRow } from '@/components/chat/status-row'
import { Codicon } from '@/components/ui/codicon'
import { GlyphSpinner } from '@/components/ui/glyph-spinner'
import { type Translations, useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import type { SubagentProgress } from '@/store/subagents'

// Adapted from apps/desktop/src/app/chat/composer/status-stack/status-row.tsx.
// Universal's status stack shows subagents (todos / background processes /
// terminals aren't wired here — FLAG(chat-port)), so this renders one
// SubagentProgress into the shared StatusRow.

const toolLabel = (name: string) =>
  name
    .split('_')
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || name

function leadingGlyph(item: SubagentProgress, s: Translations['statusStack']): ReactNode {
  if (item.status === 'running') {
    return (
      <GlyphSpinner
        ariaLabel={s.running}
        className="text-[0.85rem] leading-none text-muted-foreground/80"
        spinner="braille"
      />
    )
  }

  return (
    <span
      aria-hidden
      className={cn(
        'size-1.5 rounded-full',
        item.status === 'failed' || item.status === 'interrupted' ? 'bg-destructive/80' : 'bg-(--ui-green)/70'
      )}
    />
  )
}

/**
 * `onOpen` takes the subagent's session id rather than closing over it, so the
 * caller can pass ONE stable callback for every row instead of a fresh arrow per
 * row per render. Without that this component is memoized in name only: a new
 * function identity on every render means the comparator never bails, which is
 * the same silent-inert-memo class MJXHRM-383 fixed in the sidebar (MJXHRM-45).
 *
 * `canOpen` is the caller's gate (desktop-only, not from a pop-out); the row
 * still requires the item to actually name a session.
 */
export const StatusItemRow = memo(function StatusItemRow({
  canOpen = false,
  item,
  onOpen
}: {
  canOpen?: boolean
  item: SubagentProgress
  onOpen?: (sessionId: string) => void
}) {
  const { t } = useI18n()
  const s = t.statusStack
  const failed = item.status === 'failed' || item.status === 'interrupted'
  const openable = canOpen && Boolean(onOpen) && Boolean(item.sessionId)
  const activate = openable ? () => onOpen?.(item.sessionId!) : undefined

  return (
    <StatusRow
      leading={leadingGlyph(item, s)}
      onActivate={activate}
      trailing={
        openable ? (
          <Codicon aria-hidden className="text-muted-foreground/55" name="link-external" size="0.85rem" />
        ) : undefined
      }
    >
      <span
        className={cn(
          'min-w-0 max-w-[18rem] truncate text-[0.73rem] leading-4',
          failed ? 'text-destructive/90' : 'text-foreground/92'
        )}
      >
        {item.goal || t.statusStack.subagents(1)}
      </span>
      {item.currentTool && (
        <span className="shrink-0 truncate text-[0.62rem] leading-4 text-muted-foreground/70">
          {toolLabel(item.currentTool)}
        </span>
      )}
    </StatusRow>
  )
})
