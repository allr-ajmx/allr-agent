import { type ReactNode, useLayoutEffect, useMemo, useRef } from 'react'

import { blurComposerInput } from '@/app/chat/composer/focus'
import { composerDockCard } from '@/components/chat/composer-dock'
import { StatusSection } from '@/components/chat/status-section'
import { Codicon } from '@/components/ui/codicon'
import { useI18n } from '@/i18n'
import { IS_MOBILE } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import { $previewStatusBySession, dismissPreviewArtifact, type PreviewArtifact } from '@/store/preview-status'
import { $subagentsBySession, type SubagentProgress } from '@/store/subagents'
import { $threadScrolledUp } from '@/store/thread-scroll'
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

interface ComposerStatusStackProps {
  /** The queue chrome, built by the composer (it owns the queue callbacks). */
  queue: ReactNode
  sessionId: null | string
}

export function ComposerStatusStack({ queue, sessionId }: ComposerStatusStackProps) {
  const { t } = useI18n()
  const bySession = useStore($subagentsBySession)
  const previewBySession = useStore($previewStatusBySession)
  const scrolledUp = useStore($threadScrolledUp)

  const subagents = useMemo<SubagentProgress[]>(
    () => (sessionId ? (bySession[sessionId] ?? bySession.active ?? []) : (bySession.active ?? [])),
    [bySession, sessionId]
  )

  const previews = useMemo<PreviewArtifact[]>(
    () => (sessionId ? (previewBySession[sessionId] ?? []) : []),
    [previewBySession, sessionId]
  )

  const sections: { key: string; node: ReactNode }[] = []

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
            <StatusItemRow
              item={item}
              key={item.id}
              // Watch a running subagent in its own native window (desktop only,
              // and not from a pop-out; MJX-104). Child id via `child_session_id`.
              onOpen={
                canOpenSessionWindow() && item.sessionId
                  ? () => void openSessionInNewWindow(item.sessionId!, { watch: true })
                  : undefined
              }
            />
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
            <PreviewStatusRow item={item} key={item.id} onDismiss={id => dismissPreviewArtifact(sessionId, id)} />
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
