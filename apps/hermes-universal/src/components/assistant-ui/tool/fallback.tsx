'use client'

import { type ToolCallMessagePartProps, useAuiState } from '@assistant-ui/react'
import { useStore } from '@nanostores/react'
import {
  Children,
  createContext,
  type FC,
  Fragment,
  type PropsWithChildren,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'

import { useSessionView } from '@/app/chat/session-view'
import { AnsiText } from '@/components/assistant-ui/ansi-text'
import { useElapsedSeconds } from '@/components/chat/activity-timer'
import { ActivityTimerText } from '@/components/chat/activity-timer-text'
import { CompactMarkdown } from '@/components/chat/compact-markdown'
import { FileDiffPanel } from '@/components/chat/diff-lines'
import { DisclosureRow } from '@/components/chat/disclosure-row'
import { SCAFFOLD_LABEL_CLASS, ScaffoldRow } from '@/components/chat/scaffold-row'
import { ZoomableImage } from '@/components/chat/zoomable-image'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { CopyButton } from '@/components/ui/copy-button'
import { DisclosureCaret } from '@/components/ui/disclosure-caret'
import { FadeText } from '@/components/ui/fade-text'
import { FileTypeIcon } from '@/components/ui/file-type-icon'
import { GlyphSpinner } from '@/components/ui/glyph-spinner'
import { ToolIcon } from '@/components/ui/tool-icon'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { PrettyLink, LinkifiedText as SharedLinkifiedText, urlSlugTitleLabel } from '@/lib/external-link'
import { AlertCircle, CheckCircle2 } from '@/lib/icons'
import { normalize } from '@/lib/text'
import { useEnterAnimation } from '@/lib/use-enter-animation'
import { cn } from '@/lib/utils'
import { useDisplayPath } from '@/store/display-home'
import { $focusRevealedRuns, $focusView, isFocusRunRevealed, revealFocusRun } from '@/store/focus-view'
import { recordPreviewArtifact } from '@/store/preview-status'
import { sessionApprovalRequest } from '@/store/prompts'
import { $toolInlineDiffs } from '@/store/tool-diffs'
import { $toolRowDismissed, dismissToolRow } from '@/store/tool-dismiss'
import { $anyToolDisclosureOpen, $toolDisclosureOpen, $toolViewMode, setToolDisclosureOpen } from '@/store/tool-view'

import { PendingToolApproval } from './approval'
import {
  buildToolView,
  clampForDisplay,
  cleanVisibleText,
  countDiffLineStats,
  inlineDiffFromResult,
  isCardTool,
  isFileEditTool,
  isPreviewableTarget,
  isSilentTool,
  looksRedundant,
  type SearchResultRow,
  selectMessageRunning,
  stripInlineDiffChrome,
  toolCopyPayload,
  type ToolPart,
  toolPartDisclosureId,
  type ToolStatus,
  type ToolTitleAction
} from './fallback-model'
import { isToolCallPart, summarizeToolRun } from './run-summary'
import { ToolRunTicker } from './run-ticker'

// `true` when a ToolEntry is rendered inside an embedding wrapper that owns
// the per-row chrome (timer / preview). The flat ToolGroupSlot sets this
// false, so every row currently owns its own chrome; kept as a seam for any
// future embedding surface.
const ToolEmbedContext = createContext(false)

// Shared header chrome for tool rows. Both the single-tool DisclosureRow
// and the multi-tool group header pass through these constants so a
// "Patch" row and a "Tool actions · 2 steps" row are visually identical.
const TOOL_HEADER_TITLE_CLASS =
  'text-[length:var(--conversation-tool-font-size)] font-medium leading-(--conversation-line-height) text-(--ui-text-secondary)'

const TOOL_HEADER_DURATION_CLASS = 'shrink-0 text-[0.625rem] tabular-nums text-(--ui-text-tertiary)'

const TOOL_HEADER_SUBTITLE_CLASS =
  'text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ui-text-tertiary)'

const TOOL_HEADER_GLYPH_WRAP_CLASS = 'grid size-3.5 shrink-0 place-items-center self-center'

// Glass-style section label that sits above any pre/JSON/output block.
// Lowercase tracking + tiny size so it reads as a quiet field label rather
// than a chrome heading. Used for "stdout", "stderr", "Search results", etc.
const TOOL_SECTION_LABEL_CLASS = 'mb-1 text-[0.65rem] font-medium uppercase tracking-[0.08em] text-(--ui-text-tertiary)'

// Inset scroll surface for any detail body. The expanded tool row owns the
// border; the payload itself is just clipped raw text.
const TOOL_SECTION_SURFACE_CLASS =
  'max-h-20 max-w-full overflow-auto bg-transparent px-2 py-1.5 text-(--ui-text-secondary)'

const TOOL_EXPANDED_SHELL_CLASS = 'rounded-[0.3125rem] border border-(--ui-stroke-tertiary)'

const TOOL_SECTION_PRE_CLASS = cn(TOOL_SECTION_SURFACE_CLASS, 'font-mono text-[0.7rem] leading-relaxed')

// Raw args/result dump — reference material, so a notch smaller than a body.
const TOOL_PAYLOAD_PRE_CLASS = cn(TOOL_SECTION_SURFACE_CLASS, 'font-mono text-[0.65rem] leading-relaxed')

/**
 * Technical-mode raw payload, behind a chevron disclosure.
 *
 * Collapsed by default — in technical mode every tool row carries one, and
 * expanding them all buries the transcript. Uses `DisclosureCaret` rather than
 * a native `<details>`, whose marker is a browser-drawn triangle matching
 * nothing else here.
 *
 * The trace is built HERE rather than on the view, so a payload nobody opens is
 * never serialized: `buildToolView` runs on every stream delta of a running
 * message, and a JSON.stringify of a 100KB read_file result per row per tick is
 * the shape of cost the render budget exists to keep out of a turn.
 */
function ToolPayloadDisclosure({ args, result }: { args: unknown; result: unknown }) {
  const [open, setOpen] = useState(false)

  return (
    // `py-0.5` tops up the parent's `p-1.5` to an even block on both edges.
    <div className="max-w-full py-0.5">
      <button
        aria-expanded={open}
        className={cn(
          TOOL_SECTION_LABEL_CLASS,
          'mb-0 flex items-center gap-1 bg-transparent transition-colors hover:text-(--ui-text-secondary)'
        )}
        onClick={() => setOpen(value => !value)}
        type="button"
      >
        <DisclosureCaret className="text-(--ui-text-tertiary)" open={open} size="0.625rem" />
        Tool payload
      </button>
      {open && (
        <pre className={cn(TOOL_PAYLOAD_PRE_CLASS, 'mt-1 whitespace-pre-wrap wrap-anywhere')}>
          {technicalTrace(args, result)}
        </pre>
      )}
    </div>
  )
}

interface ToolStatusCopy {
  statusDone: string
  statusError: string
  statusRecovered: string
  statusRunning: string
}

function prettyTechnicalValue(value: unknown): string {
  if (typeof value === 'string') {
    const trimmed = value.trim()

    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      return value
    }

    try {
      const parsed = JSON.parse(value)

      return parsed && typeof parsed === 'object' ? JSON.stringify(parsed, null, 2) : value
    } catch {
      return value
    }
  }

  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function technicalTrace(args: unknown, result: unknown): string {
  const parts = [
    ['Arguments', args],
    ['Result', result]
  ]
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([label, value]) => `${label}:\n${prettyTechnicalValue(value)}`)

  return clampForDisplay(parts.join('\n\n'))
}

function statusGlyph(status: ToolStatus, copy: ToolStatusCopy): ReactNode {
  if (status === 'running') {
    return (
      <GlyphSpinner
        ariaLabel={copy.statusRunning}
        className="size-3.5 shrink-0 text-[0.95rem] text-(--ui-text-tertiary)"
        spinner="breathe"
      />
    )
  }

  if (status === 'error') {
    return <AlertCircle aria-label={copy.statusError} className="size-3.5 shrink-0 text-destructive" />
  }

  if (status === 'warning') {
    return <AlertCircle aria-label={copy.statusRecovered} className="size-3.5 shrink-0 text-(--ui-yellow)" />
  }

  return <CheckCircle2 aria-label={copy.statusDone} className="size-3.5 shrink-0 text-(--ui-green)/85" />
}

// Leading glyph for any tool-row header. Status (running/error/warning)
// takes precedence; otherwise falls back to the tool's codicon. Returns
// null when neither applies so callers can render unconditionally.
function ToolGlyph({
  copy,
  filePath,
  icon,
  status
}: {
  copy: ToolStatusCopy
  filePath?: string
  icon?: string
  status?: ToolStatus
}) {
  const node = status ? (
    statusGlyph(status, copy)
  ) : filePath ? (
    <FileTypeIcon className="text-(--ui-text-tertiary)" path={filePath} size="0.875rem" />
  ) : icon ? (
    <ToolIcon className="text-(--ui-text-tertiary)" name={icon} size="0.875rem" />
  ) : null

  return node ? <span className={TOOL_HEADER_GLYPH_WRAP_CLASS}>{node}</span> : null
}

// Which status (if any) should pre-empt the tool's icon in the leading
// slot. Success is silent — the row reads as "done" without a checkmark.
function leadingStatus(isPending: boolean, status: ToolStatus): ToolStatus | undefined {
  if (isPending) {
    return 'running'
  }

  return status === 'success' ? undefined : status
}

function SearchResultsList({ hits }: { hits: SearchResultRow[] }) {
  return (
    <ol className="m-0 grid list-none gap-2.5 p-0">
      {hits.map((hit, index) => {
        const key = `${hit.url || hit.title}-${index}`
        const trimmedTitle = hit.title.trim()

        return (
          <li className="grid min-w-0 gap-0.5" key={key}>
            {hit.url ? (
              <PrettyLink
                className={cn(TOOL_HEADER_TITLE_CLASS, 'block max-w-full')}
                fallbackLabel={trimmedTitle || urlSlugTitleLabel(hit.url)}
                href={hit.url}
                label={trimmedTitle || undefined}
              />
            ) : (
              <span className={TOOL_HEADER_TITLE_CLASS}>{trimmedTitle}</span>
            )}
            {hit.snippet && <p className={cn(TOOL_HEADER_SUBTITLE_CLASS, 'm-0 line-clamp-3')}>{hit.snippet}</p>}
          </li>
        )
      })}
    </ol>
  )
}

function LinkifiedText({ className, text }: { className?: string; text: string }) {
  return <SharedLinkifiedText className={className} pretty text={cleanVisibleText(text)} />
}

function ToolTitle({
  isPending,
  status,
  title,
  titleAction
}: {
  isPending: boolean
  status: ToolStatus
  title: string
  titleAction?: ToolTitleAction
}) {
  return (
    <FadeText
      className={cn(
        TOOL_HEADER_TITLE_CLASS,
        isPending && 'text-(--ui-text-tertiary)',
        status === 'error' && 'text-destructive',
        status === 'warning' && 'text-(--ui-yellow)'
      )}
    >
      {isPending && titleAction ? (
        <>
          {titleAction.prefix}
          <span className="shimmer">{titleAction.text}</span>
          {titleAction.suffix}
        </>
      ) : (
        title
      )}
    </FadeText>
  )
}

interface ToolEntryProps {
  part: ToolPart
}

function useDisclosureOpen(disclosureId: string, fallbackOpen = false): boolean {
  const persistedOpen = useStore($toolDisclosureOpen(disclosureId))

  return persistedOpen ?? fallbackOpen
}

/**
 * A row's disclosure id, scoped to the message it was rendered in.
 *
 * Shared with the run that wraps the row: a live run has to know when one of
 * its own rows has been opened, and both sides have to name it identically or
 * the run never hears about it.
 */
function toolEntryDisclosureId(messageId: string, part: ToolPart): string {
  return `tool-entry:${messageId}:${toolPartDisclosureId(part)}`
}

function ToolEntry({ part }: ToolEntryProps) {
  const { t } = useI18n()
  const copy = t.assistant.tool
  const statusCopy = t.statusStack
  const messageId = useAuiState(s => s.message.id)
  const messageRunning = useAuiState(selectMessageRunning)
  const embedded = useContext(ToolEmbedContext)
  const toolViewMode = useStore($toolViewMode)

  // `ToolFallback` rebuilds the `part` wrapper each render, defeating the memos
  // below and re-running buildToolView (full JSON.stringify of result) on every
  // stream delta — the freeze on big `/learn` runs. Re-derive a stable part from
  // the referentially-stable args/result so the memos hold across deltas.
  const { args, isError, result, toolCallId, toolName } = part

  const stablePart = useMemo<ToolPart>(
    () => ({ args, isError, result, toolCallId, toolName, type: 'tool-call' }),
    [args, isError, result, toolCallId, toolName]
  )

  const disclosureId = toolEntryDisclosureId(messageId, stablePart)
  const dismissed = useStore($toolRowDismissed(disclosureId))
  const isPending = messageRunning && result === undefined
  const liveDiffs = useStore($toolInlineDiffs)
  const sideDiff = toolCallId ? liveDiffs[toolCallId] || '' : ''
  const inlineDiff = stripInlineDiffChrome(sideDiff) || inlineDiffFromResult(result)
  const isFileEdit = isFileEditTool(toolName)
  // A Read/Edit/Write row's tooltip is the file's path ON THE GATEWAY — the row
  // itself shows only the basename, so this tooltip is the widest path string in
  // the transcript (MJXHRM-394). Relative tool args pass through untouched.
  const displayPath = useDisplayPath()
  const defaultOpen = Boolean(inlineDiff)
  const open = useDisclosureOpen(disclosureId, defaultOpen)
  const canDismiss = !isPending && !embedded
  // Only animate entries that mount while their message is actively
  // streaming — historical sessions mount with `messageRunning === false`,
  // so they paint statically without a settle cascade. The wrapping group
  // handles its own enter animation, so embedded children skip it.
  const enterRef = useEnterAnimation(messageRunning && !embedded, `tool-entry:${disclosureId}`)
  const elapsed = useElapsedSeconds(isPending, `tool:${disclosureId}`)

  // Stale parts (no result, but message stopped running) get a synthetic empty
  // result so buildToolView treats them as completed-no-output. Keyed on
  // stablePart so it recomputes only when this tool's data changes.
  const view = useMemo(() => {
    const p = !isPending && result === undefined ? { ...stablePart, result: {} } : stablePart

    return buildToolView(p, inlineDiff)
  }, [inlineDiff, isPending, result, stablePart])

  // Surface a previewable artifact (HTML file / localhost URL) as a compact link
  // in the composer status stack rather than a bulky inline card. Uses the same
  // detected target the old inline card did. Idempotent + dedup'd, so re-renders
  // don't churn.
  const previewTarget = view.previewTarget
  // The session whose transcript this row is IN, which is not necessarily the
  // primary one: a tool row inside a session tile must feed that tile's composer.
  // Reading the global `$sessionId`/`$currentCwd` here filed a tile's preview
  // under the main chat, where its own composer never showed it — and recorded
  // the wrong session's cwd beside it, so a relative target resolved elsewhere.
  const { $cwd: $sessionCwd, $runtimeId: $sessionRuntimeId } = useSessionView()

  useEffect(() => {
    if (isPending || !previewTarget || !isPreviewableTarget(previewTarget)) {
      return
    }

    // Read (don't subscribe) session/cwd: this only fires when a previewable
    // target appears, and subscribing re-rendered every tool row on any session
    // or cwd change.
    const sessionId = $sessionRuntimeId.get()

    if (sessionId) {
      recordPreviewArtifact(sessionId, previewTarget, $sessionCwd.get() || '')
    }
  }, [$sessionCwd, $sessionRuntimeId, isPending, previewTarget])

  const detailSections = useMemo(() => {
    if (!view.detail) {
      return { body: '', summary: '' }
    }

    if (view.status !== 'error') {
      return { body: view.detail, summary: '' }
    }

    const chunks = view.detail
      .split(/\n\s*\n+/)
      .map(chunk => chunk.trim())
      .filter(Boolean)

    const [summary = '', ...rest] = chunks
    const subtitleNorm = normalize(view.subtitle)
    const summaryDuplicatesSubtitle = summary && summary.toLowerCase() === subtitleNorm

    if (summaryDuplicatesSubtitle) {
      return { body: rest.join('\n\n').trim(), summary: '' }
    }

    return { body: rest.join('\n\n').trim(), summary }
  }, [view.detail, view.status, view.subtitle])

  const detailMatchesSubtitle = looksRedundant(view.subtitle, view.detail)

  const showDetail =
    !view.inlineDiff &&
    (Boolean(view.stdout || view.stderr) ||
      (view.status === 'error' && Boolean(detailSections.summary || detailSections.body)) ||
      (view.status !== 'error' &&
        Boolean(view.detail) &&
        !looksRedundant(view.title, view.detail) &&
        !detailMatchesSubtitle))

  const renderDetailAsCode =
    view.status !== 'error' &&
    (part.toolName === 'terminal' || part.toolName === 'execute_code' || part.toolName === 'read_file')

  const hasSearchHits = Boolean(view.searchHits?.length)
  const searchResultsLabel = part.toolName === 'web_search' ? 'Search results' : view.detailLabel

  const hasExpandableContent = Boolean(
    view.imageUrl ||
    view.inlineDiff ||
    showDetail ||
    hasSearchHits ||
    view.stdout ||
    view.stderr ||
    view.terminalCommand ||
    view.terminalExitCode !== undefined ||
    toolViewMode === 'technical'
  )

  // copyAction reads the uncapped view.detail; clampForDisplay below only bounds
  // what's painted, so the row's Copy button still yields the full output.
  const copyAction = useMemo(() => toolCopyPayload(stablePart, view), [stablePart, view])

  const diffStats = useMemo(
    () => (isFileEdit && view.inlineDiff ? countDiffLineStats(view.inlineDiff) : null),
    [isFileEdit, view.inlineDiff]
  )

  const showDiffStats = !isPending && Boolean(diffStats && (diffStats.added > 0 || diffStats.removed > 0))

  // The header trailing slot only carries the live duration timer while the
  // tool is running. The copy control used to live here too, but an
  // `opacity-0` (yet still clickable) button straddling the caret/duration made
  // the disclosure caret hard to hit. Copy now lives in the expanded body's
  // top-right, where it can't fight the caret for the right edge.
  const trailing =
    isPending && !embedded ? <ActivityTimerText className={TOOL_HEADER_DURATION_CLASS} seconds={elapsed} /> : undefined

  // Once a turn has settled, a hover/focus-revealed dismiss lets the user clear
  // a completed/failed row that would otherwise sit at the tail of the chat.
  // It goes in the in-flow `action` slot (not `trailing`) so it can't overlap
  // the disclosure caret's hit-target — see the comment above `trailing`.
  const dismissAction = canDismiss ? (
    <Tip label={statusCopy.dismiss}>
      <Button
        aria-label={statusCopy.dismiss}
        className={cn(
          'size-5 rounded-md text-(--ui-text-tertiary) transition-opacity hover:text-(--ui-text-primary) hover:opacity-100',
          open
            ? 'opacity-80'
            : 'opacity-0 group-hover/disclosure-row:opacity-80 coarse:opacity-80 group-focus-within/disclosure-row:opacity-80'
        )}
        onClick={event => {
          event.stopPropagation()
          dismissToolRow(disclosureId)
        }}
        size="icon-xs"
        type="button"
        variant="ghost"
      >
        <Codicon name="close" size="0.75rem" />
      </Button>
    </Tip>
  ) : undefined

  if (dismissed) {
    return null
  }

  // A completed file edit with no diff to review is a bare, unexpandable row.
  // This is almost always a `write_file` create after a reload: only `patch`
  // persists its diff in the tool result, so creates rehydrate diff-less and
  // read like dead duplicates of the real diff row. Hide them — but keep
  // in-flight writes (activity) and failures (errors) visible.
  if (isFileEdit && !isPending && view.status !== 'error' && !view.inlineDiff) {
    return null
  }

  return (
    <div
      className={cn(
        'group/tool-block min-w-0 max-w-full overflow-hidden text-[length:var(--conversation-tool-font-size)] text-(--ui-text-tertiary)',
        open && TOOL_EXPANDED_SHELL_CLASS
      )}
      data-file-edit={isFileEdit && open ? '' : undefined}
      data-slot="tool-block"
      data-tool-open={open ? '' : undefined}
      data-tool-row=""
      ref={enterRef}
    >
      <div className={cn(open && 'border-b border-(--ui-stroke-tertiary) px-2 py-1.5')}>
        <DisclosureRow
          action={dismissAction}
          onToggle={hasExpandableContent ? () => setToolDisclosureOpen(disclosureId, !open) : undefined}
          open={open}
          trailing={trailing}
        >
          <span
            className="flex min-w-0 items-center gap-1.5"
            title={isFileEdit && view.subtitle ? displayPath(view.subtitle) : undefined}
          >
            <ToolGlyph
              copy={copy}
              filePath={isFileEdit ? view.subtitle : undefined}
              icon={view.icon}
              status={leadingStatus(isPending, view.status)}
            />
            <ToolTitle isPending={isPending} status={view.status} title={view.title} titleAction={view.titleAction} />
            {!isPending && view.countLabel && <span className={TOOL_HEADER_DURATION_CLASS}>{view.countLabel}</span>}
            {showDiffStats && diffStats && (
              <span className="flex shrink-0 items-center gap-1 font-mono text-[0.625rem] tabular-nums">
                {diffStats.added > 0 && <span className="text-(--ui-green)">+{diffStats.added}</span>}
                {diffStats.removed > 0 && <span className="text-(--ui-red)">−{diffStats.removed}</span>}
              </span>
            )}
            {!isFileEdit && !isPending && view.durationLabel && (
              <span className={TOOL_HEADER_DURATION_CLASS}>{view.durationLabel}</span>
            )}
          </span>
        </DisclosureRow>
      </div>
      {isPending && <PendingToolApproval part={part} />}
      {open && (
        <div className="relative grid w-full min-w-0 max-w-full gap-1.5 overflow-hidden p-1.5">
          {copyAction.text && (
            <CopyButton
              appearance="inline"
              // eslint-disable-next-line better-tailwindcss/no-restricted-classes -- over a surface pinned left-to-right — see the [dir='rtl'] block in styles.css
              className="absolute right-4 top-1.5 z-10 h-5 gap-0 rounded-md px-1 opacity-5 transition-opacity group-hover/tool-block:opacity-100 coarse:opacity-100 hover:opacity-100 focus-visible:opacity-100"
              iconClassName="size-3"
              label={copyAction.label}
              showLabel={false}
              side="left"
              stopPropagation
              text={copyAction.text}
            />
          )}
          {part.toolName === 'terminal' && toolViewMode !== 'technical' && (
            <TerminalTranscript command={view.terminalCommand} exitCode={view.terminalExitCode} />
          )}
          {view.imageUrl && (
            <div className="max-w-72 overflow-hidden rounded-[0.25rem] border border-(--ui-stroke-tertiary)">
              <ZoomableImage alt={copy.outputAlt} className="h-auto w-full object-cover" src={view.imageUrl} />
            </div>
          )}
          {hasSearchHits && view.searchHits && (
            <div className="max-w-full text-xs leading-relaxed text-(--ui-text-secondary)">
              {view.searchQuery && (
                <p className="mb-1 flex min-w-0 gap-1.5 wrap-anywhere">
                  <span className="shrink-0 font-medium text-(--ui-text-tertiary)">Search</span>
                  <span>{view.searchQuery}</span>
                </p>
              )}
              {searchResultsLabel && <p className={TOOL_SECTION_LABEL_CLASS}>{searchResultsLabel}</p>}
              <SearchResultsList hits={view.searchHits} />
            </div>
          )}
          {view.inlineDiff && (
            <FileDiffPanel className="-mt-1.5" diff={view.inlineDiff} path={isFileEdit ? view.subtitle : undefined} />
          )}
          {showDetail &&
            toolViewMode !== 'technical' &&
            (view.status === 'error' ? (
              detailSections.summary || detailSections.body ? (
                <div className="max-w-full text-xs leading-relaxed text-destructive">
                  {detailSections.summary && (
                    <LinkifiedText className="block font-medium" text={detailSections.summary} />
                  )}
                  {detailSections.body && (
                    <pre
                      className={cn(
                        'max-h-56 overflow-auto whitespace-pre-wrap wrap-anywhere font-mono text-[0.7rem] leading-[1.55] text-destructive/90',
                        detailSections.summary && 'mt-1.5'
                      )}
                    >
                      {clampForDisplay(detailSections.body)}
                    </pre>
                  )}
                </div>
              ) : null
            ) : view.stdout || view.stderr ? (
              // Stdout + stderr split: render both as labeled blocks. stderr
              // is intentionally NOT painted destructive — many CLIs log
              // informational output there.
              <div className="max-w-full text-xs leading-relaxed text-(--ui-text-secondary)">
                {view.detailLabel && <p className={TOOL_SECTION_LABEL_CLASS}>{view.detailLabel}</p>}
                {view.stdout && (
                  <div className="space-y-0.5">
                    {view.stderr && <p className={TOOL_SECTION_LABEL_CLASS}>stdout</p>}
                    <pre className={cn(TOOL_SECTION_PRE_CLASS, 'whitespace-pre-wrap wrap-anywhere')}>
                      {view.rendersAnsi ? (
                        <AnsiText text={clampForDisplay(view.stdout)} />
                      ) : (
                        clampForDisplay(view.stdout)
                      )}
                    </pre>
                  </div>
                )}
                {view.stderr && (
                  <div className={cn('space-y-0.5', view.stdout && 'mt-1.5')}>
                    <p className={TOOL_SECTION_LABEL_CLASS}>stderr</p>
                    <pre
                      className={cn(
                        TOOL_SECTION_PRE_CLASS,
                        'whitespace-pre-wrap wrap-anywhere text-(--ui-text-tertiary)'
                      )}
                    >
                      {view.rendersAnsi ? (
                        <AnsiText text={clampForDisplay(view.stderr)} />
                      ) : (
                        clampForDisplay(view.stderr)
                      )}
                    </pre>
                  </div>
                )}
              </div>
            ) : (
              <div className="max-w-full text-xs leading-relaxed text-(--ui-text-secondary)">
                {view.detailLabel && <p className={TOOL_SECTION_LABEL_CLASS}>{view.detailLabel}</p>}
                {renderDetailAsCode ? (
                  <pre className={cn(TOOL_SECTION_PRE_CLASS, 'whitespace-pre-wrap wrap-anywhere')}>
                    {view.rendersAnsi ? <AnsiText text={clampForDisplay(view.detail)} /> : clampForDisplay(view.detail)}
                  </pre>
                ) : (
                  <CompactMarkdown
                    className={cn(TOOL_SECTION_SURFACE_CLASS, 'wrap-anywhere')}
                    text={clampForDisplay(view.detail)}
                  />
                )}
              </div>
            ))}
          {toolViewMode === 'technical' && <ToolPayloadDisclosure args={part.args} result={part.result} />}
        </div>
      )}
    </div>
  )
}

interface TerminalTranscriptProps {
  command?: string
  exitCode?: number
}

/**
 * What a command was and how it ended, as the one line a terminal reader looks
 * for first.
 *
 * A readout of a settled exec, NOT a second xterm: universal's terminal pane is
 * a live gateway PTY (`/api/shell-pty`) with its own theme and selection
 * behaviour, and a transcript of a finished tool call needs none of that.
 *
 * `exitCode` is deliberately conditional. The gateway reports one on every
 * terminal result it produces (`tools/terminal_tool.py` — 0, the real
 * returncode, 124 on timeout, 130 on a genuine interrupt, -1 on a backend
 * failure), but a turn cancelled before `tool.complete` fires never gets a
 * result at all: the row settles with a synthetic empty one. Rendering
 * "exit 0" there would report a success for a command whose fate is unknown,
 * so no code means no chip.
 */
function TerminalTranscript({ command, exitCode }: TerminalTranscriptProps) {
  if (!command && exitCode === undefined) {
    return null
  }

  return (
    <div className="flex min-w-0 items-center gap-2 rounded-[0.25rem] border border-(--ui-stroke-tertiary) bg-(--ui-bg-quinary) px-2 py-1.5 font-mono text-[0.7rem] leading-relaxed">
      {command && (
        <code className="min-w-0 flex-1 whitespace-pre-wrap wrap-anywhere text-(--ui-text-secondary)">
          <span aria-hidden className="select-none text-(--ui-accent-secondary)">
            ${' '}
          </span>
          {command}
        </code>
      )}
      {exitCode !== undefined && (
        <span
          className={cn(
            'shrink-0 rounded bg-(--ui-bg-tertiary) px-1 py-px text-[0.6rem] tabular-nums',
            exitCode === 0 ? 'text-(--ui-green)' : 'text-(--ui-yellow)'
          )}
        >
          exit {exitCode}
        </span>
      )}
    </div>
  )
}

// Tools that draw their own surface and must never be folded into a run's
// summary live in `@/lib/tool-render-class` (`isCardTool`) — the DOM render
// budget prices a turn by the same rule, so both sides have to agree on which
// rows collapse into a summary line and which mount their own markup.
export { isCardTool }

// A call still awaiting a result on one of these could be the one blocking on
// an approval. Universal shows the approval in the composer's ApprovalBar
// rather than inline, but the run still has to stay open so the command being
// approved is visible next to the question.
const APPROVAL_TOOLS = new Set(['terminal', 'execute_code'])

// Ranges of parts travel through selectors as ONE joined string (see
// ToolGroupSlot): assistant-ui compares selector results with `Object.is`, so a
// fresh array would re-render the group on every streaming delta. NUL is the
// separator because no tool name can contain one.
const TOOL_KEY_SEPARATOR = String.fromCharCode(0)

export type RunItem = { end: number; kind: 'run'; start: number } | { index: number; kind: 'card' }

/**
 * Split a range of parts into cards and the runs of activity between them.
 *
 * Order is preserved rather than sorted into "all the runs, then all the
 * cards": a turn that reads, edits, then reads again shows a summary, the
 * diff, then a second summary, in the sequence it happened. Indices are
 * relative to the range. An empty name is a part that isn't a tool call at
 * all, which passes through as its own card.
 */
export function splitRunItems(toolNames: readonly string[]): RunItem[] {
  const items: RunItem[] = []
  let run: null | Extract<RunItem, { kind: 'run' }> = null

  toolNames.forEach((name, index) => {
    if (!name || isCardTool(name)) {
      run = null
      items.push({ index, kind: 'card' })

      return
    }

    if (run) {
      run.end = index
    } else {
      run = { end: index, kind: 'run', start: index }
      items.push(run)
    }
  })

  return items
}

// The one grey line that stands in for a run of tool calls — "Explored 3
// files, ran 5 commands". Live, it narrates in the present tense above the
// ticker and offers no toggle, since there is nothing settled to unfold yet.
function ToolRunHeader({
  live,
  onToggle,
  open,
  summary
}: {
  live: boolean
  onToggle?: () => void
  open: boolean
  summary: string
}) {
  return (
    <div data-conversation-scaffold="" data-tool-summary="">
      <ScaffoldRow onToggle={onToggle} open={open}>
        <FadeText className={cn(SCAFFOLD_LABEL_CLASS, 'truncate')}>
          {live ? <span className="shimmer">{summary}</span> : summary}
        </FadeText>
      </ScaffoldRow>
    </div>
  )
}

interface ToolRunState {
  count: number
  /** Disclosure id of each row in the run, so the run can tell when one is open. */
  entryIds: readonly string[]
  key: string
  live: boolean
  /** A call still awaiting a result that could be the one blocking on approval. */
  pendingApprovalTool: boolean
  summary: string
}

// assistant-ui compares selector results with `Object.is` and calls the
// selector on every store update, so returning a fresh object here would
// re-render the group on every text delta in the turn. The run only changes
// when a call arrives or one finishes; cache on exactly that.
function useToolRun(startIndex: number, endIndex: number): ToolRunState {
  const cache = useRef<null | { signature: string; value: ToolRunState }>(null)

  return useAuiState(state => {
    const parts = state.message.parts
    const tools = parts.slice(Math.max(0, startIndex), endIndex + 1).filter(isToolCallPart)

    // Live means the turn is still working and nothing has come after this run
    // — not that some call is unresolved. Those differ in the gap between one
    // call finishing and the next arriving, which for sequential calls is most
    // of the run: it fell back to past tense there, unmounting the ticker and
    // dropping its reel to the top instead of scrolling.
    //
    // The tail bound is what keeps this honest — a turn that ends, or an agent
    // that moves on to later parts, leaves the run settled and collapsible.
    const live = selectMessageRunning(state) && endIndex >= parts.length - 1

    const signature = tools
      .map(tool => `${tool.toolCallId}:${tool.result === undefined ? 0 : 1}`)
      .concat(String(live))
      .join('|')

    if (cache.current?.signature !== signature) {
      cache.current = {
        signature,
        value: {
          count: tools.length,
          entryIds: tools.map(tool => toolEntryDisclosureId(state.message.id, tool)),
          key: tools[0]?.toolCallId ?? '',
          live,
          pendingApprovalTool: tools.some(tool => tool.result === undefined && APPROVAL_TOOLS.has(tool.toolName)),
          summary: summarizeToolRun(tools, live)
        }
      }
    }

    return cache.current.value
  })
}

/**
 * One run of consecutive activity calls, headed by the line that summarizes it.
 *
 * The run is identified by its FIRST tool call, never by its position: a live
 * stream and the same turn rehydrated from history agree on which calls belong
 * together, but not on the indices they land at, because rehydration folds a
 * turn into one bubble that the live view spreads over several. Keying off the
 * index is what made an earlier attempt at this reshuffle the moment a turn
 * settled. `tool-run-continuity.test.ts` locks that agreement down.
 *
 * Live, the run is a summary plus the one-line ticker. Settled, the summary is
 * the whole of it until the user opens it. `ToolEmbedContext` is false so each
 * row still owns its own chrome (timer / copy) when shown.
 */
const ToolRun: FC<PropsWithChildren<{ endIndex: number; startIndex: number }>> = ({
  children,
  endIndex,
  startIndex
}) => {
  const messageRunning = useAuiState(selectMessageRunning)
  const { count, entryIds, key, live, pendingApprovalTool, summary } = useToolRun(startIndex, endIndex)
  const sessionId = useStore(useSessionView().$runtimeId) ?? ''
  const approval = useStore(useMemo(() => sessionApprovalRequest(sessionId), [sessionId]))
  const disclosureId = `tool-run:${key}`
  const persistedOpen = useStore($toolDisclosureOpen(disclosureId))
  const rowOpen = useStore(useMemo(() => $anyToolDisclosureOpen(entryIds), [entryIds]))
  const enterRef = useEnterAnimation(messageRunning, `tool-run:${key}`)

  // A lone call is already its own one-line summary; heading it with a second
  // line would say the same thing twice.
  if (count < 2) {
    return <>{children}</>
  }

  // Two things a one-line window can't hold. An approval is a question the
  // user has to answer, and expanded output is one they went looking for —
  // both would tick straight past, or be sliced to a single line, as the run
  // keeps going. Either one hands the run back its full height until the run
  // settles and the row can be reached through the summary instead.
  const blocked = Boolean(approval) && pendingApprovalTool
  const unfurled = blocked || rowOpen
  const expanded = live ? unfurled : (persistedOpen ?? false)

  return (
    <div
      className="grid min-w-0 max-w-full gap-(--tool-row-gap) overflow-hidden"
      data-slot="tool-block"
      data-tool-group=""
      ref={enterRef}
    >
      <ToolRunHeader
        live={live}
        onToggle={live ? undefined : () => setToolDisclosureOpen(disclosureId, !expanded)}
        open={expanded}
        summary={summary}
      />
      {live && !unfurled && <ToolRunTicker>{children}</ToolRunTicker>}
      {expanded && <div className="grid min-w-0 max-w-full gap-(--tool-row-gap)">{children}</div>}
    </div>
  )
}

/**
 * A range of consecutive tool calls, split into the cards that must stay on
 * screen and the runs of activity between them.
 *
 * assistant-ui hands the whole adjacent range over as one group; what belongs
 * together is a narrower question than adjacency. A diff or a question for the
 * user is the point of the turn and renders in place, while the reads and
 * commands around it collapse into a line. Splitting here rather than asking
 * for different ranges keeps the decision next to the rendering that depends
 * on it.
 *
 * This replaced a bounded, auto-scrolling window over the whole range: it kept
 * a long run from shoving the reply off screen, but left the reader peering at
 * activity through a two-row porthole rather than reading one line that says
 * what happened.
 */
export const ToolGroupSlot: FC<PropsWithChildren<{ endIndex: number; startIndex: number }>> = ({
  children,
  endIndex,
  startIndex
}) => {
  // Joined rather than returned as an array: assistant-ui compares selector
  // results with `Object.is` and re-runs them on every store update, so a
  // fresh array would re-render the whole group on every text delta.
  const toolNameKey = useAuiState(state =>
    state.message.parts
      .slice(Math.max(0, startIndex), endIndex + 1)
      .map(part => (part.type === 'tool-call' ? part.toolName : ''))
      .join(TOOL_KEY_SEPARATOR)
  )

  const toolNames = useMemo(() => toolNameKey.split(TOOL_KEY_SEPARATOR), [toolNameKey])
  const items = useMemo(() => splitRunItems(toolNames), [toolNames])
  const rows = Children.toArray(children)

  // Which of those calls FAILED, as its own short string for the same reason
  // the names are joined into one: focus view refuses to hide an error row, and
  // a tool name alone cannot say whether the call went wrong.
  const toolFailedKey = useAuiState(state =>
    state.message.parts
      .slice(Math.max(0, startIndex), endIndex + 1)
      .map(part => (part.type === 'tool-call' && part.isError ? '1' : '0'))
      .join('')
  )

  const messageId = useAuiState(state => state.message.id)
  const focusView = useStore($focusView)
  const revealedRuns = useStore($focusRevealedRuns)

  // Focus view stands one dim line in for the group's activity, expandable back
  // into the real rows. Keyed by message + range, so revealing one run leaves
  // the rest of the transcript hidden.
  const runKey = `${messageId}:${startIndex}`

  if (focusView && !isFocusRunRevealed(revealedRuns, runKey)) {
    return (
      <ToolEmbedContext.Provider value={false}>
        <FocusHiddenRun
          failedKey={toolFailedKey}
          names={toolNames}
          onReveal={() => revealFocusRun(runKey)}
          rows={rows}
        />
      </ToolEmbedContext.Provider>
    )
  }

  return (
    <ToolEmbedContext.Provider value={false}>
      {items.map(item =>
        item.kind === 'card' ? (
          <Fragment key={`card:${item.index}`}>{rows[item.index]}</Fragment>
        ) : (
          <ToolRun endIndex={startIndex + item.end} key={`run:${item.start}`} startIndex={startIndex + item.start}>
            {rows.slice(item.start, item.end + 1)}
          </ToolRun>
        )
      )}
    </ToolEmbedContext.Provider>
  )
}

/**
 * A tool group under focus view: what was hidden, said once, in the group's own
 * place and one click from the rows themselves.
 *
 * Two kinds of row are never hidden, for the same reason the gateway exempts
 * them when it suppresses tool progress for a terminal
 * (`_tool_lifecycle_required_for_ui`): a `clarify` card is a turn waiting on an
 * answer, and a failed call is the one thing a reduced view must not swallow —
 * "reduce the output" is not "hide the errors".
 *
 * Rows that render nothing anyway (`todo`, `react_to_message`) are folded away
 * but NOT counted, so the number is what the reader would otherwise have seen.
 *
 * A command awaiting approval IS folded away, and safely: universal asks for
 * approval in the composer's ApprovalBar, which prints the command itself — so
 * unlike a terminal, nothing here can be approved unseen.
 */
const FocusHiddenRun: FC<{
  failedKey: string
  names: readonly string[]
  onReveal: () => void
  rows: readonly ReactNode[]
}> = ({ failedKey, names, onReveal, rows }) => {
  const { t } = useI18n()

  const { hidden, kept } = useMemo(() => {
    const shown: ReactNode[] = []
    let count = 0

    names.forEach((name, index) => {
      if (failedKey[index] === '1' || name === 'clarify') {
        shown.push(<Fragment key={`kept:${index}`}>{rows[index]}</Fragment>)

        return
      }

      if (!isSilentTool(name)) {
        count += 1
      }
    })

    return { hidden: count, kept: shown }
  }, [failedKey, names, rows])

  return (
    <>
      {kept}
      {hidden > 0 && (
        <div data-conversation-scaffold="" data-focus-hidden="">
          <ScaffoldRow onToggle={onReveal} open={false}>
            <FadeText className={cn(SCAFFOLD_LABEL_CLASS, 'truncate')}>
              {t.assistant.thread.focusHidden(hidden)}
            </FadeText>
          </ScaffoldRow>
        </div>
      )}
    </>
  )
}

/**
 * Per-tool fallback. Now strictly returns a single ToolEntry — the
 * grouping decision lives in ToolGroupSlot above, so this never swaps
 * its return type and the underlying ToolEntry stays mounted across
 * group-shape changes.
 */
export const ToolFallback = ({ toolCallId, toolName, args, isError, result }: ToolCallMessagePartProps) => {
  const part: ToolPart = { args, isError, result, toolCallId, toolName, type: 'tool-call' }

  return <ToolEntry part={part} />
}
