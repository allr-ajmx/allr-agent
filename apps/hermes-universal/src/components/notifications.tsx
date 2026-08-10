import { type CSSProperties, type ReactNode, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import { AlertCircle, AlertTriangle, CheckCircle2, Info, X } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import { $notifications, type AppNotification, dismissNotification, type NotificationKind } from '@/store/notifications'

// Lean mobile toast stack (the desktop NotificationStack's dual-placement +
// expander UI is collapsed to a single top-center column of ≤4 cards, portaled
// above sheets/dialogs). The store (store/notifications.ts) is shared.

type IconComponent = (props: { className?: string; style?: CSSProperties }) => React.ReactNode

const TONE: Record<NotificationKind, { icon: IconComponent; iconClass: string }> = {
  error: { icon: AlertCircle, iconClass: 'text-destructive' },
  warning: { icon: AlertTriangle, iconClass: 'text-primary' },
  info: { icon: Info, iconClass: 'text-muted-foreground' },
  success: { icon: CheckCircle2, iconClass: 'text-primary' }
}

export function NotificationStack() {
  const notifications = useStore($notifications)
  const { t } = useI18n()
  const lastIdRef = useRef<string | null>(null)

  // Haptic pulse when a new toast arrives (mobile has no 'error' intent → warning).
  useEffect(() => {
    const latest = notifications[0]

    if (!latest || latest.id === lastIdRef.current) {
      return
    }

    lastIdRef.current = latest.id

    if (latest.kind === 'success') {
      void triggerHaptic('success')
    } else if (latest.kind === 'error' || latest.kind === 'warning') {
      void triggerHaptic('warning')
    }
  }, [notifications])

  if (notifications.length === 0 || typeof document === 'undefined') {
    return null
  }

  return createPortal(
    <div
      aria-label={t.notifications.region}
      className="pointer-events-none fixed inset-x-0 top-[max(0.75rem,env(safe-area-inset-top))] z-[200] mx-auto flex w-[min(32rem,calc(100%-1.5rem))] flex-col gap-2"
      role="region"
    >
      {notifications.map(n => (
        <NotificationItem dismissLabel={t.notifications.dismiss} key={n.id} notification={n} />
      ))}
    </div>,
    document.body
  )
}

// A money token inside an accented message is the number the user is actually
// reading ("You've used $180.00 of your $220.00 cap"), so it takes the accent at
// full strength while the rest of the line stays calm. Mirrors desktop.
function renderMessage(message: string, accent?: string): ReactNode {
  const match = accent ? /\$\d+(?:\.\d{2})?/.exec(message) : null

  if (!match) {
    return message
  }

  const start = match.index
  const end = start + match[0].length

  return (
    <>
      {message.slice(0, start)}
      <span className="font-semibold" style={{ color: accent }}>
        {match[0]}
      </span>
      {message.slice(end)}
    </>
  )
}

function NotificationItem({ dismissLabel, notification }: { dismissLabel: string; notification: AppNotification }) {
  const { icon: Icon, iconClass } = TONE[notification.kind]
  // `accentColor` (when set) tints the icon + the money token as a severity ramp,
  // overriding the kind's default color.
  const accent = notification.accentColor
  const iconStyle: CSSProperties | undefined = accent ? { color: accent } : undefined

  return (
    <div className="pointer-events-auto flex items-start gap-2.5 rounded-lg border border-border bg-popover/95 p-3 text-popover-foreground shadow-md backdrop-blur-md">
      <Icon className={cn('mt-0.5 size-4 shrink-0', iconClass)} style={iconStyle} />
      <div className="min-w-0 flex-1">
        {notification.title && <div className="text-sm font-semibold">{notification.title}</div>}
        <div className="text-sm break-words text-muted-foreground">{renderMessage(notification.message, accent)}</div>
        {notification.meta && (
          <div className="mt-0.5 text-xs tabular-nums break-words text-muted-foreground/80">{notification.meta}</div>
        )}
        {notification.detail && (
          <div className="mt-1 font-mono text-xs break-words text-muted-foreground/80">{notification.detail}</div>
        )}
        {notification.action && (
          <Button className="mt-2" onClick={notification.action.onClick} size="sm" variant="outline">
            {notification.action.label}
          </Button>
        )}
      </div>
      <button
        aria-label={dismissLabel}
        className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        onClick={() => dismissNotification(notification.id)}
        type="button"
      >
        <X className="size-4" />
      </button>
    </div>
  )
}
