import { useEffect, useRef, useState } from 'react'

import { previewFile } from '@/app/contrib/panes'
import { RightSidebarPane } from '@/app/right-pane'
import { PreviewRail } from '@/app/right-pane/preview/preview-rail'
import { absolutePath } from '@/app/right-pane/review/file-tree'
import { MobileReview } from '@/app/right-pane/review/mobile-review'
import { TerminalArea } from '@/app/right-pane/terminal/terminal-area'
import { MobileChromeBar, MobileChromeSpacer } from '@/app/shell/mobile-chrome-bar'
import { MobileStatusList } from '@/app/shell/mobile-status-list'
import { TitlebarButton } from '@/app/shell/titlebar-button'
import { Codicon } from '@/components/ui/codicon'
import { useI18n } from '@/i18n'
import { ESCAPE_PRIORITY, isTopEscapeLayer, pushEscapeLayer } from '@/lib/escape-layers'
import { triggerHaptic } from '@/lib/haptics'
import { persistentAtom } from '@/lib/persisted'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import { $currentCwd } from '@/store/chat'
import { $dirtyPreviewPaths } from '@/store/preview-edit'
import { $reviewFiles, openReview } from '@/store/review'
import { $effectiveCwd } from '@/store/workspace-events'

// The phone's Workspace: everything the desktop keeps in the right-pane column
// stack (review, files, editor, terminal) plus the status list, as ONE
// full-screen surface with a bottom tab bar.
//
// Why a surface and not a wider drawer: a diff, an editor and an xterm each need
// the full width, their own keyboard handling and their own back stack; hosting
// them in a 19rem sheet compromises all four. Why the bar is at the BOTTOM: it is
// the primary navigation on a surface you drive one-handed, so it belongs in the
// thumb zone — the top row stays for context and escape.
//
// Ordering is deliberate and is NOT the desktop's. On a phone the surface opens
// on Status — the "what is this thing doing right now" answer you reach for
// one-handed — and Review sits next to it because seeing what the agent changed
// is the second question. The desktop leads with files because you build there.
//
// The chat is never lost: this surface is a sibling of it, one tap away in either
// direction, and every panel stays mounted so scroll, diff position, editor buffer
// and live shells survive tab switches.

type TabId = 'editor' | 'files' | 'review' | 'status' | 'terminal'

interface TabDef {
  icon: string
  id: TabId
}

const TABS: readonly TabDef[] = [
  { icon: 'pulse', id: 'status' },
  { icon: 'git-compare', id: 'review' },
  { icon: 'files', id: 'files' },
  { icon: 'file-code', id: 'editor' },
  { icon: 'terminal', id: 'terminal' }
]

function isTabId(value: string): value is TabId {
  return TABS.some(tab => tab.id === value)
}

/** Survives close/reopen: coming back to the Workspace should land where you left
 *  it, the same way the old right drawer remembered Status vs Files. */
const $workspaceTab = persistentAtom<TabId>('hermes.workspaceTab', 'status', {
  decode: raw => (isTabId(raw) ? raw : 'status'),
  encode: value => value
})

/** The trailing path segment — the project name, which is all that fits. */
function projectLabel(cwd: string): string {
  const trimmed = cwd.replace(/[/\\]+$/, '')
  const parts = trimmed.split(/[/\\]/)

  return parts[parts.length - 1] || trimmed
}

interface WorkspaceTabButtonProps {
  active: boolean
  /** Rendered as a count pill; `true` renders a bare dot. */
  badge?: boolean | number
  icon: string
  label: string
  onSelect: () => void
}

function WorkspaceTabButton({ active, badge, icon, label, onSelect }: WorkspaceTabButtonProps) {
  const showBadge = badge === true || (typeof badge === 'number' && badge > 0)

  return (
    <button
      aria-current={active ? 'page' : undefined}
      className={cn(
        'relative flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 rounded-md px-1 py-1 transition-colors',
        active ? 'text-foreground' : 'text-muted-foreground'
      )}
      onClick={() => {
        void triggerHaptic('selection')
        onSelect()
      }}
      type="button"
    >
      <span className="relative">
        <Codicon name={icon} size="1.15rem" />
        {showBadge && (
          <span
            className={cn(
              'absolute -top-1 -right-2 rounded-full bg-(--ui-accent-primary) text-[0.5625rem] leading-none font-medium text-white',
              badge === true ? 'size-1.5' : 'min-w-3.5 px-1 py-0.5 text-center'
            )}
          >
            {badge === true ? '' : badge}
          </span>
        )}
      </span>
      <span className="text-[0.625rem] leading-none">{label}</span>
      {/* The active marker is a bar rather than a filled pill: at this size a
          pill crowds the label, and the bar reads at a glance. */}
      <span
        className={cn(
          'absolute inset-x-3 bottom-0 h-0.5 rounded-full',
          active ? 'bg-(--ui-accent-primary)' : 'bg-transparent'
        )}
      />
    </button>
  )
}

export function MobileWorkspace({ onClose }: { onClose: () => void }) {
  const { t } = useI18n()
  const copy = t.mobileWorkspace
  const tab = useStore($workspaceTab)
  const cwd = useStore($currentCwd)
  const reviewFiles = useStore($reviewFiles)
  const dirtyPaths = useStore($dirtyPreviewPaths)

  // Panels mount on first visit and stay mounted from then on: an xterm must
  // never be torn down by a tab switch, and re-mounting the tree or a diff would
  // throw away scroll position. Cheap on first paint, sticky afterwards.
  const [visited, setVisited] = useState<Set<TabId>>(() => new Set<TabId>([tab]))
  const visitedRef = useRef(visited)
  visitedRef.current = visited

  const show = (next: TabId) => {
    $workspaceTab.set(next)

    if (!visitedRef.current.has(next)) {
      setVisited(prev => new Set(prev).add(next))
    }
  }

  useEffect(() => {
    if (!visited.has(tab)) {
      setVisited(prev => new Set(prev).add(tab))
    }
  }, [tab, visited])

  // Every review refresh trigger (a file-mutating tool finishing, the turn
  // settling, a cwd change, window focus) is gated on `$reviewOpen`. Opening the
  // Workspace is what "the review surface exists" means on a phone, so claim it
  // here — and deliberately never release it: the changed-file badge has to keep
  // updating while the user is back in the chat, which is the whole point of it.
  useEffect(() => {
    openReview()
  }, [])

  // Escape closes the surface, under the shared layer order so a Radix dialog or
  // a pinned pane inside it gets first refusal.
  useEffect(() => {
    const release = pushEscapeLayer(ESCAPE_PRIORITY.overlay)

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !isTopEscapeLayer(ESCAPE_PRIORITY.overlay)) {
        return
      }

      event.preventDefault()
      onClose()
    }

    window.addEventListener('keydown', onKeyDown)

    return () => {
      release()
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  const project = projectLabel(cwd || $effectiveCwd.get())

  const badges: Partial<Record<TabId, boolean | number>> = {
    editor: dirtyPaths.size > 0,
    review: reviewFiles.length
  }

  const labels: Record<TabId, string> = {
    editor: copy.editor,
    files: copy.files,
    review: copy.review,
    status: copy.status,
    terminal: copy.terminal
  }

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-background"
      style={{
        marginBottom: 'var(--keyboard-inset, 0px)',
        paddingLeft: 'var(--safe-area-inset-left)',
        paddingRight: 'var(--safe-area-inset-right)'
      }}
    >
      <MobileChromeBar
        // Which project this surface is acting on. On a phone there is no
        // sidebar or statusbar in view to infer it from.
        center={
          <span className="block truncate text-center text-xs text-muted-foreground">{project || copy.noProject}</span>
        }
        left={
          <TitlebarButton className="size-4" label={copy.backToChat} onClick={onClose}>
            <Codicon name="chevron-left" size="1.4rem" />
          </TitlebarButton>
        }
        right={<MobileChromeSpacer />}
      />

      <main className="relative min-h-0 flex-1">
        {visited.has('review') && (
          <div className={cn('absolute inset-0 flex min-h-0 flex-col', tab !== 'review' && 'hidden')}>
            <MobileReview
              key={cwd || 'no-cwd'}
              onLeaveToChat={onClose}
              onOpenInEditor={file => {
                previewFile(absolutePath(file.path))
                show('editor')
              }}
            />
          </div>
        )}
        {visited.has('files') && (
          <div className={cn('absolute inset-0 overflow-hidden', tab !== 'files' && 'hidden')}>
            {/* Opening a file jumps to the editor — on a phone the panels can't
                sit side by side, so the navigation has to be explicit. */}
            <RightSidebarPane
              onActivateFile={path => {
                previewFile(path)
                show('editor')
              }}
              onActivateFolder={previewFile}
            />
          </div>
        )}
        {visited.has('editor') && (
          <div className={cn('absolute inset-0 flex min-h-0 flex-col', tab !== 'editor' && 'hidden')}>
            <PreviewRail />
          </div>
        )}
        {visited.has('terminal') && (
          // `invisible`, not `hidden`: xterm measures its grid from the live box,
          // and a display:none host makes it fit to zero and never recover.
          <div className={cn('absolute inset-0', tab !== 'terminal' && 'invisible')}>
            <TerminalArea />
          </div>
        )}
        {visited.has('status') && (
          <div className={cn('absolute inset-0 flex min-h-0 flex-col', tab !== 'status' && 'hidden')}>
            <MobileStatusList />
          </div>
        )}
      </main>

      <nav
        aria-label={copy.tabsAria}
        className="shrink-0 border-t border-(--ui-stroke-tertiary) bg-(--ui-bg-chrome)"
        style={{ paddingBottom: 'var(--safe-area-inset-bottom)' }}
      >
        <div className="flex items-stretch gap-0.5 px-1 py-0.5">
          {TABS.map(({ icon, id }) => (
            <WorkspaceTabButton
              active={tab === id}
              badge={badges[id]}
              icon={icon}
              key={id}
              label={labels[id]}
              onSelect={() => show(id)}
            />
          ))}
        </div>
      </nav>
    </div>
  )
}
