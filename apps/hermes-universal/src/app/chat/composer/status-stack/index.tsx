import { type ReactNode, useLayoutEffect, useMemo, useRef } from 'react'

import { blurComposerInput } from '@/app/chat/composer/focus'
import { composerDockCard } from '@/components/chat/composer-dock'
import { StatusSection } from '@/components/chat/status-section'
import { Codicon } from '@/components/ui/codicon'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import { $subagentsBySession, type SubagentProgress } from '@/store/subagents'
import { $threadScrolledUp } from '@/store/thread-scroll'
import { canOpenSessionWindow, openSessionInNewWindow } from '@/store/windows'

import { StatusItemRow } from './status-row'

// Adapted from apps/desktop/src/app/chat/composer/status-stack/index.tsx. The
// desktop stack fuses todos + subagents + background processes + preview
// artifacts + queue; universal wires the two feeds it has — subagents
// ($subagentsBySession) and the queue — and renders only what carries data.
// Todos / background / preview rows are deferred (FLAG(chat-port)).

interface ComposerStatusStackProps {
  /** The queue chrome, built by the composer (it owns the queue callbacks). */
  queue: ReactNode
  sessionId: null | string
}

export function ComposerStatusStack({ queue, sessionId }: ComposerStatusStackProps) {
  const { t } = useI18n()
  const bySession = useStore($subagentsBySession)
  const scrolledUp = useStore($threadScrolledUp)

  const subagents = useMemo<SubagentProgress[]>(
    () => (sessionId ? (bySession[sessionId] ?? bySession.active ?? []) : (bySession.active ?? [])),
    [bySession, sessionId]
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

  if (queue) {
    sections.push({ key: 'queue', node: queue })
  }

  const visible = sections.length > 0
  const stackRef = useRef<HTMLDivElement | null>(null)

  // The stack is out of flow (overlays the thread), so the composer's measured
  // height never sees it. Publish our own bucketed measured height so the
  // thread's last-message clearance can add it and the stack never hides messages.
  useLayoutEffect(() => {
    const root = document.documentElement
    const el = stackRef.current

    if (!visible || !el) {
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
      className="absolute inset-x-0 bottom-full z-3 max-h-[40vh] translate-y-2 overflow-y-auto"
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
