import { useEffect, useMemo, useState } from 'react'

import { jobState, jobTitle, STATE_DOT } from '@/app/cron/job-state'
import { ActionsContextMenu, ActionsMenu, type MenuKit, renderActionItem } from '@/components/ui/actions-menu'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { DisclosureCaret } from '@/components/ui/disclosure-caret'
import { Tip } from '@/components/ui/tooltip'
import { deleteCronJob, getCronJobRuns, pauseCronJob, resumeCronJob } from '@/hermes'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import { updateCronJobs } from '@/store/cron'
import { $changeEventsAvailable, $cronChangeTick, livePollIntervalMs } from '@/store/live-sync'
import { notify, notifyError } from '@/store/notifications'
import { $activeStoredSessionId } from '@/store/session'
import type { CronJob, SessionInfo } from '@/types/hermes'

import { SidebarPanelLabel } from '../../shell/sidebar-label'

import { SidebarLoadMoreRow } from './load-more-row'

// Ported/adapted from desktop `app/chat/sidebar/cron-jobs-section.tsx`.
const INACTIVE_STATES = new Set(['completed', 'disabled', 'error', 'paused'])
const PEEK_RUN_LIMIT = 5
// Runs are written by the background scheduler tick. `cron.changed` reloads the
// open peek immediately on an event-capable backend, so the poll drops to a
// backstop there; an older gateway keeps the legacy cadence.
const PEEK_POLL_INTERVAL_MS = 8000
const PEEK_BACKSTOP_INTERVAL_MS = 60_000
const INITIAL_VISIBLE_JOBS = 3
const LOAD_MORE_STEP = 10

function nextRunMs(job: CronJob): null | number {
  if (!job.next_run_at) {
    return null
  }

  const ms = Date.parse(job.next_run_at)

  return Number.isNaN(ms) ? null : ms
}

// Compact future/past countdown, e.g. "in 5m" / "3h ago".
function relativeTime(target: number, now: number): string {
  const diff = target - now
  const s = Math.round(Math.abs(diff) / 1000)

  const unit =
    s < 60
      ? `${s}s`
      : s < 3600
        ? `${Math.floor(s / 60)}m`
        : s < 86_400
          ? `${Math.floor(s / 3600)}h`
          : `${Math.floor(s / 86_400)}d`

  return diff >= 0 ? `in ${unit}` : `${unit} ago`
}

function formatRunTime(seconds?: null | number): string {
  if (!seconds) {
    return '—'
  }

  const date = new Date(seconds < 1e12 ? seconds * 1000 : seconds)

  return Number.isNaN(date.valueOf())
    ? '—'
    : date.toLocaleString(undefined, { day: 'numeric', hour: 'numeric', minute: '2-digit', month: 'short' })
}

interface SidebarCronJobsSectionProps {
  jobs: CronJob[]
  label: string
  max?: number
  onOpenRun: (sessionId: string) => void
  onManageJob: (jobId: string) => void
  onTriggerJob: (jobId: string) => void
  onToggle: () => void
  open: boolean
}

export function SidebarCronJobsSection({
  jobs,
  label,
  max = 50,
  onManageJob,
  onOpenRun,
  onTriggerJob,
  onToggle,
  open
}: SidebarCronJobsSectionProps) {
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [peekJobId, setPeekJobId] = useState<null | string>(null)
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_JOBS)

  useEffect(() => {
    if (!open) {
      return
    }

    const id = window.setInterval(() => setNowMs(Date.now()), 1000)

    return () => window.clearInterval(id)
  }, [open])

  const sorted = useMemo(() => {
    return [...jobs].sort((a, b) => {
      const an = nextRunMs(a)
      const bn = nextRunMs(b)

      if (an !== null && bn !== null && an !== bn) {
        return an - bn
      }

      if (an === null && bn !== null) {
        return 1
      }

      if (an !== null && bn === null) {
        return -1
      }

      return jobTitle(a).localeCompare(jobTitle(b))
    })
  }, [jobs])

  const cap = Math.min(visibleCount, max)
  const shown = sorted.slice(0, cap)
  const hiddenCount = Math.min(sorted.length, max) - shown.length
  const countLabel = jobs.length > max ? `${max}+` : String(jobs.length)

  return (
    <div className="flex shrink-0 flex-col p-0 pb-1">
      <div className="group/section flex shrink-0 items-center justify-between pb-1 pt-1.5">
        <button
          className="group/section-label flex w-fit items-center gap-1 bg-transparent text-left leading-none"
          onClick={onToggle}
          type="button"
        >
          <SidebarPanelLabel>{label}</SidebarPanelLabel>
          <span className="text-[0.6875rem] font-medium text-(--ui-text-quaternary)">{countLabel}</span>
          <DisclosureCaret
            className="text-(--ui-text-tertiary) opacity-0 transition group-hover/section-label:opacity-100"
            open={open}
          />
        </button>
      </div>
      {open && (
        <div className="flex max-h-72 flex-col gap-px overflow-x-hidden overflow-y-auto overscroll-contain pb-1.5 pr-2.5">
          {shown.map(job => (
            <CronJobSidebarRow
              expanded={peekJobId === job.id}
              job={job}
              key={job.id}
              nowMs={nowMs}
              onManage={() => onManageJob(job.id)}
              onOpenRun={onOpenRun}
              onTogglePeek={() => setPeekJobId(prev => (prev === job.id ? null : job.id))}
              onTrigger={() => onTriggerJob(job.id)}
            />
          ))}
          {hiddenCount > 0 && (
            <SidebarLoadMoreRow
              onClick={() => setVisibleCount(count => count + LOAD_MORE_STEP)}
              step={Math.min(LOAD_MORE_STEP, hiddenCount)}
            />
          )}
        </div>
      )}
    </div>
  )
}

function CronJobSidebarRow({
  expanded,
  job,
  nowMs,
  onManage,
  onOpenRun,
  onTogglePeek,
  onTrigger
}: {
  expanded: boolean
  job: CronJob
  nowMs: number
  onManage: () => void
  onOpenRun: (sessionId: string) => void
  onTogglePeek: () => void
  onTrigger: () => void
}) {
  const { t } = useI18n()
  const c = t.cron
  const state = jobState(job)
  const next = nextRunMs(job)
  const label = jobTitle(job)
  const isPaused = state === 'paused'

  const meta = INACTIVE_STATES.has(state) ? (c.states[state] ?? state) : next !== null ? relativeTime(next, nowMs) : '—'

  // Pause/resume and delete aren't threaded through the sidebar's prop chain, so
  // drive them against the shared $cronJobs atom directly (same path the cron
  // overlay uses) — the sidebar and overlay render from that one atom, so the
  // row updates in place.
  const togglePause = async () => {
    try {
      const updated = isPaused ? await resumeCronJob(job.id) : await pauseCronJob(job.id)
      updateCronJobs(rows => rows.map(row => (row.id === job.id ? updated : row)))
      notify({ kind: 'success', title: isPaused ? c.resumed : c.paused, message: label })
    } catch (err) {
      notifyError(err, c.failedUpdate)
    }
  }

  const remove = async () => {
    if (!window.confirm(`${c.deleteDescPrefix}${label}${c.deleteDescSuffix}`)) {
      return
    }

    try {
      await deleteCronJob(job.id)
      updateCronJobs(rows => rows.filter(row => row.id !== job.id))
      notify({ kind: 'success', title: c.deleted, message: label })
    } catch (err) {
      notifyError(err, c.failedDelete)
    }
  }

  // One action set for both the hover buttons and the right-click menu.
  const items = (kit: MenuKit) => (
    <>
      {renderActionItem(kit, { icon: 'zap', key: 'trigger', label: c.triggerNow, onSelect: onTrigger })}
      {renderActionItem(kit, {
        icon: isPaused ? 'play' : 'debug-pause',
        key: 'pause',
        label: isPaused ? c.resume : c.pause,
        onSelect: () => void togglePause()
      })}
      {renderActionItem(kit, { icon: 'watch', key: 'manage', label: c.manage, onSelect: onManage })}
      <kit.Separator />
      {renderActionItem(kit, {
        icon: 'trash',
        key: 'delete',
        label: t.common.delete,
        onSelect: () => void remove(),
        variant: 'destructive'
      })}
    </>
  )

  return (
    <div>
      <ActionsContextMenu ariaLabel={c.actionsTitle} contentClassName="w-44" items={items}>
        <div className="group/cron relative grid min-h-[1.625rem] grid-cols-[minmax(0,1fr)_auto] items-center rounded-md hover:bg-(--chrome-action-hover)">
          <Tip label={label}>
            <button
              aria-expanded={expanded}
              aria-label={expanded ? c.hideRuns : c.showRuns}
              className="flex min-w-0 items-center gap-1.5 bg-transparent py-0.5 pl-2 pr-1 text-left"
              onClick={onTogglePeek}
              type="button"
            >
              <span className="grid w-3.5 shrink-0 place-items-center">
                <span
                  aria-hidden="true"
                  className={cn(
                    'size-1 rounded-full',
                    STATE_DOT[state] ?? 'bg-(--ui-text-quaternary)',
                    state === 'running' && 'size-1.5 animate-pulse'
                  )}
                />
              </span>
              <span className="min-w-0 truncate text-[0.8125rem] text-(--ui-text-secondary) group-hover/cron:text-foreground">
                {label}
              </span>
              <DisclosureCaret
                className={cn(
                  'shrink-0 text-(--ui-text-tertiary) transition',
                  expanded ? 'opacity-100' : 'opacity-0 group-hover/cron:opacity-100'
                )}
                open={expanded}
              />
            </button>
          </Tip>
          <div className="group/cron-actions flex items-center gap-0.5 justify-self-end pr-1">
            {/* Hover swaps the next-run time out for the actions; on touch there
                is no hover, so the buttons stay put. Inverted rather than
                layered: the touch layout is the base and the swap is scoped to
                `fine:`, so the two can never both claim the slot. The label
                beside them is `min-w-0 truncate`, so it yields the width.
                Right-click reaches the same actions, and so does the kebab —
                which is the ONLY route to pause/resume/delete for a finger,
                since a touch device has no right-click. */}
            {/* `group-has-[[data-state=open]]` keeps the cluster up while the
                kebab's menu is open — otherwise moving the pointer onto the
                portalled menu unhovers the row and pulls the trigger out from
                under it. */}
            <span className="text-[0.6875rem] text-(--ui-text-tertiary) tabular-nums fine:group-hover/cron:hidden fine:group-has-[[data-state=open]]/cron-actions:hidden">
              {meta}
            </span>
            <div className="flex items-center gap-0.5 fine:hidden fine:group-hover/cron:flex fine:group-has-[[data-state=open]]/cron-actions:flex">
              <Tip label={c.triggerNow}>
                <button
                  aria-label={c.triggerNow}
                  className="grid size-5 place-items-center rounded-sm text-(--ui-text-tertiary) hover:bg-(--ui-control-hover-background) hover:text-foreground"
                  onClick={onTrigger}
                  type="button"
                >
                  <Codicon name="zap" size="0.75rem" />
                </button>
              </Tip>
              <Tip label={c.manage}>
                <button
                  aria-label={c.manage}
                  className="grid size-5 place-items-center rounded-sm text-(--ui-text-tertiary) hover:bg-(--ui-control-hover-background) hover:text-foreground"
                  onClick={onManage}
                  type="button"
                >
                  <Codicon name="watch" size="0.75rem" />
                </button>
              </Tip>
              <ActionsMenu ariaLabel={c.actionsTitle} contentClassName="w-44" items={items} sideOffset={4}>
                <Button
                  aria-label={c.actionsTitle}
                  // No tip: this is a DropdownMenu trigger, and a tooltip on a
                  // menu trigger fights the open menu. `aria-label` names it.
                  className="size-5 rounded-sm bg-transparent text-(--ui-text-tertiary) hover:bg-(--ui-control-hover-background) hover:text-foreground data-[state=open]:bg-(--ui-control-active-background) data-[state=open]:text-foreground [&_svg]:size-3!"
                  size="icon"
                  variant="ghost"
                >
                  <Codicon name="kebab-vertical" size="0.75rem" />
                </Button>
              </ActionsMenu>
            </div>
          </div>
        </div>
      </ActionsContextMenu>
      {expanded && <CronJobSidebarRuns jobId={job.id} onOpenRun={onOpenRun} />}
    </div>
  )
}

function CronJobSidebarRuns({ jobId, onOpenRun }: { jobId: string; onOpenRun: (sessionId: string) => void }) {
  const { t } = useI18n()
  const c = t.cron
  const selectedSessionId = useStore($activeStoredSessionId)
  const changeEventsAvailable = useStore($changeEventsAvailable)
  const cronChangeTick = useStore($cronChangeTick)
  const [runs, setRuns] = useState<null | SessionInfo[]>(null)

  useEffect(() => {
    let cancelled = false

    const load = () =>
      getCronJobRuns(jobId, PEEK_RUN_LIMIT)
        .then(result => {
          if (!cancelled) {
            setRuns(result)
          }
        })
        .catch(() => {
          if (!cancelled) {
            setRuns(prev => prev ?? [])
          }
        })

    void load()

    const intervalId = window.setInterval(
      () => {
        if (document.visibilityState === 'visible') {
          void load()
        }
      },
      livePollIntervalMs(PEEK_POLL_INTERVAL_MS, PEEK_BACKSTOP_INTERVAL_MS)
    )

    return () => {
      cancelled = true
      window.clearInterval(intervalId)
    }
    // cronChangeTick in the deps IS the refresh: a run the scheduler just wrote
    // moves cron/jobs.json, the watcher broadcasts, and this effect re-runs and
    // reloads — instead of the peek sitting stale for up to a poll window.
  }, [changeEventsAvailable, cronChangeTick, jobId])

  return (
    <div className="mb-1 ml-[1.375rem] flex flex-col gap-px">
      {runs === null ? (
        <div className="flex items-center gap-1.5 py-1 pl-1 text-[0.6875rem] text-(--ui-text-tertiary)">
          <Codicon className="animate-spin" name="loading" size="0.75rem" />
        </div>
      ) : runs.length === 0 ? (
        <div className="py-1 pl-1 text-[0.6875rem] text-(--ui-text-tertiary)">{c.noRuns}</div>
      ) : (
        runs.map(run => (
          <button
            className={cn(
              'truncate rounded-md px-1.5 py-0.5 text-left text-[0.6875rem] tabular-nums',
              run.id === selectedSessionId
                ? 'bg-(--ui-row-active-background) text-foreground'
                : 'text-(--ui-text-secondary) hover:bg-(--chrome-action-hover) hover:text-foreground'
            )}
            key={run.id}
            onClick={() => onOpenRun(run.id)}
            type="button"
          >
            {formatRunTime(run.last_active || run.started_at)}
          </button>
        ))
      )}
    </div>
  )
}
