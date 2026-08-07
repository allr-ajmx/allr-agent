import { useEffect, useMemo, useState } from 'react'

import { requestComposerInsert } from '@/app/chat/composer/focus'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { GenerateButton } from '@/components/ui/generate-button'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import type { HermesReviewFile } from '@/global'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import { copyFilePath } from '@/store/file-actions'
import { notifyError } from '@/store/notifications'
import {
  $reviewCommitMsgBusy,
  $reviewDiffLoading,
  $reviewFiles,
  $reviewIsRepo,
  $reviewLoading,
  $reviewRevertTarget,
  $reviewSelectedPath,
  $reviewShipBusy,
  $reviewShipInfo,
  cancelCommitMessage,
  cancelRevert,
  clearReviewSelection,
  commitChanges,
  confirmRevert,
  createOrOpenPr,
  generateCommitMessage,
  requestRevert,
  selectReviewFile,
  stageReviewFile,
  unstageReviewFile
} from '@/store/review'
import { $reviewViewed, isReviewFileViewed, pruneReviewViewed, setReviewFileViewed } from '@/store/review-viewed'

import { absolutePath } from './file-tree'
import { MobileReviewDiff } from './mobile-review-diff'
import { MobileReviewRow } from './mobile-review-row'

// Review, rebuilt for a phone.
//
// This is the surface that most justifies the phone at all: the job is to see
// what the agent changed, accept or reject it, and ship — none of which needs a
// keyboard. So it is a master/detail (list ⇄ full-screen diff) rather than the
// desktop's tree-over-diff panel, the row actions are swipes and a long-press
// sheet instead of hover buttons, and the whole thing ends in one ship sheet.
//
// It drives the SAME store as the desktop pane (stage/unstage/revert/commit/push/
// PR are `store/review.ts` verbatim); only the interaction model differs.
//
// Granularity stays at desktop parity — whole files, no hunk-level staging.

type Filter = 'all' | 'staged' | 'unstaged'

export function MobileReview({ onOpenInEditor, onLeaveToChat }: MobileReviewProps) {
  const { t } = useI18n()
  const c = t.statusStack.coding
  const m = t.mobileReview

  const files = useStore($reviewFiles)
  const loading = useStore($reviewLoading)
  const isRepo = useStore($reviewIsRepo)
  const selectedPath = useStore($reviewSelectedPath)
  const viewed = useStore($reviewViewed)
  const revertTarget = useStore($reviewRevertTarget)

  const [filter, setFilter] = useState<Filter>('all')
  const [menuFile, setMenuFile] = useState<HermesReviewFile | null>(null)
  const [shipOpen, setShipOpen] = useState(false)

  // Marks for files that left the changed set (committed, reverted) are dead
  // weight and would come back to life if the same path changes again.
  useEffect(() => pruneReviewViewed(files), [files])

  const shown = useMemo(
    () => files.filter(file => (filter === 'all' ? true : filter === 'staged' ? file.staged : !file.staged)),
    [files, filter]
  )

  const totals = useMemo(
    () =>
      files.reduce((acc, file) => ({ added: acc.added + file.added, removed: acc.removed + file.removed }), {
        added: 0,
        removed: 0
      }),
    [files]
  )

  const selected = files.find(file => file.path === selectedPath) ?? null

  const toggleStage = (file: HermesReviewFile) => {
    void (file.staged ? unstageReviewFile(file.path) : stageReviewFile(file.path)).catch(err =>
      notifyError(err, file.staged ? c.unstage : c.stage)
    )
  }

  // Handing the change back to the agent, which is the mobile-native repair path:
  // describing a fix beats typing one on a phone keyboard. The composer is on the
  // chat surface, so this drops the prompt in and takes the user there.
  const askHermes = (file: HermesReviewFile) => {
    requestComposerInsert(m.askHermesPrompt(file.path))
    onLeaveToChat()
  }

  // Revert is the one destructive action here and it cannot be undone, so it
  // confirms — as a sheet, since a phone dialog with a tiny "Discard" button is
  // exactly how people lose work.
  //
  // `$reviewRevertTarget` is `undefined` when closed and `{path: null}` for
  // revert-all, so the open test MUST be against `undefined`: testing `null`
  // leaves the sheet open from first render AND makes `cancelRevert()` a no-op,
  // which (Radix modal ⇒ `pointer-events: none` on <body>) locks the whole
  // Workspace behind it.
  const revertSheet = (
    <Sheet onOpenChange={open => !open && cancelRevert()} open={revertTarget !== undefined}>
      <SheetContent className="gap-2 p-4" showCloseButton={false} side="bottom">
        <SheetHeader className="p-0">
          <SheetTitle>{revertTarget?.path == null ? c.revertAll : c.revert}</SheetTitle>
        </SheetHeader>
        <p className="text-xs text-muted-foreground">
          {revertTarget?.path == null ? c.revertAllConfirm : c.revertConfirm}
        </p>
        <Button
          className="w-full"
          onClick={() => void confirmRevert().catch(err => notifyError(err, c.revert))}
          variant="destructive"
        >
          {c.revert}
        </Button>
        <Button className="w-full" onClick={cancelRevert} variant="ghost">
          {t.common.cancel}
        </Button>
      </SheetContent>
    </Sheet>
  )

  if (!isRepo) {
    return <EmptyState label={c.notRepo} />
  }

  // The sheet is a sibling of BOTH branches: revert is reachable from the diff
  // footer too, and rendering it only in the list branch made that path set the
  // store and show nothing.
  if (selected) {
    return (
      <>
        <MobileReviewDiff
          file={selected}
          files={files}
          onAskHermes={askHermes}
          onBack={clearReviewSelection}
          onOpenInEditor={onOpenInEditor}
          onRevert={file => requestRevert(file.path)}
          onToggleStage={toggleStage}
        />
        {revertSheet}
      </>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-(--ui-sidebar-surface-background)">
      <header className="shrink-0 border-b border-(--ui-stroke-tertiary) px-2 py-1.5">
        <div className="flex items-center justify-between gap-2 pb-1.5">
          <span className="text-xs text-muted-foreground">
            {files.length ? m.summary(files.length) : loading ? m.loading : c.noChanges}
          </span>
          {files.length > 0 && (
            <span className="font-code text-[0.7rem]">
              <span className="text-(--ui-green)">+{totals.added}</span>{' '}
              <span className="text-(--ui-red)">−{totals.removed}</span>
            </span>
          )}
        </div>

        <SegmentedControl
          className="w-full"
          onChange={setFilter}
          options={[
            { id: 'all', label: m.filterAll },
            { id: 'staged', label: c.staged },
            { id: 'unstaged', label: m.filterUnstaged }
          ]}
          value={filter}
        />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {shown.length === 0 ? (
          <EmptyState label={files.length ? m.noneInFilter : c.noChanges} />
        ) : (
          <div className="divide-y divide-(--ui-stroke-tertiary)/60">
            {shown.map(file => (
              <MobileReviewRow
                file={file}
                key={file.path}
                onLongPress={() => setMenuFile(file)}
                onOpen={() => void selectReviewFile(file)}
                onRevert={() => requestRevert(file.path)}
                onToggleStage={() => toggleStage(file)}
                selected={file.path === selectedPath}
                viewed={isReviewFileViewed(viewed, file)}
              />
            ))}
          </div>
        )}
      </div>

      {files.length > 0 && (
        // No bottom safe-area padding: this panel lives INSIDE the Workspace,
        // whose tab bar sits below it and already owns the home-indicator inset.
        // Adding it here counted it twice and left a band of dead chrome between
        // the Ship button and the bar.
        <div className="shrink-0 border-t border-(--ui-stroke-tertiary) bg-(--ui-bg-chrome) p-2">
          <Button className="w-full gap-2" onClick={() => setShipOpen(true)}>
            <Codicon name="git-commit" size="1rem" />
            {m.ship}
          </Button>
        </div>
      )}

      <RowActionSheet
        file={menuFile}
        onAskHermes={askHermes}
        onClose={() => setMenuFile(null)}
        onOpenInEditor={onOpenInEditor}
        viewed={menuFile ? isReviewFileViewed(viewed, menuFile) : false}
      />

      <ShipSheet onOpenChange={setShipOpen} open={shipOpen} />

      {revertSheet}
    </div>
  )
}

interface MobileReviewProps {
  /** Hand a file to the editor tab — the Workspace owns tab switching. */
  onOpenInEditor: (file: HermesReviewFile) => void
  /** Close the Workspace and land in the chat (used after prefilling the composer). */
  onLeaveToChat: () => void
}

function EmptyState({ label }: { label: string }) {
  return <div className="flex h-full items-center justify-center p-6 text-xs text-muted-foreground">{label}</div>
}

/** The long-press menu: every row action, spelled out. The swipes are the fast
 *  path; this is the discoverable one, and the only one that carries the actions
 *  a swipe can't (viewed, copy path, ask). */
function RowActionSheet({
  file,
  onAskHermes,
  onClose,
  onOpenInEditor,
  viewed
}: {
  file: HermesReviewFile | null
  onAskHermes: (file: HermesReviewFile) => void
  onClose: () => void
  onOpenInEditor: (file: HermesReviewFile) => void
  viewed: boolean
}) {
  const { t } = useI18n()
  const c = t.statusStack.coding
  const m = t.mobileReview

  if (!file) {
    return null
  }

  const run = (action: () => void) => () => {
    onClose()
    action()
  }

  return (
    <Sheet onOpenChange={open => !open && onClose()} open>
      <SheetContent className="gap-0 p-0 pb-[var(--safe-area-inset-bottom)]" showCloseButton={false} side="bottom">
        <SheetHeader className="border-b border-(--ui-stroke-tertiary) p-3">
          <SheetTitle className="truncate text-sm">{file.path}</SheetTitle>
        </SheetHeader>

        <div className="flex flex-col p-1">
          <SheetAction icon="diff" label={c.openChanges} onClick={run(() => void selectReviewFile(file))} />
          <SheetAction icon="go-to-file" label={c.openFile} onClick={run(() => onOpenInEditor(file))} />
          <SheetAction
            icon={file.staged ? 'remove' : 'add'}
            label={file.staged ? c.unstage : c.stage}
            onClick={run(
              () =>
                void (file.staged ? unstageReviewFile(file.path) : stageReviewFile(file.path)).catch(err =>
                  notifyError(err, file.staged ? c.unstage : c.stage)
                )
            )}
          />
          <SheetAction
            icon={viewed ? 'circle-outline' : 'check'}
            label={viewed ? m.markUnviewed : m.markViewed}
            onClick={run(() => setReviewFileViewed(file, !viewed))}
          />
          <SheetAction icon="comment-discussion" label={m.askHermes} onClick={run(() => onAskHermes(file))} />
          <SheetAction
            icon="copy"
            label={t.fileMenu.copyPath}
            onClick={run(() => void copyFilePath(absolutePath(file.path)))}
          />
          <SheetAction icon="discard" label={c.revert} onClick={run(() => requestRevert(file.path))} tone="danger" />
        </div>
      </SheetContent>
    </Sheet>
  )
}

function SheetAction({
  icon,
  label,
  onClick,
  tone
}: {
  icon: string
  label: string
  onClick: () => void
  tone?: 'danger'
}) {
  return (
    <button
      className={cn(
        'flex min-h-[44px] items-center gap-3 rounded-md px-3 text-sm',
        tone === 'danger' ? 'text-(--ui-red)' : 'text-foreground'
      )}
      onClick={onClick}
      type="button"
    >
      <Codicon className="shrink-0 text-(--ui-text-tertiary)" name={icon} size="1rem" />
      {label}
    </button>
  )
}

/** Commit → push → PR as one sheet with a single primary action, instead of the
 *  desktop bar's three peers. Same store calls; the branch/PR state decides which
 *  step is showing. */
function ShipSheet({ onOpenChange, open }: { onOpenChange: (open: boolean) => void; open: boolean }) {
  const { t } = useI18n()
  const c = t.statusStack.coding
  const m = t.mobileReview

  const files = useStore($reviewFiles)
  const ship = useStore($reviewShipInfo)
  const busy = useStore($reviewShipBusy)
  const generating = useStore($reviewCommitMsgBusy)
  const diffLoading = useStore($reviewDiffLoading)
  const [message, setMessage] = useState('')

  const hasFiles = files.length > 0
  const canCommit = hasFiles && message.trim().length > 0 && !busy

  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent className="gap-3 p-4 pb-[calc(1rem+var(--safe-area-inset-bottom))]" side="bottom">
        <SheetHeader className="p-0">
          <SheetTitle>{hasFiles ? m.shipTitle(files.length) : m.shipNothing}</SheetTitle>
        </SheetHeader>

        {hasFiles && (
          <>
            <Textarea
              className="min-h-20 text-sm"
              onChange={event => setMessage(event.target.value)}
              placeholder={c.commitPlaceholder}
              value={message}
            />

            <GenerateButton
              className="h-9 w-full"
              disabled={busy || diffLoading}
              generating={generating}
              generatingLabel={c.stopGenerating}
              label={c.generateCommitMessage}
              onCancel={cancelCommitMessage}
              onGenerate={() =>
                // Pass the current text so a re-press regenerates rather than
                // handing back the same sentence (desktop parity).
                void generateCommitMessage(message)
                  .then(generated => generated && setMessage(generated))
                  .catch(err => notifyError(err, c.generateCommitMessage))
              }
              variant="secondary"
            />

            <Button
              className="w-full"
              disabled={!canCommit}
              onClick={() =>
                void commitChanges(message, { push: true })
                  .then(() => setMessage(''))
                  .catch(err => notifyError(err, c.commitAndPush))
              }
            >
              {c.commitAndPush}
            </Button>

            <Button
              className="w-full"
              disabled={!canCommit}
              onClick={() =>
                void commitChanges(message, { push: false })
                  .then(() => setMessage(''))
                  .catch(err => notifyError(err, c.commit))
              }
              variant="secondary"
            >
              {c.commit}
            </Button>
          </>
        )}

        {/* The PR step only makes sense once there is nothing left to commit,
            which is exactly when it becomes the obvious next move. */}
        {!hasFiles && (
          <Button
            className="w-full"
            disabled={busy || !ship.ghReady}
            onClick={() => void createOrOpenPr().catch(err => notifyError(err, c.createPr))}
          >
            {ship.pr?.url ? c.openPr : c.createPr}
          </Button>
        )}
        {!hasFiles && !ship.ghReady && <p className="text-xs text-muted-foreground">{c.ghMissing}</p>}
      </SheetContent>
    </Sheet>
  )
}
