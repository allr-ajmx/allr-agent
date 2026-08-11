import { type ReactNode, useCallback, useRef, useState } from 'react'

import { useResizeObserver } from '@/hooks/use-resize-observer'
import { ChevronDown } from '@/lib/icons'
import { cn } from '@/lib/utils'

interface ExpandableBlockProps {
  children: ReactNode
  className?: string
}

export function ExpandableBlock({ children, className }: ExpandableBlockProps) {
  const innerRef = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflowing, setOverflowing] = useState(false)

  // SHARED observer, and measurement inside ResizeObserver timing only — the two
  // halves of desktop's version of this file, neither of which came across in the
  // port (MJXHRM-45).
  //
  // The private `new ResizeObserver` this replaces meant the browser delivered
  // one callback PER MOUNTED INSTANCE whenever a common ancestor resized, and a
  // tool-heavy transcript mounts dozens of these. The synchronous `measure()`
  // before the first delivery was worse: it read `scrollHeight` while the
  // commit's layout was still dirty, forcing a reflow per instance on every
  // session switch. The observer's spec-guaranteed first delivery does the same
  // measurement with layout already clean.
  const measure = useCallback(() => {
    const el = innerRef.current

    if (el) {
      setOverflowing(el.scrollHeight > 121)
    }
  }, [])

  useResizeObserver(measure, innerRef)

  return (
    <div className="relative">
      <div
        className={cn(
          // `scrollbar-overlay` opts out of the app-wide classic thin gutters so
          // this scroller keeps platform overlay bars (no always-on track).
          'scrollbar-overlay overflow-y-auto overflow-x-auto',
          expanded ? 'max-h-[40dvh]' : 'max-h-[7.5rem]',
          className
        )}
        ref={innerRef}
      >
        {children}
      </div>
      {overflowing && (
        <button
          aria-expanded={expanded}
          aria-label={expanded ? 'Collapse' : 'Expand'}
          // The fade has to end in whatever the host surface is painted with,
          // and a code card is no longer the chat background — it has its own
          // tint. Hosts override `--expandable-fade-from`; everyone else keeps
          // the chat surface.
          className="absolute inset-x-0 bottom-0 flex h-7 cursor-pointer items-end justify-center bg-linear-to-t from-[var(--expandable-fade-from,var(--ui-chat-surface-background))] to-transparent pb-1 text-muted-foreground/70 transition-colors hover:text-foreground"
          onClick={() => setExpanded(v => !v)}
          type="button"
        >
          <ChevronDown className={cn('size-4 transition-transform', expanded && 'rotate-180')} />
        </button>
      )}
    </div>
  )
}
