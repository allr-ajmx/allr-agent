import { Codicon } from '@/components/ui/codicon'
import { useI18n } from '@/i18n'

import { SidebarRowBody, SidebarRowLabel, SidebarRowLead, SidebarRowShell } from './chrome'

interface SidebarLoadMoreRowProps {
  step: number
  onClick: () => void
  loading?: boolean
}

// Compact "load more" affordance shared by recents, messaging, and cron. Ported
// from desktop `load-more-row.tsx` (GlyphSpinner → a spinning codicon).
export function SidebarLoadMoreRow({ step, onClick, loading = false }: SidebarLoadMoreRowProps) {
  const { t } = useI18n()
  const label = loading ? t.sidebar.loading : step > 0 ? t.sidebar.loadCount(step) : t.sidebar.loadMore

  return (
    <button
      aria-label={label}
      className="ml-auto grid size-5 place-items-center rounded-sm bg-transparent text-(--ui-text-tertiary) transition-colors hover:bg-(--ui-control-hover-background) hover:text-foreground disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent disabled:hover:text-(--ui-text-tertiary)"
      disabled={loading}
      onClick={onClick}
      type="button"
    >
      <Codicon
        className={loading ? 'animate-spin' : undefined}
        name={loading ? 'loading' : 'ellipsis'}
        size="0.75rem"
      />
    </button>
  )
}

// Full-width labeled variant used by the sessions section: same row geometry and
// hover as a session entry, minus the lead dot, with the section-header's
// uppercase treatment (unbolded) and a trailing chevron.
export function SidebarLoadMoreButton({ step, onClick, loading = false }: SidebarLoadMoreRowProps) {
  const { t } = useI18n()
  const label = loading ? t.sidebar.loading : step > 0 ? t.sidebar.loadCount(step) : t.sidebar.loadMore

  return (
    <SidebarRowShell className="group row-hover relative">
      <SidebarRowBody
        aria-label={label}
        className="disabled:cursor-default disabled:opacity-60"
        disabled={loading}
        onClick={onClick}
      >
        {/* Empty lead keeps the label on the same x as the session titles above
            (the rows' dot column + gap) without repeating the dot. */}
        <SidebarRowLead />
        <SidebarRowLabel className="flex-1 text-[0.64rem] font-normal uppercase tracking-[0.16em] text-(--ui-text-tertiary) group-hover:text-foreground">
          {label}
        </SidebarRowLabel>
        <SidebarRowLead className="text-(--ui-text-tertiary) group-hover:text-foreground">
          <Codicon
            className={loading ? 'animate-spin' : undefined}
            name={loading ? 'loading' : 'chevron-down'}
            size="0.75rem"
          />
        </SidebarRowLead>
      </SidebarRowBody>
    </SidebarRowShell>
  )
}
