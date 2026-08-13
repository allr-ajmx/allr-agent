import type { SyntaxHighlighterProps } from '@assistant-ui/react-streamdown'
import DOMPurify from 'dompurify'
import { useEffect, useMemo, useState } from 'react'

import { SyntaxHighlighter } from '@/components/chat/shiki-highlighter'
import { CopyButton } from '@/components/ui/copy-button'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { artifactContentHash, artifactDownloadName, type ArtifactKind } from '@/lib/artifact-detect'
import { artifactFrameUrl, composeArtifactHtml } from '@/lib/artifact-frame'
import { ChevronLeft, ChevronRight, Download } from '@/lib/icons'
import { IS_MOBILE, IS_TAURI } from '@/lib/platform'
import { cn } from '@/lib/utils'
import {
  $artifactRegistry,
  $artifactVersionSelection,
  findArtifact,
  releaseStagedArtifact,
  selectArtifactVersion,
  stageArtifactDocument
} from '@/store/artifacts'
import { useStore } from '@/store/atom'
import { artifactIdFromTab, type PreviewTarget } from '@/store/preview'

const MIME_BY_KIND = { code: 'text/plain', html: 'text/html', svg: 'image/svg+xml' } as const

// Shiki has no `svg` grammar; code artifacts keep their detected fence language.
const SOURCE_LANGUAGE_BY_KIND: Record<ArtifactKind, string | undefined> = {
  code: undefined,
  html: 'html',
  svg: 'xml'
}

type ArtifactViewMode = 'rendered' | 'source'

// The highlighter takes its wrapper from streamdown's adapter; outside a
// markdown tree there is no adapter, so hand it the plain element it expects.
const SOURCE_COMPONENTS: SyntaxHighlighterProps['components'] = {
  Code: ({ node, ...props }) => {
    void node

    return <code {...props} />
  },
  Pre: ({ node, ...props }) => {
    void node

    return <pre {...props} />
  }
}

const HEADER_BUTTON_CLASS =
  'flex items-center gap-1 rounded px-1.5 py-0.5 text-(--ui-text-tertiary) transition-colors hover:bg-(--chrome-action-hover) hover:text-foreground disabled:pointer-events-none disabled:opacity-40'

/**
 * Everything the frame is allowed to do, and — more to the point — everything
 * it is not.
 *
 * `allow-scripts` WITHOUT `allow-same-origin` is the whole mechanism. Granted
 * together, the two let a frame reach into its own document and remove the
 * sandbox attribute, which is to say granting both is the same as granting
 * neither. Alone, `allow-scripts` runs the page's code in an opaque origin with
 * no access to anything it did not bring with it.
 *
 * Withheld deliberately, each for a thing a generated page should not be able
 * to do to the app around it: `allow-top-navigation` (navigate the app away),
 * `allow-popups` (open windows), `allow-modals` (block the UI on an alert),
 * `allow-forms` (submit anywhere), `allow-downloads`, `allow-pointer-lock`.
 */
const ARTIFACT_SANDBOX = 'allow-scripts'

/**
 * The live view of an artifact's HTML.
 *
 * The document is staged with the Rust side and loaded through
 * `hermes-artifact://`, NOT written into a `srcdoc`. A srcdoc frame is
 * same-origin with the app document and inherits the app's CSP — under which
 * the artifact's own inline scripts simply never run, and the only fix would be
 * to loosen the app's `script-src` so a stranger's code could execute inside
 * it. The custom scheme gives the page an origin and a policy of its own
 * instead (see src-tauri/src/artifact.rs), so nothing about the app's posture
 * has to change for the artifact to be a real page.
 *
 * Outside Tauri (the dev browser, tests) there is no scheme to serve it, so the
 * frame stands down rather than silently falling back to something weaker.
 */
function ArtifactHtmlFrame({ content, title }: { content: string; title: string }) {
  const { t } = useI18n()
  const html = useMemo(() => composeArtifactHtml(content), [content])
  const documentId = useMemo(() => artifactContentHash(html), [html])
  const [staged, setStaged] = useState(false)

  useEffect(() => {
    if (!IS_TAURI) {
      return
    }

    let live = true

    void stageArtifactDocument(documentId, html).then(ok => {
      if (live) {
        setStaged(ok)
      }
    })

    return () => {
      live = false
      setStaged(false)
      void releaseStagedArtifact(documentId)
    }
  }, [documentId, html])

  if (!IS_TAURI) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-xs text-muted-foreground">
        {t.artifactPreview.renderUnavailable}
      </div>
    )
  }

  if (!staged) {
    return null
  }

  return (
    <iframe
      className="block size-full border-0 bg-white"
      sandbox={ARTIFACT_SANDBOX}
      src={artifactFrameUrl(documentId)}
      // Deliberately raw white + forced light scheme: the frame hosts foreign
      // generated HTML that assumes a light canvas, so it renders
      // deterministically light in both app themes instead of inheriting theme
      // tokens it cannot see.
      style={{ colorScheme: 'light' }}
      title={title}
    />
  )
}

/**
 * Live view for renderable artifact content.
 *
 * HTML runs in the sandboxed frame above. SVG is DOMPurify-sanitized with the
 * same profile as the inline ```svg embed — an SVG is inlined into the app's
 * own document, so it gets scrubbed rather than isolated.
 */
function ArtifactLiveView({ content, kind, title }: { content: string; kind: ArtifactKind; title: string }) {
  const svgClean = useMemo(
    () => (kind === 'svg' ? DOMPurify.sanitize(content, { USE_PROFILES: { svg: true, svgFilters: true } }) : ''),
    [content, kind]
  )

  if (kind === 'svg') {
    return (
      <div className="grid h-full place-items-center overflow-auto bg-background p-4 [&_svg]:h-auto [&_svg]:max-h-full [&_svg]:w-auto [&_svg]:max-w-full">
        <div dangerouslySetInnerHTML={{ __html: svgClean }} />
      </div>
    )
  }

  return <ArtifactHtmlFrame content={content} title={title} />
}

function VersionStepper({
  current,
  onSelect,
  total
}: {
  current: number
  onSelect: (index: number) => void
  total: number
}) {
  const { t } = useI18n()
  const copy = t.artifactPreview

  if (total < 2) {
    return null
  }

  return (
    <>
      <Tip label={copy.olderVersion}>
        <button
          aria-label={copy.olderVersion}
          className={HEADER_BUTTON_CLASS}
          disabled={current === 0}
          onClick={() => onSelect(current - 1)}
          type="button"
        >
          <ChevronLeft className="size-3 rtl:-scale-x-100" />
        </button>
      </Tip>
      <span className="tabular-nums text-(--ui-text-tertiary)">{copy.versionOf(current + 1, total)}</span>
      <Tip label={copy.newerVersion}>
        <button
          aria-label={copy.newerVersion}
          className={HEADER_BUTTON_CLASS}
          disabled={current === total - 1}
          onClick={() => onSelect(current + 1)}
          type="button"
        >
          <ChevronRight className="size-3 rtl:-scale-x-100" />
        </button>
      </Tip>
      {current < total - 1 && (
        <button className={HEADER_BUTTON_CLASS} onClick={() => onSelect(total - 1)} type="button">
          {copy.latest}
        </button>
      )}
    </>
  )
}

function ModeButton({ active, children, onClick }: { active: boolean; children: string; onClick: () => void }) {
  return (
    <button
      className={cn(
        'rounded px-1.5 py-0.5 hover:bg-(--chrome-action-hover) hover:text-foreground',
        IS_MOBILE && 'min-h-9 px-2.5',
        active && 'bg-(--chrome-action-hover) text-foreground'
      )}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  )
}

/** Save a text artifact through the browser's own download path. */
function downloadTextFile(name: string, text: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }))
  const link = document.createElement('a')

  link.download = name
  link.href = url
  link.click()

  // Revoke on the next tick — revoking synchronously races the click on some
  // engines and downloads an empty file.
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

/**
 * An artifact tab in the right pane: the mode switcher up top (RENDERED /
 * SOURCE, plus the version stepper and content actions) over either the live
 * view or the highlighted source.
 *
 * The tab only carries the artifact id — content is read live from the
 * registry, so an open tab picks up new versions as the model iterates.
 */
export function ArtifactPreview({ target }: { target: PreviewTarget }) {
  const { t } = useI18n()
  const copy = t.artifactPreview
  const artifactId = artifactIdFromTab(target.path)
  const registry = useStore($artifactRegistry)
  const versionSelection = useStore($artifactVersionSelection)
  const [userMode, setUserMode] = useState<ArtifactViewMode | null>(null)

  // Reset the explicit mode when the pane is reused for another artifact.
  useEffect(() => setUserMode(null), [artifactId])

  const record = useMemo(() => findArtifact(registry, artifactId), [artifactId, registry])

  if (!record) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center text-xs text-muted-foreground">
        <span className="font-medium text-foreground/80">{copy.missingTitle}</span>
        <span>{copy.missingBody}</span>
      </div>
    )
  }

  const renderable = record.kind === 'html' || record.kind === 'svg'
  const modes: ArtifactViewMode[] = renderable ? ['rendered', 'source'] : ['source']
  const mode = userMode && modes.includes(userMode) ? userMode : modes[0]!
  const versionIndex = Math.min(versionSelection[artifactId] ?? record.versions.length - 1, record.versions.length - 1)
  const version = record.versions[versionIndex]!

  return (
    <div className="flex h-full flex-col overflow-hidden bg-(--ui-editor-surface-background)">
      <div
        className={cn(
          'flex shrink-0 items-center gap-1 border-b border-(--ui-stroke-tertiary) bg-(--ui-sidebar-surface-background) px-2 text-xs',
          IS_MOBILE ? 'h-11' : 'h-8'
        )}
      >
        <span className="min-w-0 flex-1 truncate text-(--ui-text-secondary)" title={record.title}>
          {record.title}
        </span>
        <div className="flex items-center gap-0.5 text-(--ui-text-tertiary)">
          {modes.length > 1 && (
            <>
              <ModeButton active={mode === 'rendered'} onClick={() => setUserMode('rendered')}>
                {copy.rendered}
              </ModeButton>
              <ModeButton active={mode === 'source'} onClick={() => setUserMode('source')}>
                {copy.source}
              </ModeButton>
            </>
          )}
          <VersionStepper
            current={versionIndex}
            onSelect={index => selectArtifactVersion(artifactId, index)}
            total={record.versions.length}
          />
          <CopyButton
            appearance="inline"
            className="h-5 px-1 opacity-70 hover:opacity-100"
            iconClassName="size-3"
            label={copy.copyContent}
            showLabel={false}
            text={version.content}
          />
          <Tip label={copy.download}>
            <button
              aria-label={copy.download}
              className={HEADER_BUTTON_CLASS}
              onClick={() =>
                downloadTextFile(
                  artifactDownloadName(record.kind, record.language, record.title),
                  version.content,
                  MIME_BY_KIND[record.kind]
                )
              }
              type="button"
            >
              <Download className="size-3" />
            </button>
          </Tip>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {mode === 'rendered' && renderable ? (
          <ArtifactLiveView content={version.content} kind={record.kind} title={record.title} />
        ) : (
          <SyntaxHighlighter
            code={version.content}
            components={SOURCE_COMPONENTS}
            language={SOURCE_LANGUAGE_BY_KIND[record.kind] ?? record.language}
          />
        )}
      </div>
    </div>
  )
}
