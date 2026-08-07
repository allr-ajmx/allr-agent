import { FileDiffPanel } from '@/components/chat/diff-lines'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { DiffCount } from '@/components/ui/diff-count'
import type { HermesReviewFile } from '@/global'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import {
  $reviewDiff,
  $reviewDiffLoading,
  $reviewDiffWrap,
  selectReviewFile,
  toggleReviewDiffWrap
} from '@/store/review'

// The full-screen diff. On a phone the list and the diff can't share a viewport,
// so this is a detail view over the list rather than the desktop's stacked panel.
//
// Deliberately UNIFIED: split needs roughly 700px before the two columns stop
// fighting, and below that it degrades into two unreadable gutters. The shared
// FileDiffPanel is reused as-is (virtualized + Shiki), so a 3000-line diff scrolls
// on a mid-range phone the same way it does in a tool card.
//
// The footer is the point of the view: everything you would do after reading a
// diff is one thumb-reachable tap, including handing it back to the agent, which
// on a phone beats typing the fix by a mile.

interface MobileReviewDiffProps {
  file: HermesReviewFile
  files: HermesReviewFile[]
  onAskHermes: (file: HermesReviewFile) => void
  onBack: () => void
  onOpenInEditor: (file: HermesReviewFile) => void
  onRevert: (file: HermesReviewFile) => void
  onToggleStage: (file: HermesReviewFile) => void
}

export function MobileReviewDiff({
  file,
  files,
  onAskHermes,
  onBack,
  onOpenInEditor,
  onRevert,
  onToggleStage
}: MobileReviewDiffProps) {
  const { t } = useI18n()
  const c = t.statusStack.coding
  const m = t.mobileReview
  const diff = useStore($reviewDiff)
  const loading = useStore($reviewDiffLoading)
  const wrap = useStore($reviewDiffWrap)

  const index = files.findIndex(entry => entry.path === file.path)
  const previous = index > 0 ? files[index - 1] : null
  const next = index >= 0 && index < files.length - 1 ? files[index + 1] : null
  const name = file.path.slice(file.path.lastIndexOf('/') + 1)

  return (
    <div className="flex h-full min-h-0 flex-col bg-(--ui-sidebar-surface-background)">
      <header className="shrink-0 border-b border-(--ui-stroke-tertiary)">
        <div className="flex min-h-[44px] items-center gap-1 px-1">
          <Button aria-label={m.backToFiles} className="size-9 shrink-0" onClick={onBack} size="icon" variant="ghost">
            <Codicon name="chevron-left" size="1.1rem" />
          </Button>

          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm text-foreground">{name}</span>
            <span className="truncate text-[0.7rem] text-(--ui-text-tertiary)">{file.path}</span>
          </div>

          <DiffCount added={file.added} className="shrink-0 pr-1 text-[0.7rem]" removed={file.removed} />
        </div>

        {/* Position + neighbours. Reviewing twenty files on a phone means never
            bouncing back to the list, so the traversal lives here. */}
        <div className="flex items-center justify-between border-t border-(--ui-stroke-tertiary)/60 px-1 py-0.5">
          <Button
            aria-label={m.previousFile}
            className="h-9 gap-1 px-2 text-xs"
            disabled={!previous}
            onClick={() => previous && void selectReviewFile(previous)}
            size="sm"
            variant="ghost"
          >
            <Codicon name="chevron-left" size="0.9rem" />
            {m.previous}
          </Button>

          <span className="text-[0.7rem] text-(--ui-text-tertiary)">
            {index >= 0 ? m.fileOf(index + 1, files.length) : ''}
          </span>

          <Button
            aria-label={m.nextFile}
            className="h-9 gap-1 px-2 text-xs"
            disabled={!next}
            onClick={() => next && void selectReviewFile(next)}
            size="sm"
            variant="ghost"
          >
            {m.next}
            <Codicon name="chevron-right" size="0.9rem" />
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-hidden">
        {loading && !diff ? (
          <div className="p-4 text-xs text-muted-foreground">{m.loadingDiff}</div>
        ) : diff ? (
          /* `max-h-none` and the margin resets are not decoration: FileDiffPanel's
             base box is a tool CARD (`max-h-[12rem]` plus a negative bleed), and a
             max-height beats `h-full`. Without this the diff sat in a 12rem strip
             with the rest of the screen empty below it. Same cancellation the
             desktop review pane does. */
          <FileDiffPanel
            className="mx-0 mb-0 h-full max-h-none"
            diff={diff}
            path={file.path}
            showLineNumbers
            virtualized
            wrap={wrap}
          />
        ) : (
          <div className="p-4 text-xs text-muted-foreground">{c.noDiff}</div>
        )}
      </div>

      {/* The Workspace's tab bar sits below this and owns the home-indicator
          inset; padding for it here would count it twice. */}
      <footer className="shrink-0 border-t border-(--ui-stroke-tertiary) bg-(--ui-bg-chrome)">
        <div className="grid grid-cols-5 gap-0.5 p-1">
          <FooterAction
            icon={file.staged ? 'remove' : 'add'}
            label={file.staged ? c.unstage : c.stage}
            onClick={() => onToggleStage(file)}
          />
          <FooterAction icon="discard" label={c.revert} onClick={() => onRevert(file)} tone="danger" />
          <FooterAction icon="go-to-file" label={c.openFile} onClick={() => onOpenInEditor(file)} />
          <FooterAction icon="comment-discussion" label={m.askHermes} onClick={() => onAskHermes(file)} />
          {/* Wrap belongs beside the actions rather than in the header: it is
              something you reach for mid-read, having just hit a line that runs
              off the screen, and the header is at the other end of the phone
              from your thumb. */}
          <FooterAction
            active={wrap}
            icon="word-wrap"
            label={wrap ? m.unwrap : m.wrap}
            onClick={toggleReviewDiffWrap}
          />
        </div>
      </footer>
    </div>
  )
}

function FooterAction({
  active,
  icon,
  label,
  onClick,
  tone
}: {
  /** A toggle that is currently ON — reads as pressed rather than as one of the
   *  one-shot actions beside it. */
  active?: boolean
  icon: string
  label: string
  onClick: () => void
  tone?: 'danger'
}) {
  return (
    <button
      aria-pressed={active}
      className={cn(
        'flex min-h-[44px] flex-col items-center justify-center gap-0.5 rounded-md px-1 py-1 text-[0.65rem]',
        tone === 'danger' ? 'text-(--ui-red)' : 'text-muted-foreground',
        active && 'bg-(--ui-control-active-background) text-foreground'
      )}
      onClick={onClick}
      type="button"
    >
      <Codicon name={icon} size="1.05rem" />
      <span className="max-w-full truncate">{label}</span>
    </button>
  )
}
