import { cva, type VariantProps } from 'class-variance-authority'

import { Codicon } from '@/components/ui/codicon'
import { triggerHaptic } from '@/lib/haptics'
import { cn } from '@/lib/utils'

import { shellAccent, shellChromeSurface, shellTabActive, shellTabIdle } from './cva/tokens'

/**
 * MobileTabButton / MobileTabBar CVA (MJXHRM-314).
 */
export const mobileTabButtonVariants = cva(
  'relative flex min-h-11 min-w-14 flex-1 flex-col items-center justify-center gap-0.5 rounded-md px-1 py-1 transition-colors',
  {
    variants: {
      active: {
        true: shellTabActive,
        false: shellTabIdle
      }
    },
    defaultVariants: {
      active: false
    }
  }
)

export const mobileTabBadgeVariants = cva(
  'absolute -top-1 -end-2 rounded-full bg-(--ui-accent-primary) text-[0.5625rem] leading-none font-medium text-white',
  {
    variants: {
      kind: {
        dot: 'size-1.5',
        count: 'min-w-3.5 px-1 py-0.5 text-center'
      }
    },
    defaultVariants: {
      kind: 'count'
    }
  }
)

export const mobileTabIndicatorVariants = cva('absolute inset-x-3 bottom-0 h-0.5 rounded-full', {
  variants: {
    active: {
      true: shellAccent,
      false: 'bg-transparent'
    }
  },
  defaultVariants: {
    active: false
  }
})

export const mobileTabBarVariants = cva(cn('shrink-0 border-t keyboard-open:hidden', shellChromeSurface), {
  variants: {
    state: {
      default: '',
      hidden: 'hidden'
    }
  },
  defaultVariants: {
    state: 'default'
  }
})

export type MobileTabButtonVariantProps = VariantProps<typeof mobileTabButtonVariants>

// One entry in a phone surface's bottom bar.
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
      className={mobileTabButtonVariants({ active: !!active })}
      data-slot="mobile-tab-button"
      data-state={active ? 'active' : 'default'}
      onClick={() => {
        void triggerHaptic('selection')
        onSelect()
      }}
      type="button"
    >
      <span className="relative">
        <Codicon name={icon} size="1.15rem" />
        {showBadge && (
          <span className={mobileTabBadgeVariants({ kind: badge === true ? 'dot' : 'count' })}>
            {badge === true ? '' : badge}
          </span>
        )}
      </span>
      <span className="w-full truncate text-center text-[0.625rem] leading-none">{label}</span>
      <span className={mobileTabIndicatorVariants({ active: !!active })} />
    </button>
  )
}

/**
 * The bar the buttons sit in — border, chrome fill and the bottom safe area.
 * Stands down while the soft keyboard is up (`keyboard-open:hidden`).
 */
export function MobileTabBar({ ariaLabel, children }: { ariaLabel: string; children: React.ReactNode }) {
  return (
    <nav
      aria-label={ariaLabel}
      className={mobileTabBarVariants()}
      data-slot="mobile-tab-bar"
      style={{ paddingBottom: 'var(--safe-area-inset-bottom)' }}
    >
      <div className="flex items-stretch gap-0.5 overflow-x-auto px-1 py-0.5">{children}</div>
    </nav>
  )
}
