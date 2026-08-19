import { BRAND_LOWER } from '@/brand'

import { AllrMark } from './allr-mark'

/**
 * The brand lockup: mark, then the lowercase wordmark in the display serif.
 *
 * Per the brand book the wordmark is always Young Serif at weight 400, always
 * lowercase, and always paired with the mark to its left. It is never
 * letterspaced and never set in caps — uppercase is reserved for pills and
 * chips. Emphasis in the display face is done with colour, never weight, which
 * is why there is only one weight to choose from.
 *
 * Proportions are taken from the brand site's own header lockup, which pairs a
 * 36px mark with a 1.55rem wordmark at gap-2 — a mark 1.45× the font size, and
 * a gap of 0.32em. Both are expressed in em so a single set of numbers holds at
 * every size; the mark reads as the dominant element, which is the point.
 *
 * The translateY is not a fudge. `align-items: center` centres the mark on the
 * text's LINE box, but "allr" has no descenders, so its ink sits high in that
 * box and the mark lands ~0.08em low. (The brand site has the same drift.) A
 * transform corrects it without touching layout — a negative margin would only
 * move it half as far, because flex recentres on the outer box afterwards.
 *
 * Sizes: `sm` is app chrome (splash, connect, About nav), `md` the About panel,
 * `lg` the chat empty state — which uses the brand's hero clamp rather than
 * being fitted to the column, since a four-letter word stretched to the
 * composer width reads as a mistake.
 */

const SCALE = {
  sm: 'text-[0.9375rem]',
  md: 'text-[1.375rem]',
  lg: 'text-[clamp(2.5rem,6vw,4rem)]'
} as const

interface WordmarkProps {
  size?: keyof typeof SCALE
  className?: string
}

export function Wordmark({ className = '', size = 'sm' }: WordmarkProps) {
  return (
    <div className={`flex min-w-0 items-center gap-[0.32em] leading-none ${SCALE[size]} ${className}`}>
      <AllrMark className="size-[1.45em] shrink-0 -translate-y-[0.08em]" />
      <span className="font-brand text-(--ui-text-primary)">{BRAND_LOWER}</span>
    </div>
  )
}
