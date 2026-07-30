import { type ReactNode, useEffect, useMemo } from 'react'
import { useLocation } from 'react-router-dom'

import { jobState } from '@/app/cron/job-state'
import { PlatformGlyph } from '@/app/messaging/platform-icon'
import { AGENTS_ROUTE, appViewForPath, CRON_ROUTE } from '@/app/routes'
import { useApprovalModeStatusbarItem } from '@/app/shell/approval-mode-menu'
import { ContextUsagePanel } from '@/app/shell/context-usage-panel'
import { GatewayMenuPanel } from '@/app/shell/gateway-menu-panel'
import type { StatusbarItem } from '@/app/shell/statusbar-controls'
import { Codicon } from '@/components/ui/codicon'
import { StatusDot } from '@/components/ui/status-dot'
import { useI18n } from '@/i18n'
import { Activity, AlertCircle, Clock, Command, FolderOpen, Hash, Loader2, Terminal, Zap } from '@/lib/icons'
import { IS_DESKTOP, IS_MOBILE } from '@/lib/platform'
import { revealPathInFileManager } from '@/lib/reveal-path'
import { contextBarLabel, LiveDuration, usageContextLabel } from '@/lib/statusbar'
import { cn } from '@/lib/utils'
import { workspaceLabel } from '@/lib/workspace-path'
import { useStore } from '@/store/atom'
import { $busy, $currentUsage, $sessionId, $sessionStartedAt, $turnStartedAt } from '@/store/chat'
import { $connection, $status } from '@/store/connection'
import { $cronJobs, refreshCronJobs } from '@/store/cron'
import { $gatewayState, requestGateway } from '@/store/gateway'
import { $terminalOpen, revealFileInTree, toggleTerminalOpen } from '@/store/layout'
import { notify } from '@/store/notifications'
import { $activeProfile } from '@/store/profiles'
import { $subagentsBySession, activeSubagentCount, failedSubagentCount } from '@/store/subagents'
import { $appVersion, $gatewayRestarting, $inferenceStatus, $statusSnapshot } from '@/store/system-status'
import { openSystemScreen } from '@/store/windows'
import { $effectiveCwd, ensureWorkspaceCwd } from '@/store/workspace-events'

// Copy the absolute cwd to the clipboard, toasting on success (mirrors the
// file-tree context menu's copy-path behavior).
function copyWorkspacePath(cwd: string, copiedMsg: string): void {
  void navigator.clipboard.writeText(cwd).then(() => notify({ kind: 'success', message: copiedMsg }))
}

// Ported/adapted from apps/desktop/src/app/shell/hooks/use-statusbar-items.tsx.
// Assembles the left/right statusbar item descriptors from universal stores.
// Divergences from desktop, all driven by the remote-client shape:
//   • command-center / agents / cron navigate to routes (with an active
//     highlight from the current view) instead of toggling in-window panels;
//   • version items link to the Command Center system panel (no client
//     self-updater by design; the backend-update flow lives there);
//   • the workspace-cwd menu drops desktop's OS-reveal entry unless we're a
//     desktop app on a LOCAL backend (the cwd is a remote path otherwise);
//   • chrome-y items (command-center / cron / versions) hide on phones so the
//     touch bar stays a compact live-status strip.

export function useStatusbarItems(opts?: {
  /** `statusBar.left` contributions, appended AFTER the core left group. */
  extraLeftItems?: readonly StatusbarItem[]
  /** `statusBar.right` contributions, prepended BEFORE the core right group so
   *  they sit inboard of the version/terminal cluster (desktop's ordering). */
  extraRightItems?: readonly StatusbarItem[]
  includeAll?: boolean
  rich?: boolean
}): {
  leftStatusbarItems: readonly StatusbarItem[]
  statusbarItems: readonly StatusbarItem[]
} {
  // `includeAll` re-surfaces the chrome-y items normally hidden on phones
  // (command-center / cron / versions) — the mobile Status list wants the full
  // set. Desktop calls with no args, so IS_MOBILE is false and nothing changes.
  const hideOnMobile = IS_MOBILE && !opts?.includeAll
  // `rich` (the mobile Status list) reformats a few details for at-a-glance
  // reading — emphasized values, cron active/paused bullets. Off for the bar.
  const rich = Boolean(opts?.rich)
  const { t } = useI18n()
  const copy = t.shell.statusbar
  const view = appViewForPath(useLocation().pathname)

  const gatewayState = useStore($gatewayState)
  const statusSnapshot = useStore($statusSnapshot)
  const inferenceStatus = useStore($inferenceStatus)
  const gatewayRestarting = useStore($gatewayRestarting)
  const appVersion = useStore($appVersion)
  const connection = useStore($connection)
  const status = useStore($status)
  const activeProfile = useStore($activeProfile)
  const busy = useStore($busy)
  const turnStartedAt = useStore($turnStartedAt)
  const sessionStartedAt = useStore($sessionStartedAt)
  const currentUsage = useStore($currentUsage)
  const sessionId = useStore($sessionId)
  const subagentsBySession = useStore($subagentsBySession)
  const terminalOpen = useStore($terminalOpen)
  // The active chat's project directory, falling back to the workspace root.
  const currentCwd = useStore($effectiveCwd)
  const cronJobs = useStore($cronJobs)

  const fileMenu = t.fileMenu
  const contextUsage = usageContextLabel(currentUsage)
  const contextBar = contextBarLabel(currentUsage)
  const approvalModeItem = useApprovalModeStatusbarItem(activeProfile ?? '', requestGateway)

  const { subagentsFailed, subagentsRunning } = useMemo(() => {
    const lists = Object.values(subagentsBySession)

    return {
      subagentsFailed: lists.reduce((sum, items) => sum + failedSubagentCount(items), 0),
      subagentsRunning: lists.reduce((sum, items) => sum + activeSubagentCount(items), 0)
    }
  }, [subagentsBySession])

  // ---- gateway-health derivation (matches the desktop hook) ----
  const gatewayOpen = gatewayState === 'open'
  const gatewayConnecting = gatewayState === 'connecting'
  const inferenceReady = gatewayOpen && inferenceStatus?.ready === true
  const gatewayDegraded = gatewayOpen || gatewayConnecting

  // Load the backend workspace root so the cwd segment can render. Re-runs when
  // the gateway (re)opens: `resetWorkspaceCwd` clears it on reconnect, and
  // `ensureWorkspaceCwd` no-ops when it's already loaded.
  useEffect(() => {
    if (gatewayOpen) {
      void ensureWorkspaceCwd()
    }
  }, [gatewayOpen])

  // The rich (mobile) list shows cron active/paused counts, so pull the job list
  // when it mounts. The bar doesn't use counts, so this only runs for `rich`.
  useEffect(() => {
    if (rich && gatewayOpen) {
      void refreshCronJobs()
    }
  }, [rich, gatewayOpen])

  // Cron active/paused split (rich only) — active = scheduled/enabled/running,
  // paused = paused; the rest (disabled/completed/error) aren't counted here.
  const { cronActive, cronPaused } = useMemo(() => {
    let active = 0
    let paused = 0

    for (const job of cronJobs) {
      const state = jobState(job)

      if (state === 'paused') {
        paused += 1
      } else if (state === 'scheduled' || state === 'enabled' || state === 'running') {
        active += 1
      }
    }

    return { cronActive: active, cronPaused: paused }
  }, [cronJobs])

  const gatewayDetail = gatewayOpen
    ? inferenceStatus?.ready
      ? copy.gatewayReady
      : inferenceStatus
        ? copy.gatewayNeedsSetup
        : copy.gatewayChecking
    : gatewayConnecting
      ? copy.gatewayConnecting
      : copy.gatewayOffline

  const gatewayClassName = inferenceReady
    ? undefined
    : gatewayDegraded
      ? 'text-amber-600 hover:text-amber-600'
      : 'text-destructive hover:text-destructive'

  const gatewayMenuContent = (close: () => void) => (
    <GatewayMenuPanel
      gatewayState={gatewayState}
      inferenceStatus={inferenceStatus}
      onClose={close}
      onOpenSystem={() => void openSystemScreen()}
      statusSnapshot={statusSnapshot}
    />
  )

  const isRemoteBackend = connection?.mode === 'remote' || connection?.mode === 'cloud'
  const backendVersion = status?.version

  // Emphasized (accent/blue) value for the rich list — the status VALUE stays
  // highlighted; the row's label uses the plain nav-row typography.
  const accent = (node: ReactNode) => <span className="font-medium text-(--ui-accent)">{node}</span>

  // Gateway status glyphs for the rich gateway row: a thunder (api-server
  // running = accent/blue, else orange) + up to 3 messaging platforms, painted
  // in brand color when connected and greyed otherwise. Connected first.
  const gatewayRunning = statusSnapshot?.gateway_running === true

  const messagingPlatforms = Object.entries(statusSnapshot?.gateway_platforms ?? {})
    .filter(([id]) => id !== 'api_server')
    .sort(([, a], [, b]) => Number(b.state === 'connected') - Number(a.state === 'connected'))
    .slice(0, 3)

  const gatewayIcons = (
    <span className="flex items-center gap-1.5">
      <Zap className={cn('size-4', gatewayRunning ? 'text-(--ui-accent)' : 'text-(--ui-orange)')} />
      {messagingPlatforms.map(([id, platform]) => (
        <PlatformGlyph key={id} muted={platform.state !== 'connected'} platformId={id} platformName={id} />
      ))}
    </span>
  )

  // Inference readiness text ("Ready" / "Needs setup" / …) — accent when ready.
  const gatewayReadyText = gatewayRestarting ? copy.gatewayRestarting : gatewayDetail

  const gatewayRichDetail = (
    <span className="flex items-center gap-2">
      {inferenceReady ? accent(gatewayReadyText) : gatewayReadyText}
      {gatewayIcons}
    </span>
  )

  // Cron active/paused bullet counts for the rich cron row.
  const cronDetail = (
    <span className="flex items-center gap-2">
      <span className="flex items-center gap-1">
        <StatusDot tone="good" />
        {cronActive}
      </span>
      <span className="flex items-center gap-1">
        <StatusDot tone="warn" />
        {cronPaused}
      </span>
    </span>
  )

  const leftStatusbarItems: StatusbarItem[] = [
    {
      className: cn('w-7 justify-center px-0', view === 'command-center' && 'bg-accent/55 text-foreground'),
      hidden: hideOnMobile,
      icon: <Command className="size-3.5" />,
      id: 'command-center',
      onSelect: () => void openSystemScreen(),
      title: copy.openCommandCenter,
      variant: 'action'
    },
    {
      className: gatewayRestarting ? undefined : gatewayClassName,
      // Rich: readiness text (is inference ready) + status glyphs (api-server
      // thunder + messaging platforms). Bar: the plain state text.
      detail: rich ? gatewayRichDetail : gatewayReadyText,
      icon: gatewayRestarting ? (
        <Codicon className="size-3 animate-spin" name="loading" size="0.75rem" />
      ) : inferenceReady ? (
        <Activity className="size-3" />
      ) : (
        <AlertCircle className="size-3" />
      ),
      id: 'gateway-health',
      label: copy.gateway,
      menuClassName: 'w-72',
      menuContent: gatewayMenuContent,
      title: inferenceStatus?.reason || copy.gatewayTitle,
      variant: 'menu'
    },
    {
      // The rich list shows the full path as the value; the bar keeps the short
      // workspace label only.
      detail: rich && currentCwd ? currentCwd : undefined,
      hidden: !currentCwd,
      icon: <FolderOpen className="size-3" />,
      id: 'workspace-cwd',
      label: currentCwd ? workspaceLabel(currentCwd) : undefined,
      menuItems: currentCwd
        ? [
            {
              id: 'copy-workspace-path',
              label: fileMenu.copyPath,
              onSelect: () => copyWorkspacePath(currentCwd, fileMenu.pathCopied),
              title: currentCwd
            },
            {
              // OS reveal only makes sense on a desktop app talking to a local
              // backend — on remote/cloud the cwd is a path on the remote box.
              hidden: !(IS_DESKTOP && !isRemoteBackend),
              id: 'reveal-workspace-finder',
              label: fileMenu.revealFileManager,
              onSelect: () => void revealPathInFileManager(currentCwd),
              title: currentCwd
            },
            {
              id: 'reveal-workspace-sidebar',
              label: fileMenu.revealInSidebar,
              onSelect: () => revealFileInTree(currentCwd),
              title: currentCwd
            }
          ]
        : undefined,
      title: currentCwd || undefined,
      variant: 'menu'
    },
    {
      className: cn(
        view === 'agents' && 'bg-accent/55 text-foreground',
        subagentsFailed > 0 && 'text-destructive hover:text-destructive'
      ),
      detail:
        subagentsFailed > 0
          ? copy.failed(subagentsFailed)
          : subagentsRunning > 0
            ? copy.subagents(subagentsRunning)
            : // The rich list always shows the running count (even 0); the bar
              // shows nothing when idle.
              rich
              ? copy.subagents(subagentsRunning)
              : undefined,
      icon:
        subagentsFailed > 0 ? (
          <AlertCircle className="size-3" />
        ) : subagentsRunning > 0 ? (
          <Loader2 className="size-3 animate-spin" />
        ) : (
          <Codicon name="hubot" size="0.75rem" />
        ),
      id: 'agents',
      label: copy.agents,
      title: copy.openAgents,
      to: AGENTS_ROUTE,
      variant: 'action'
    },
    {
      detail: rich ? cronDetail : undefined,
      hidden: hideOnMobile,
      icon: <Clock className="size-3" />,
      id: 'cron',
      label: copy.cron,
      title: copy.openCron,
      to: CRON_ROUTE,
      variant: 'action'
    }
  ]

  const statusbarItems: StatusbarItem[] = [
    {
      detail: <LiveDuration since={turnStartedAt} />,
      hidden: !busy || !turnStartedAt,
      icon: <Loader2 className="size-3 animate-spin" />,
      id: 'running-timer',
      label: copy.turnRunning,
      title: copy.currentTurnElapsed,
      variant: 'text'
    },
    {
      detail: contextBar || undefined,
      hidden: !contextUsage,
      id: 'context-usage',
      label: contextUsage,
      menuAlign: 'end',
      menuClassName: 'w-auto border-(--ui-stroke-secondary) p-0',
      menuContent: (
        <ContextUsagePanel currentUsage={currentUsage} requestGateway={requestGateway} sessionId={sessionId} />
      ),
      title: copy.openContextUsage,
      variant: 'menu'
    },
    {
      detail: <LiveDuration since={sessionStartedAt} />,
      hidden: !sessionStartedAt,
      id: 'session-timer',
      label: copy.session,
      title: copy.runtimeSessionElapsed,
      variant: 'text'
    },
    {
      ...approvalModeItem,
      // Rich: a fixed "Approval" label with the mode name as a muted value; drop
      // the bar-only background className.
      ...(rich ? { className: undefined, detail: accent(approvalModeItem.label), label: 'Approval' } : {}),
      hidden: gatewayState !== 'open'
    },
    {
      className: cn('w-7 justify-center px-0', terminalOpen && 'bg-accent/55 text-foreground'),
      icon: <Terminal className="size-3.5" />,
      id: 'terminal',
      onSelect: () => toggleTerminalOpen(),
      title: terminalOpen ? copy.hideTerminal : copy.showTerminal,
      variant: 'action'
    },
    {
      // Rich: "Client" + the version as a muted value on the right; the bar shows
      // the combined "client vX" label.
      detail: rich && appVersion ? accent(`v${appVersion}`) : undefined,
      hidden: hideOnMobile || !appVersion,
      icon: <Hash className="size-3" />,
      id: 'version-client',
      label: rich ? 'Client' : appVersion ? copy.clientLabel(appVersion) : copy.unknown,
      onSelect: () => void openSystemScreen(),
      title: appVersion ? copy.clientLabel(appVersion) : undefined,
      variant: 'action'
    },
    {
      detail: rich && backendVersion ? accent(`v${backendVersion}`) : undefined,
      hidden: hideOnMobile || !isRemoteBackend || !backendVersion,
      icon: <Hash className="size-3" />,
      id: 'version-backend',
      label: rich ? 'Backend' : backendVersion ? copy.backendLabel(backendVersion) : copy.unknown,
      onSelect: () => void openSystemScreen(),
      title: backendVersion ? copy.backendVersion(backendVersion) : undefined,
      variant: 'action'
    }
  ]

  // Contribution ordering matches desktop (use-statusbar-items.tsx:542-548):
  // left = core then contributed; right = contributed then core, so plugin chips
  // sit inboard of the app's own right-hand cluster (terminal, versions).
  // No useMemo: the core arrays above are fresh literals every render, so a memo
  // keyed on them could never hit — and nothing downstream depends on identity.
  return {
    leftStatusbarItems: [...leftStatusbarItems, ...(opts?.extraLeftItems ?? [])],
    statusbarItems: [...(opts?.extraRightItems ?? []), ...statusbarItems]
  }
}
