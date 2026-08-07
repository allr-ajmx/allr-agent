import { Codicon } from '@/components/ui/codicon'
import { triggerHaptic } from '@/lib/haptics'
import { cn } from '@/lib/utils'

// One entry in a phone surface's bottom bar.
//
// The bar is the primary navigation on a surface you drive one-handed, so it
// lives in the thumb zone and its entries are icon-over-label — the shape every
// phone OS uses for exactly this, and the reason it reads without being learned.
// Shared by the Workspace's panel tabs and the sidebar's nav so the two bottom
// bars are the same control rather than two that merely look alike.
export function MobileTabButton({
  active,
  badge,
  icon,
  label,
  onSelect
}: {
  active?: boolean
  /** Rendered as a count pill; `true` renders a bare dot. */
  badge?: boolean | number
  icon: string
  label: string
  onSelect: () => void
}) {
  const showBadge = badge === true || (typeof badge === 'number' && badge > 0)

  return (
    <button
      aria-current={active ? 'page' : undefined}
      className={cn(
        'relative flex min-h-11 min-w-14 flex-1 flex-col items-center justify-center gap-0.5 rounded-md px-1 py-1 transition-colors',
        active ? 'text-foreground' : 'text-muted-foreground'
      )}
      onClick={() => {
        void triggerHaptic('selection')
        onSelect()
      }}
      type="button"
    >
      <span className="relative">
        <Codicon name={icon} size="1.15rem" />
        {showBadge && (
          <span
            className={cn(
              'absolute -top-1 -right-2 rounded-full bg-(--ui-accent-primary) text-[0.5625rem] leading-none font-medium text-white',
              badge === true ? 'size-1.5' : 'min-w-3.5 px-1 py-0.5 text-center'
            )}
          >
            {badge === true ? '' : badge}
          </span>
        )}
      </span>
      <span className="w-full truncate text-center text-[0.625rem] leading-none">{label}</span>
      {/* The active marker is a bar rather than a filled pill: at this size a
          pill crowds the label, and the bar reads at a glance. */}
      <span
        className={cn(
          'absolute inset-x-3 bottom-0 h-0.5 rounded-full',
          active ? 'bg-(--ui-accent-primary)' : 'bg-transparent'
        )}
      />
    </button>
  )
}

/** The bar the buttons sit in — border, chrome fill and the bottom safe area. */
export function MobileTabBar({ ariaLabel, children }: { ariaLabel: string; children: React.ReactNode }) {
  return (
    <nav
      aria-label={ariaLabel}
      className="shrink-0 border-t border-(--ui-stroke-tertiary) bg-(--ui-bg-chrome)"
      style={{ paddingBottom: 'var(--safe-area-inset-bottom)' }}
    >
      {/* Scrolls rather than crushes: a plugin can contribute a nav row, and five
          entries is the comfortable count, not the maximum. */}
      <div className="flex items-stretch gap-0.5 overflow-x-auto px-1 py-0.5">{children}</div>
    </nav>
  )
}
