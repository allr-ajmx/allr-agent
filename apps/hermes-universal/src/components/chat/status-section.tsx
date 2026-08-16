import { type ReactNode, useState } from 'react'

import { DisclosureCaret } from '@/components/ui/disclosure-caret'

// Ported from apps/desktop/src/components/chat/status-section.tsx. One
// collapsible group inside the composer status stack — header (caret + label) +
// body — styled to match the queue so every status reads as one piece.
interface StatusSectionProps {
  accessory?: ReactNode
  children: ReactNode
  defaultCollapsed?: boolean
  icon?: ReactNode
  label: ReactNode
}

export function StatusSection({ accessory, children, defaultCollapsed = true, icon, label }: StatusSectionProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed)

  return (
    <div>
      <div className="flex items-center gap-1 pe-1">
        <button
          className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1 text-start text-xs font-normal text-muted-foreground/92 transition-colors hover:text-foreground/90"
          onClick={() => setCollapsed(open => !open)}
          type="button"
        >
          <DisclosureCaret className="shrink-0" open={!collapsed} size="1em" />
          {icon && <span className="flex shrink-0 items-center">{icon}</span>}
          <span className="truncate">{label}</span>
        </button>
        {accessory && <div className="flex shrink-0 items-center gap-1">{accessory}</div>}
      </div>
      {!collapsed && <div className="px-1 pb-0.5">{children}</div>}
    </div>
  )
}
