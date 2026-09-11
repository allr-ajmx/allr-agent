import { cva, type VariantProps } from 'class-variance-authority'

import type { IconComponent } from '@/lib/icons'
import { cn } from '@/lib/utils'

export interface SegmentedControlOption<T extends string> {
  id: T
  label: string
  icon?: IconComponent
}

interface SegmentedControlProps<T extends string> {
  options: readonly SegmentedControlOption<T>[]
  value: T
  onChange: (id: T) => void
  className?: string
  /** Dims the whole track and blocks selection (e.g. gated behind a prerequisite). */
  disabled?: boolean
}

/**
 * SegmentedControl CVA (MJXHRM-328 list/form primitives).
 */
export const segmentedControlTrackVariants = cva(
  'inline-grid w-fit auto-cols-fr grid-flow-col gap-0.5 rounded-[5px] bg-(--ui-bg-tertiary) p-0.5',
  {
    variants: {
      state: {
        default: '',
        disabled: 'opacity-50'
      }
    },
    defaultVariants: {
      state: 'default'
    }
  }
)

export const segmentedControlOptionVariants = cva(
  'flex items-center justify-center gap-1 rounded-[3px] px-2.5 py-0.5 text-[0.6875rem] font-medium transition-colors disabled:cursor-default',
  {
    variants: {
      active: {
        true: 'bg-background text-foreground shadow-sm',
        false: 'text-muted-foreground hover:text-foreground'
      }
    },
    defaultVariants: {
      active: false
    }
  }
)

export type SegmentedControlOptionVariantProps = VariantProps<typeof segmentedControlOptionVariants>

/**
 * Grouped one-row toggle used for small mutually-exclusive choices
 * (color mode, tool-call display, usage period, etc.). Flat by design —
 * no per-option borders, just a tinted track with a raised active pill.
 */
export function SegmentedControl<T extends string>({
  className,
  disabled = false,
  onChange,
  options,
  value
}: SegmentedControlProps<T>) {
  return (
    <div
      className={cn(segmentedControlTrackVariants({ state: disabled ? 'disabled' : 'default' }), className)}
      data-slot="segmented-control"
      data-state={disabled ? 'disabled' : 'default'}
    >
      {options.map(({ id, label, icon: Icon }) => {
        const active = value === id

        return (
          <button
            aria-pressed={active}
            className={segmentedControlOptionVariants({ active })}
            data-state={active ? 'active' : 'default'}
            disabled={disabled}
            key={id}
            onClick={() => onChange(id)}
            type="button"
          >
            {Icon && <Icon className="size-3" />}
            {label}
          </button>
        )
      })}
    </div>
  )
}
