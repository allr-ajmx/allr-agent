import { useState } from 'react'

import { useHermesConfigRecord } from '@/app/hooks/use-config-record'
import { Wordmark } from '@/components/brand/wordmark'
import { normalize } from '@/lib/text'
import { useStore } from '@/store/atom'
import { $introSeed } from '@/store/chat'

import { resolveIntroCopy } from './intro-copy'

/** `display.personality` from the profile config — the copy set to draw from.
 *  Mirrors desktop's normalizePersonalityValue (lib/chat-runtime): the neutral
 *  values collapse to '' so resolveIntroCopy takes the `none` set. */
function usePersonality(): string {
  const { data } = useHermesConfigRecord()
  const display = (data?.display ?? {}) as Record<string, unknown>
  const value = normalize(typeof display.personality === 'string' ? display.personality : '')

  return !value || value === 'default' || value === 'none' ? '' : value
}

// This used to fit the wordmark to the column width — a hidden twin measured
// the text at a reference size and the visible copy was scaled to match, which
// is how desktop's CSS trig fit was reproduced for WebKitGTK. That machinery is
// gone: the wordmark is now a four-letter word beside a logo mark, and
// stretching it edge-to-edge reads as a bug rather than as a brand. It uses the
// brand's own hero clamp instead (see components/brand/wordmark.tsx), so there
// is nothing left to measure.
export function Intro() {
  // Desktop's pair: a random seed picked once per mount, plus a counter the
  // store bumps on every new chat — so the line rotates even if this component
  // is never unmounted between chats.
  const [mountSeed] = useState(() => Math.floor(Math.random() * 100_000))
  const introSeed = useStore($introSeed)
  const personality = usePersonality()
  const copy = resolveIntroCopy(personality, mountSeed + introSeed)

  return (
    <div
      className="pointer-events-none flex w-full min-w-0 flex-col items-center justify-center px-0.5 py-6 text-center text-muted-foreground sm:px-6 lg:px-8"
      data-slot="aui_intro"
      style={{ paddingBottom: 'var(--composer-measured-height)' }}
    >
      <div className="mx-auto flex w-full min-w-0 max-w-[min(var(--composer-width),82vw)] flex-col items-center">
        <Wordmark className="mb-3 justify-center" size="lg" />

        <p className="m-0 mx-auto max-w-[34rem] text-center text-[0.875rem] leading-[1.45] tracking-tight text-(--ui-text-tertiary)">
          {copy.body}
        </p>
      </div>
    </div>
  )
}
