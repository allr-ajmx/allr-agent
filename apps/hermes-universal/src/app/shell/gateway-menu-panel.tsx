import { type ReactNode, useEffect, useRef, useState } from 'react'

import { GatewayConfigurator } from '@/app/gateway/gateway-configurator'
import { GATEWAY_SETTINGS_ROUTE } from '@/app/routes'
import { Button } from '@/components/ui/button'
import { LogView } from '@/components/ui/log-view'
import { StatusDot, type StatusTone } from '@/components/ui/status-dot'
import { Tip } from '@/components/ui/tooltip'
import { getLogs } from '@/hermes'
import { useI18n } from '@/i18n'
import { ChevronRight, LayoutDashboard, RefreshCw } from '@/lib/icons'
import { LOG_NOISE_RE, trimLogLine } from '@/lib/log-format'
import type { RuntimeReadinessResult } from '@/lib/runtime-readiness'
import { cn } from '@/lib/utils'
import { runGatewayRestart } from '@/store/system-status'
import { openAppRoute } from '@/store/windows'
import type { StatusResponse } from '@/types/hermes'

// Ported from apps/desktop/src/app/shell/gateway-menu-panel.tsx. The gateway
// health popover: connection + inference dots, restart / open-system actions, a
// live-tailing gateway log, and the messaging-platform states. Universal swaps
// desktop's `store/system-actions` restart for the system-status one.

/** How the popover offers a gateway change:
 *  • 'embedded' — the inline configurator, re-homing without ever leaving the
 *    popover (the roomy desktop statusbar menu);
 *  • 'link'     — a row that leaves for Settings ▸ Gateway, where the connect form
 *    gets a full screen (the phone's 19rem Status drawer, too cramped for one);
 *  • 'none'     — no affordance at all. */
export type GatewaySwitchAffordance = 'embedded' | 'link' | 'none'

interface GatewayMenuPanelProps {
  gatewayState: string
  gatewaySwitch?: GatewaySwitchAffordance
  inferenceStatus: RuntimeReadinessResult | null
  onClose: () => void
  onOpenSystem: () => void
  statusSnapshot: StatusResponse | null
}

const LOG_TAIL = 120
const LOG_VISIBLE = 40
const LOG_POLL_MS = 3_000

// Live tail while the popover is mounted (i.e. open): poll on a tight cadence
// and stop on unmount, instead of a global always-on status poll.
function useGatewayLogTail(): string[] {
  const [lines, setLines] = useState<string[]>([])

  useEffect(() => {
    let cancelled = false

    const load = () =>
      getLogs({ file: 'gui', lines: LOG_TAIL })
        .then(res => {
          if (cancelled) {
            return
          }

          setLines(
            res.lines
              .map(line => line.trim())
              .filter(line => line && !LOG_NOISE_RE.test(line))
              .slice(-LOG_VISIBLE)
          )
        })
        .catch(() => {})

    void load()
    const timer = window.setInterval(load, LOG_POLL_MS)

    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  return lines
}

const PLATFORM_TONE: Record<string, StatusTone> = {
  connected: 'good',
  connecting: 'warn',
  retrying: 'warn',
  pending_restart: 'warn',
  startup_failed: 'bad',
  fatal: 'bad'
}

const prettyState = (state: string) => state.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())

export function GatewayMenuPanel({
  gatewayState,
  gatewaySwitch = 'none',
  inferenceStatus,
  onClose,
  onOpenSystem,
  statusSnapshot
}: GatewayMenuPanelProps) {
  const { t } = useI18n()
  const copy = t.shell.gatewayMenu
  const [configuratorOpen, setConfiguratorOpen] = useState(false)

  // Both jumps open the system panel, which owns the full view — so dismiss the
  // little status popover on the way out.
  const openSystem = () => {
    onClose()
    onOpenSystem()
  }

  // `link` mode: hand the switch to Settings ▸ Gateway, which owns a full-screen
  // configurator. `openAppRoute` picks the surface per platform — the native screen
  // Activity on Android (an in-WebView route change when we're already inside it),
  // the in-app full-screen surface on iOS. Dismiss the popover on the way out.
  const changeGateway = () => {
    onClose()
    openAppRoute(GATEWAY_SETTINGS_ROUTE)
  }

  // Shared restart helper: never rejects and surfaces progress in the statusbar
  // gateway indicator, so just fire and close.
  const restart = () => {
    onClose()
    void runGatewayRestart()
  }

  const gatewayOpen = gatewayState === 'open'
  const gatewayConnecting = gatewayState === 'connecting'
  const inferenceReady = gatewayOpen && inferenceStatus?.ready === true

  const connectionLabel = gatewayOpen
    ? copy.connected
    : gatewayConnecting
      ? copy.connecting
      : prettyState(gatewayState || copy.offline)

  const inferenceLabel = gatewayOpen
    ? inferenceStatus?.ready
      ? copy.inferenceReady
      : inferenceStatus
        ? copy.inferenceNotReady
        : copy.checkingInference
    : copy.disconnected

  const platforms = Object.entries(statusSnapshot?.gateway_platforms || {}).sort(([l], [r]) => l.localeCompare(r))
  const recentLogs = useGatewayLogTail()

  // Keep the tail pinned to the latest line as it streams.
  const logScrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = logScrollRef.current

    if (el) {
      el.scrollTop = el.scrollHeight
    }
  }, [recentLogs])

  return (
    <div className="text-sm">
      <div className="flex items-center justify-between gap-3 px-3 py-2">
        <div className="flex min-w-0 flex-col gap-1 text-[0.7rem] leading-none">
          <span className="flex items-center gap-1.5 font-medium">
            <StatusDot tone={gatewayOpen ? 'good' : gatewayConnecting ? 'warn' : 'bad'} />
            {connectionLabel}
          </span>
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <StatusDot tone={inferenceReady ? 'good' : gatewayOpen ? 'warn' : 'bad'} />
            {inferenceLabel}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Tip label={t.commandCenter.restartGateway}>
            <Button
              aria-label={t.commandCenter.restartGateway}
              className="text-muted-foreground hover:text-foreground"
              onClick={restart}
              size="icon-xs"
              variant="ghost"
            >
              <RefreshCw />
            </Button>
          </Tip>
          <Tip label={copy.openSystem}>
            <Button
              aria-label={copy.openSystem}
              className="text-muted-foreground hover:text-foreground"
              onClick={openSystem}
              size="icon-xs"
              variant="ghost"
            >
              <LayoutDashboard />
            </Button>
          </Tip>
        </div>
      </div>

      {inferenceStatus?.reason && (
        <Section className="text-xs text-muted-foreground">
          <div className="line-clamp-3">{inferenceStatus.reason}</div>
        </Section>
      )}

      {recentLogs.length > 0 && (
        <Section>
          <div className="flex items-center justify-between gap-2">
            <SectionLabel>{copy.recentActivity}</SectionLabel>
            <Button
              className="-mr-2 h-auto py-0 font-medium leading-none text-muted-foreground"
              onClick={openSystem}
              size="xs"
              type="button"
              variant="text"
            >
              {copy.viewAllLogs}
            </Button>
          </div>
          <LogView className="mt-1.5 max-h-40 border-0 px-0" ref={logScrollRef}>
            {recentLogs.map(trimLogLine).join('\n')}
          </LogView>
        </Section>
      )}

      {platforms.length > 0 && (
        <Section>
          <SectionLabel>{copy.messagingPlatforms}</SectionLabel>
          <ul className="mt-1.5 space-y-1">
            {platforms.map(([name, platform]) => (
              <li className="flex items-center justify-between gap-2 text-xs" key={name}>
                <span className="truncate capitalize">{name}</span>
                <span className="flex items-center gap-1.5 text-[0.66rem] text-muted-foreground">
                  <StatusDot tone={PLATFORM_TONE[platform.state] || 'muted'} />
                  {prettyState(platform.state)}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* Re-home the app onto another gateway without leaving for Settings. The
          connect surface is the shared configurator in its `embedded` variant, and
          connecting is a SOFT switch — the shell (and this popover, until it
          dismisses itself) stays mounted across the swap. */}
      {gatewaySwitch === 'embedded' && (
        <Section>
          <Button
            className="-ml-1 h-auto py-0 font-medium leading-none text-muted-foreground"
            onClick={() => setConfiguratorOpen(open => !open)}
            size="xs"
            type="button"
            variant="text"
          >
            {configuratorOpen ? copy.hideGatewaySettings : copy.changeGateway}
          </Button>
          {configuratorOpen && (
            // Radix DropdownMenu typeahead swallows character keys, which would make
            // the URL / token inputs untypable (the same reason DropdownMenuSearch
            // stops propagation).
            <div className="mt-2" onKeyDown={event => event.stopPropagation()}>
              <GatewayConfigurator onConnected={onClose} variant="embedded" />
            </div>
          )}
        </Section>
      )}

      {/* Same affordance where the popover can't host a form (the phone's Status
          drawer): the chevron says it leaves for Settings ▸ Gateway rather than
          expanding in place. Same wording, so it reads as the one "Change gateway". */}
      {gatewaySwitch === 'link' && (
        <Section>
          <Button
            className="-ml-1 h-auto gap-0.5 py-0 font-medium leading-none text-muted-foreground"
            onClick={changeGateway}
            size="xs"
            type="button"
            variant="text"
          >
            {copy.changeGateway}
            <ChevronRight className="size-3" />
          </Button>
        </Section>
      )}
    </div>
  )
}

function Section({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('border-t border-border/50 px-3 py-2', className)}>{children}</div>
}

function SectionLabel({ children }: { children: string }) {
  return (
    <div className="text-[0.62rem] font-semibold uppercase tracking-[0.14em] text-muted-foreground/80">{children}</div>
  )
}
