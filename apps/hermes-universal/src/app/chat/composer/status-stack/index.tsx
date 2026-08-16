import { type ReactNode, useCallback, useLayoutEffect, useRef } from 'react'

import { blurComposerInput } from '@/app/chat/composer/focus'
import { BillingBanner } from '@/components/chat/billing-banner'
import { composerDockCard } from '@/components/chat/composer-dock'
import { StatusSection } from '@/components/chat/status-section'
import { Codicon } from '@/components/ui/codicon'
import { useI18n } from '@/i18n'
import { IS_MOBILE } from '@/lib/platform'
import { useStoreSelector } from '@/lib/use-session-slice'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import { $billingBlock } from '@/store/billing-block'
import { $previewStatusBySession, dismissPreviewArtifact, type PreviewArtifact } from '@/store/preview-status'
import { $subagentsBySession, type SubagentProgress } from '@/store/subagents'
import { sessionThreadScrolledUp } from '@/store/thread-scroll'
import { canOpenSessionWindow, openSessionInNewWindow } from '@/store/windows'

import { PreviewStatusRow } from './preview-row'
import { StatusItemRow } from './status-row'

// Adapted from apps/desktop/src/app/chat/composer/status-stack/index.tsx. The
// desktop stack fuses todos + subagents + background processes + preview
// artifacts + queue; universal wires the three feeds it has — subagents
// ($subagentsBySession), preview artifacts ($previewStatusBySession) and the
// queue — and renders only what carries data. Todos / background rows are
// deferred (FLAG(chat-port)).
//
// Section order follows desktop: groups → preview → queue.
//
// One deliberate omission: desktop drops localhost preview rows once no
// background process is running (its `isLocalhostPreview` filter), so a dead dev
// server stops being offered. Universal has no background-process feed to gate
// on, so every recorded artifact stays until dismissed — better than hiding rows
// on a signal that never arrives. Revisit when the background feed lands.

// Shared empties so an absent slice never yields a fresh array — a fresh array
// would defeat the snapshot bail-out below and re-render on every store write,
// which is the exact churn the narrowing exists to remove.
const NO_SUBAGENTS: SubagentProgress[] = []
const NO_PREVIEWS: PreviewArtifact[] = []

interface ComposerStatusStackProps {
  /** The queue chrome, built by the composer (it owns the queue callbacks). */
  queue: ReactNode
  sessionId: null | string
}

export function ComposerStatusStack({ queue, sessionId }: ComposerStatusStackProps) {
  const { t } = useI18n()
  // Keyed per session (MJXHRM-381). This was a global boolean, and the stack
  // mounts once per open tile — so scrolling one tile's transcript dimmed and
  // re-rendered every other tile's status card, and closing a tile reset the
  // flag out from under a tile that was still scrolled up.
  const scrolledUp = useStore(sessionThreadScrolledUp(sessionId))

  // NARROWED (MJXHRM-381). The block is a single global slot but only ever
  // renders on the session it names, so a whole-atom read meant a credit wall
  // raised on one session re-rendered every other tile's stack. Selecting to
  // `null` for every other session is what makes it quiet: their snapshots
  // compare equal. Returns the store's OWN object when it matches, never a fresh
  // one — a rebuilt object would defeat `useStoreSelector`'s `Object.is` bail.
  const billing = useStoreSelector($billingBlock, block =>
    block && sessionId && block.sessionId === sessionId ? block : null
  )

  // NARROWED TO THIS SESSION'S SLICE (MJXHRM-45). Both stores are
  // `Record<sessionId, T[]>` written immutably per key, and this component
  // mounts ONCE PER OPEN TILE — so reading the maps whole meant one session's
  // subagent tick (which lands per tool/thinking chunk while an agent runs)
  // re-rendered every other tile's status stack too. `delegate.tsx` and
  // `micro-actions.tsx` already narrowed the identical stores with
  // `useSessionSlice`; this file simply had not adopted it.
  //
  // `useStoreSelector` rather than `useSessionSlice`, deliberately: the subagent
  // lookup falls back to the `active` bucket only when this session has NO entry
  // at all, and an entry holding an empty list is not the same thing as a
  // missing one. A per-key slice hook cannot tell those apart; the selector
  // keeps the original `??` chain exactly. It returns the stored array's own
  // reference (or a shared empty), so the snapshot comparison still bails.
  const subagents = useStoreSelector($subagentsBySession, map =>
    sessionId ? (map[sessionId] ?? map.active ?? NO_SUBAGENTS) : (map.active ?? NO_SUBAGENTS)
  )

  const previews = useStoreSelector($previewStatusBySession, map =>
    sessionId ? (map[sessionId] ?? NO_PREVIEWS) : NO_PREVIEWS
  )

  // Stable handlers for the two memoized rows below. Built here rather than
  // inline at the call sites, where a fresh arrow per row per render made both
  // `memo()` boundaries inert (MJXHRM-45).
  const dismissPreview = useCallback(
    (id: string) => {
      if (sessionId) {
        dismissPreviewArtifact(sessionId, id)
      }
    },
    [sessionId]
  )

  // Watch a running subagent in its own native window (desktop only, and not
  // from a pop-out; MJX-104). Child id via `child_session_id`.
  const canOpenSubagentWindow = canOpenSessionWindow()

  const openSubagentWindow = useCallback((subagentSessionId: string) => {
    void openSessionInNewWindow(subagentSessionId, { watch: true })
  }, [])

  const sections: { key: string; node: ReactNode }[] = []

  // Billing wall sits at the very top of the stack — it's the most important
  // thing above the composer when the account is out of credits. Rendered here
  // (not as a composer-disable) so slash commands stay usable.
  // `billing` is already this session's or null — the selector above did the
  // matching, so there is nothing left to compare here.
  if (billing && sessionId) {
    sections.push({ key: 'billing', node: <BillingBanner sessionId={sessionId} /> })
  }

  if (subagents.length > 0) {
    sections.push({
      key: 'subagent',
      node: (
        <StatusSection
          defaultCollapsed
          icon={<Codicon className="text-muted-foreground/70" name="organization" size="0.8rem" />}
          label={t.statusStack.subagents(subagents.length)}
        >
          {subagents.map(item => (
            // `onOpen` / `canOpen` are hoisted and stable, so the row's memo
            // can actually bail (MJXHRM-45). They used to be a fresh arrow per
            // row per render, which made the memo inert.
            <StatusItemRow canOpen={canOpenSubagentWindow} item={item} key={item.id} onOpen={openSubagentWindow} />
          ))}
        </StatusSection>
      )
    })
  }

  // Preview artifacts sit below the collapsible group sections and above the
  // queue, so they stay visible even when a section collapses (desktop parity).
  if (sessionId && previews.length > 0) {
    sections.push({
      key: 'preview',
      node: (
        <div className="px-1 py-0.5">
          {previews.map(item => (
            <PreviewStatusRow item={item} key={item.id} onDismiss={dismissPreview} />
          ))}
        </div>
      )
    })
  }

  if (queue) {
    sections.push({ key: 'queue', node: queue })
  }

  const visible = sections.length > 0
  const stackRef = useRef<HTMLDivElement | null>(null)

  // Desktop only. There the stack is out of flow (overlays the thread), so the
  // composer's measured height never sees it — publish our own bucketed height
  // so the thread's last-message clearance can add it and the stack never hides
  // messages. On mobile the stack is IN flow, so it is already inside
  // --composer-measured-height and adding it again would double-count, leaving
  // a card-sized hole under the last message.
  useLayoutEffect(() => {
    const root = document.documentElement
    const el = stackRef.current

    if (!visible || !el || IS_MOBILE) {
      root.style.removeProperty('--status-stack-measured-height')

      return
    }

    let last = -1

    const sync = () => {
      const bucket = Math.round(el.getBoundingClientRect().height / 8) * 8

      if (bucket !== last) {
        last = bucket
        root.style.setProperty('--status-stack-measured-height', `${bucket}px`)
      }
    }

    const observer = new ResizeObserver(sync)
    observer.observe(el)
    sync()

    return () => {
      observer.disconnect()
      root.style.removeProperty('--status-stack-measured-height')
    }
  }, [visible])

  if (!visible) {
    return null
  }

  return (
    <div
      // Desktop: out of flow, hanging off the composer SURFACE, whose top edge
      // is exactly where the card's fused bottom border belongs. (No
      // `translate-y` nudge — it used to hang off the composer root and needed
      // +8px to cross that box's `pt-2` gap; here that would slide it over the
      // input.)
      //
      // Mobile: in flow, so it opens a real gap instead of growing upward over
      // whatever is there. Out of flow it covered the parallel-chat rail, which
      // sits in flow immediately above this same edge — the rail is navigation
      // and has to stay on top, so a file the agent just made hid the way to
      // switch chats. In flow the order reads top to bottom: rail, card, input.
      className={cn('z-3 max-h-[40vh] overflow-y-auto', !IS_MOBILE && 'absolute inset-x-0 bottom-full')}
      onPointerDownCapture={() => blurComposerInput()}
      ref={stackRef}
    >
      <div
        className={cn(
          composerDockCard('top'),
          'mx-2 overflow-hidden rounded-b-none border-b border-b-transparent pt-0.5',
          'transition-opacity duration-200 ease-out',
          scrolledUp ? 'opacity-30 group-hover/composer:opacity-100' : 'opacity-100'
        )}
      >
        {sections.map(section => (
          <div key={section.key}>{section.node}</div>
        ))}
      </div>
    </div>
  )
}
