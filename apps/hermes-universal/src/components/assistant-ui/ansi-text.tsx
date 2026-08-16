import { memo, useMemo } from 'react'

import { ansiColorClass, hasAnsiCodes, parseAnsi } from '@/lib/ansi'
import { cn } from '@/lib/utils'

interface AnsiTextProps {
  text: string
  className?: string
}

/** Renders text with embedded ANSI SGR codes as colored / bold spans. Falls
 *  back to a plain string node when no codes are present so the parser cost
 *  is paid only when there's something to colorize.
 *
 *  Memoized (desktop parity): both props are strings, and one expanded tool row
 *  mounts up to three of these (stdout, stderr, detail). Without the boundary an
 *  unrelated re-render of the tool card re-walks every segment list it holds. */
export const AnsiText = memo(function AnsiText({ className, text }: AnsiTextProps) {
  const segments = useMemo(() => (hasAnsiCodes(text) ? parseAnsi(text) : null), [text])

  if (!segments) {
    return <span className={className}>{text}</span>
  }

  return (
    <span className={className}>
      {segments.map((segment, index) => (
        <span
          className={cn(segment.bold && 'font-semibold', segment.fg && ansiColorClass(segment.fg))}
          key={`ansi-${index}`}
        >
          {segment.text}
        </span>
      ))}
    </span>
  )
})
