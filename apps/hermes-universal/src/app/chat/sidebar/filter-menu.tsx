import { sessionDotClassName } from '@/app/chat/session-status-dot'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { type Translations, useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import {
  $sidebarFiltersActive,
  $sidebarGrouping,
  $sidebarOrdering,
  $sidebarPrFilter,
  $sidebarProjectFilter,
  $sidebarRowMeta,
  $sidebarShowArchived,
  $sidebarStatusFilter,
  $sidebarViewCustomized,
  $sidebarWorkspaceNodeOpen,
  resetSidebarView,
  setSidebarOrdering,
  setSidebarShowArchived,
  setWorkspaceNodesOpen,
  type SidebarGrouping,
  type SidebarOrdering,
  type SidebarRowMeta,
  toggleSidebarPrFilter,
  toggleSidebarProjectFilter,
  toggleSidebarRowMeta,
  toggleSidebarStatusFilter
} from '@/store/layout'
import { $projectTree, setSidebarGrouping } from '@/store/projects'
import type { PullRequestBucket } from '@/store/pull-requests'
import { $unreadFinishedSessionIds, markAllSessionsRead } from '@/store/session'
import type { SessionStatusBucket } from '@/store/session-dot-state'
import { $sessionsHaveCost } from '@/store/sidebar-archive'

/**
 * THE SIDEBAR'S VIEW MENU — grouping, ordering, row metadata and the row
 * filters, in one place.
 *
 * Ported from desktop `app/chat/sidebar/filter-menu.tsx`. Three of desktop's
 * options are deliberately absent because universal's list model has no place
 * to put them, not as an oversight:
 *
 *  - Grouping `date` / `status`: both are DIVIDER rows in desktop
 *    (`lib/session-date-groups`), and universal's list is a flat `SessionInfo[]`
 *    with no divider concept. See `SidebarGrouping` in `store/layout`.
 *  - Row meta `pr` / `profile`: universal's row already shows both by their own
 *    rules, so a toggle could only remove them.
 *
 * Everything else is behaviour-for-behaviour: every option here changes what the
 * sidebar renders.
 */

type Labels = Translations['sidebar']['filters']

interface Option<T extends string = string> {
  /** A status dot's full className, from the row's own vocabulary. */
  dot?: string
  icon?: string
  id: T
  label: string
}

const groupings = (f: Labels): Option<SidebarGrouping>[] => [
  { icon: 'list-unordered', id: 'sessions', label: f.groupingSessions },
  { icon: 'root-folder', id: 'project', label: f.groupingProject }
]

const orderings = (f: Labels): Option<SidebarOrdering>[] => [
  { icon: 'clock', id: 'updated', label: f.orderUpdated },
  { icon: 'add', id: 'created', label: f.orderCreated },
  { icon: 'pulse', id: 'status', label: f.orderStatus },
  { icon: 'symbol-numeric', id: 'tokens', label: f.orderTokens },
  { icon: 'credit-card', id: 'cost', label: f.orderCost },
  { icon: 'list-ordered', id: 'manual', label: f.orderManual }
]

const rowMetas = (f: Labels): Option<SidebarRowMeta>[] => [
  { icon: 'clock', id: 'updated', label: f.metaUpdated },
  { icon: 'symbol-numeric', id: 'tokens', label: f.metaTokens },
  { icon: 'credit-card', id: 'cost', label: f.metaCost }
]

const prFilters = (f: Labels): Option<PullRequestBucket>[] => [
  { icon: 'git-pull-request', id: 'open', label: f.prOpen },
  { icon: 'git-pull-request-draft', id: 'draft', label: f.prDraft },
  { icon: 'git-merge', id: 'merged', label: f.prMerged },
  { icon: 'git-pull-request-closed', id: 'closed', label: f.prClosed },
  { icon: 'circle-slash', id: 'none', label: f.prNone }
]

const statusFilters = (f: Labels): Option<SessionStatusBucket>[] => [
  { dot: sessionDotClassName('needs-input'), id: 'needs-input', label: f.statusNeedsInput },
  { dot: sessionDotClassName('working'), id: 'working', label: f.statusWorking },
  { dot: sessionDotClassName('unread'), id: 'unread', label: f.statusUnread },
  { dot: cn(sessionDotClassName('idle'), 'bg-(--ui-text-quaternary)'), id: 'idle', label: f.statusIdle }
]

function OptionGlyph({ option }: { option: Option }) {
  if (option.dot) {
    return <span aria-hidden="true" className={cn('shrink-0', option.dot)} />
  }

  return option.icon ? <Codicon className="text-(--ui-text-tertiary)" name={option.icon} size="0.8125rem" /> : null
}

/** Every option row — single or multi select — leaves the menu open, so a whole
 *  view can be set up in one pass. Only the actions at the bottom dismiss it. */
const keepOpen = (event: Event) => event.preventDefault()

function OptionCheckbox({ checked, onCheck, option }: { checked: boolean; onCheck: () => void; option: Option }) {
  return (
    <DropdownMenuCheckboxItem
      checked={checked}
      onSelect={event => {
        keepOpen(event)
        onCheck()
      }}
    >
      <OptionGlyph option={option} />
      {option.label}
    </DropdownMenuCheckboxItem>
  )
}

function OptionRadio({ option }: { option: Option }) {
  return (
    <DropdownMenuRadioItem onSelect={keepOpen} value={option.id}>
      <OptionGlyph option={option} />
      {option.label}
    </DropdownMenuRadioItem>
  )
}

export function SidebarFilterMenu({ className }: { className?: string }) {
  const { t } = useI18n()
  const f = t.sidebar.filters
  const grouping = useStore($sidebarGrouping)
  const ordering = useStore($sidebarOrdering)
  const rowMeta = useStore($sidebarRowMeta)
  const statusFilter = useStore($sidebarStatusFilter)
  const projectFilter = useStore($sidebarProjectFilter)
  const prFilter = useStore($sidebarPrFilter)
  const showArchived = useStore($sidebarShowArchived)
  const filtersActive = useStore($sidebarFiltersActive)
  const viewCustomized = useStore($sidebarViewCustomized)
  const nodeOpen = useStore($sidebarWorkspaceNodeOpen)
  const projects = useStore($projectTree)
  const hasCost = useStore($sessionsHaveCost)
  const unreadIds = useStore($unreadFinishedSessionIds)
  // Project rows default open, so "all collapsed" means every one of them has
  // been explicitly shut.
  const projectsCollapsed = projects.length > 0 && projects.every(project => nodeOpen[project.id] === false)

  const groupingLabel = groupings(f).find(option => option.id === grouping)?.label

  // Two options are conditional: dragging a row is what picks manual, so it
  // only appears as a way back out once there's a hand-picked order to leave;
  // and cost is hidden until some session actually reports spend.
  const orderingOptions = orderings(f).filter(option => {
    if (option.id === 'manual') {
      return ordering === 'manual'
    }

    return option.id !== 'cost' || hasCost || ordering === 'cost'
  })

  const rowMetaOptions = rowMetas(f).filter(option => option.id !== 'cost' || hasCost || rowMeta.includes('cost'))

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={f.trigger}
          className={cn(
            className,
            'data-[state=open]:bg-(--ui-control-active-background) data-[state=open]:text-foreground data-[state=open]:opacity-100',
            // Active filters read as "this control is engaged", the same way the
            // open menu does — never as an accent, which the sidebar reserves
            // for a session that is actually doing something.
            filtersActive && 'bg-(--ui-control-active-background) text-foreground opacity-100'
          )}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <Codicon name="list-filter" size="0.75rem" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="min-w-52">
        <DropdownMenuGroup>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger hideChevron>
              {f.grouping}
              <span className="ml-auto flex items-center gap-1 pl-4 text-(--ui-text-tertiary)">
                {groupingLabel}
                <Codicon name="chevron-right" size="1rem" />
              </span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuRadioGroup
                onValueChange={value => setSidebarGrouping(value as SidebarGrouping)}
                value={grouping}
              >
                {groupings(f).map(option => (
                  <OptionRadio key={option.id} option={option} />
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          <DropdownMenuSub>
            <DropdownMenuSubTrigger>{f.ordering}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuRadioGroup
                onValueChange={value => setSidebarOrdering(value as SidebarOrdering)}
                value={ordering}
              >
                {orderingOptions.map(option => (
                  <OptionRadio key={option.id} option={option} />
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          <DropdownMenuSub>
            <DropdownMenuSubTrigger>{f.show}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {rowMetaOptions.map(option => (
                <OptionCheckbox
                  checked={rowMeta.includes(option.id)}
                  key={option.id}
                  onCheck={() => toggleSidebarRowMeta(option.id)}
                  option={option}
                />
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuGroup>

        <DropdownMenuSeparator />

        <DropdownMenuGroup>
          <DropdownMenuLabel>{f.sectionLabel}</DropdownMenuLabel>

          <DropdownMenuSub>
            <DropdownMenuSubTrigger>{f.status}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {statusFilters(f).map(option => (
                <OptionCheckbox
                  checked={statusFilter.includes(option.id)}
                  key={option.id}
                  onCheck={() => toggleSidebarStatusFilter(option.id)}
                  option={option}
                />
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          {/* Unlike desktop this is never hidden: universal's git facade is the
              gateway's REST bridge, which always exposes `review.prList`. A
              backend whose `gh` is missing or unauthenticated simply reports
              every row as `none`, which the filter handles. */}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>{f.pullRequest}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {prFilters(f).map(option => (
                <OptionCheckbox
                  checked={prFilter.includes(option.id)}
                  key={option.id}
                  onCheck={() => toggleSidebarPrFilter(option.id)}
                  option={option}
                />
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          {projects.length > 1 && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>{f.project}</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-80 overflow-y-auto">
                {projects.map(project => (
                  <OptionCheckbox
                    checked={projectFilter.includes(project.id)}
                    key={project.id}
                    onCheck={() => toggleSidebarProjectFilter(project.id)}
                    option={{
                      // Same glyph vocabulary as the project rows themselves
                      // (`projects/project-icon.tsx`), so a filter entry is
                      // recognisable as the lane it narrows to.
                      icon: project.isNoProject ? 'circle-slash' : 'root-folder',
                      id: project.id,
                      label: project.label
                    }}
                  />
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}

          <OptionCheckbox
            checked={showArchived}
            onCheck={() => setSidebarShowArchived(!showArchived)}
            option={{ id: 'archived', label: f.archived }}
          />

          {/* One way back rather than two near-identical ones: this drops the
              grouping and sort too, which "clear filters" left behind. */}
          {viewCustomized && (
            <DropdownMenuItem
              onSelect={() => {
                resetSidebarView()
                setSidebarGrouping('sessions')
              }}
            >
              {f.reset}
            </DropdownMenuItem>
          )}
        </DropdownMenuGroup>

        <DropdownMenuSeparator />

        {/* Only the project rows fold, and only when they're what you're
            looking at — sweeping Pinned and Cron shut alongside them is not
            what "collapse all" means here. Their lanes underneath keep their
            own state, so re-opening a project shows it as you left it. */}
        {grouping === 'project' && projects.length > 0 && (
          <DropdownMenuItem
            onSelect={() =>
              setWorkspaceNodesOpen(
                projects.map(project => project.id),
                projectsCollapsed
              )
            }
          >
            {projectsCollapsed ? f.expandAll : f.collapseAll}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem disabled={unreadIds.length === 0} onSelect={markAllSessionsRead}>
          {f.markAllRead}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
