import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { Streamdown } from 'streamdown'

import { exceedsHighlightBudget } from '@/components/chat/shiki-highlighter'
import { CodeEditor, type CodeEditorApi } from '@/components/ui/code-editor'
import { Codicon } from '@/components/ui/codicon'
import { getFileDiff, getGitRoot, readFileDataUrl, readFileText, writeFileText } from '@/hermes'
import { useI18n } from '@/i18n'
import { IS_MOBILE } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import { useDisplayPath } from '@/store/display-home'
import { notifyError } from '@/store/notifications'
import { $previewReloadNonce, type PreviewTarget, requestPreviewReload } from '@/store/preview'
import { setPreviewDirty } from '@/store/preview-edit'
import { $previewModes, setPreviewCaps, setPreviewMode } from '@/store/preview-view'
import { $workspaceCwd, notifyWorkspaceChanged } from '@/store/workspace-events'
import { useTheme } from '@/themes/context'

import { MobileKeyRow } from './mobile-key-row'

const PreviewShikiBlock = lazy(() => import('@/app/right-pane/preview/preview-shiki-block'))

// Right-pane file viewer/editor. Adapted from desktop's chat/right-rail/
// preview-file.tsx: read text/image, switch source (Shiki) / rendered (markdown)
// / diff views, and spot-edit text with a stale-on-disk save guard. Desktop's
// Electron <webview> HTML-preview + virtualized source list + drag-to-composer
// are dropped (Electron-only / not needed).
//
// The view MODE lives in `store/preview-view`, not here: as a layout-tree tile
// the switch is rendered by the zone's tab strip (preview-strip-tools.tsx), and
// a strip glyph can't reach a component's `useState`.

const TEXT_PREVIEW_MAX_BYTES = 512 * 1024

const MARKDOWN_EXTS = new Set(['md', 'markdown', 'mdx'])

const EXT_LANG: Record<string, string> = {
  bash: 'bash',
  c: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  go: 'go',
  h: 'c',
  hpp: 'cpp',
  html: 'html',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsx: 'jsx',
  kt: 'kotlin',
  lua: 'lua',
  md: 'markdown',
  mjs: 'javascript',
  php: 'php',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  sh: 'bash',
  sql: 'sql',
  swift: 'swift',
  toml: 'toml',
  ts: 'typescript',
  tsx: 'tsx',
  txt: 'text',
  vue: 'vue',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml'
}

function extOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')

  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

function looksBinary(text: string): boolean {
  const sample = text.slice(0, 4096)

  if (sample.includes('\u0000')) {
    return true
  }

  let control = 0

  for (let i = 0; i < sample.length; i += 1) {
    const c = sample.charCodeAt(i)

    if (c < 9 || (c > 13 && c < 32)) {
      control += 1
    }
  }

  return sample.length > 0 && control / sample.length > 0.12
}

interface Loaded {
  binary: boolean
  dataUrl?: string
  image: boolean
  language: string
  text: string
  truncated: boolean
}

export function PreviewFile({ target, variant = 'rail' }: { target: PreviewTarget; variant?: 'rail' | 'tile' }) {
  const { t } = useI18n()
  const copy = t.preview
  const { resolvedMode } = useTheme()
  const reloadNonce = useStore($previewReloadNonce)
  const workspaceCwd = useStore($workspaceCwd)

  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [editorKey, setEditorKey] = useState(0)
  // Only used by the mobile key row; null whenever the editor isn't mounted.
  const [editorApi, setEditorApi] = useState<CodeEditorApi | null>(null)

  const baselineRef = useRef('')
  const draftRef = useRef('')

  const path = target.path
  const ext = extOf(path)
  // The header tooltip is the file's absolute path on the GATEWAY (MJXHRM-394).
  const displayPath = useDisplayPath()
  const isMarkdown = MARKDOWN_EXTS.has(ext)
  // Subscribed as a map, read by path: one subscription serves both hosts, and
  // the strip glyph and this body can never disagree about the current view.
  const mode = useStore($previewModes)[path] ?? 'source'

  // Load (or reload) the file.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setEditing(false)
    setConflict(false)

    void readFileText(path)
      .then(async res => {
        if (cancelled) {
          return
        }

        const image = Boolean(res.mimeType?.startsWith('image/'))
        const binary = image || res.binary === true || (res.byteSize === undefined && looksBinary(res.text))
        let dataUrl: string | undefined

        if (image) {
          dataUrl = await readFileDataUrl(path)
            .then(r => r.dataUrl)
            .catch(() => undefined)
        }

        if (cancelled) {
          return
        }

        setLoaded({
          binary,
          dataUrl,
          image,
          language: res.language || EXT_LANG[ext] || 'text',
          text: res.text ?? '',
          truncated: res.truncated === true || (res.byteSize ?? 0) > TEXT_PREVIEW_MAX_BYTES
        })
        // Publish what this file can be shown as BEFORE picking a mode, so the
        // strip's glyphs are already truthful by the time one lights up.
        setPreviewCaps(path, { rendered: isMarkdown && !binary, source: !image })
        setPreviewMode(path, isMarkdown && !binary ? 'rendered' : 'source')
      })
      .catch(err => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [path, ext, isMarkdown, reloadNonce])

  const canEdit = Boolean(loaded && !loaded.binary && !loaded.image && !loaded.truncated)

  const beginEdit = useCallback(() => {
    if (!loaded || !canEdit) {
      return
    }

    baselineRef.current = loaded.text
    draftRef.current = loaded.text
    setConflict(false)
    setEditing(true)
    setEditorKey(k => k + 1)
  }, [canEdit, loaded])

  const cancelEdit = useCallback(() => {
    setEditing(false)
    setConflict(false)
    setPreviewDirty(path, false)
  }, [path])

  const onEditorChange = useCallback(
    (value: string) => {
      draftRef.current = value
      setPreviewDirty(path, value !== baselineRef.current)
    },
    [path]
  )

  const saveEdit = useCallback(
    async (force = false) => {
      if (saving) {
        return
      }

      setSaving(true)

      try {
        if (!force) {
          // Stale-on-disk guard: re-read and compare to the baseline we opened.
          const fresh = await readFileText(path).catch(() => null)

          if (fresh && fresh.text !== baselineRef.current) {
            setConflict(true)
            setSaving(false)

            return
          }
        }

        await writeFileText(path, draftRef.current)
        baselineRef.current = draftRef.current
        setPreviewDirty(path, false)
        setConflict(false)
        setEditing(false)
        notifyWorkspaceChanged()
        requestPreviewReload()
      } catch (err) {
        notifyError(err, copy.saveFailed(err instanceof Error ? err.message : String(err)))
      } finally {
        setSaving(false)
      }
    },
    [copy, path, saving]
  )

  const shikiTheme = resolvedMode === 'dark' ? 'github-dark-default' : 'github-light-default'

  // A TILE's tab already names the file and its strip already carries the mode
  // switch, so the pane keeps only what is genuinely pane state: the edit
  // actions. The RAIL (the phone's Editor tab, the narrow AppShell drawer) has
  // no zone strip to contribute to, so it keeps the full row.
  const railChrome = variant === 'rail'

  const toolbar = (
    <div
      className={cn(
        'flex shrink-0 items-center gap-1 border-b border-(--ui-stroke-tertiary) bg-(--ui-sidebar-surface-background) px-2 text-xs',
        // Touch needs the row itself to be tappable-height; the mode buttons and
        // edit/save actions inside it inherit that room.
        IS_MOBILE ? 'h-11' : 'h-8'
      )}
    >
      {railChrome ? (
        <span className="min-w-0 flex-1 truncate text-(--ui-text-secondary)" title={displayPath(path)}>
          {target.name}
        </span>
      ) : (
        <span className="flex-1" />
      )}
      {!editing && loaded && !loaded.image && (
        <div className="flex items-center gap-0.5 text-(--ui-text-tertiary)">
          {railChrome && !loaded.binary && (
            <ModeButton active={mode === 'source'} onClick={() => setPreviewMode(path, 'source')}>
              {copy.source}
            </ModeButton>
          )}
          {railChrome && isMarkdown && !loaded.binary && (
            <ModeButton active={mode === 'rendered'} onClick={() => setPreviewMode(path, 'rendered')}>
              {copy.renderedPreview}
            </ModeButton>
          )}
          {railChrome && (
            <ModeButton active={mode === 'diff'} onClick={() => setPreviewMode(path, 'diff')}>
              {copy.diff}
            </ModeButton>
          )}
          {canEdit && (
            <button
              className={cn(
                'ms-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-(--chrome-action-hover) hover:text-foreground',
                IS_MOBILE && 'min-h-9 px-2.5'
              )}
              onClick={beginEdit}
              type="button"
            >
              <Codicon name="edit" size="0.8rem" /> {copy.edit}
            </button>
          )}
        </div>
      )}
      {editing && (
        <div className="flex items-center gap-1">
          <button
            className={cn(
              'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-primary hover:bg-(--chrome-action-hover)',
              IS_MOBILE && 'min-h-9 px-2.5'
            )}
            disabled={saving}
            onClick={() => void saveEdit()}
            type="button"
          >
            <Codicon name="save" size="0.8rem" /> {copy.editing}
          </button>
          <button
            className={cn(
              'rounded px-1.5 py-0.5 text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground',
              IS_MOBILE && 'min-h-9 px-2.5'
            )}
            onClick={cancelEdit}
            type="button"
          >
            <Codicon name="close" size="0.8rem" />
          </button>
        </div>
      )}
    </div>
  )

  return (
    <div className="flex h-full min-h-0 flex-col bg-(--ui-editor-surface-background)">
      {toolbar}

      {conflict && (
        <div className="flex items-center justify-between gap-2 border-b border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[0.7rem] text-amber-700 dark:text-amber-300">
          <span className="min-w-0 truncate">{copy.diskChangedBody}</span>
          <span className="flex shrink-0 gap-1">
            <button
              className="rounded px-1.5 py-0.5 font-medium hover:bg-amber-500/20"
              onClick={() => void saveEdit(true)}
              type="button"
            >
              {copy.overwrite}
            </button>
            <button
              className="rounded px-1.5 py-0.5 hover:bg-amber-500/20"
              onClick={() => {
                cancelEdit()
                requestPreviewReload()
              }}
              type="button"
            >
              {copy.discardReload}
            </button>
          </span>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden">
        {loading ? (
          <Centered>{copy.loading}</Centered>
        ) : error ? (
          <Centered>{copy.unavailable}</Centered>
        ) : !loaded ? (
          <Centered>{copy.unavailable}</Centered>
        ) : editing ? (
          <CodeEditor
            className="p-2"
            disabled={saving}
            filePath={path}
            initialValue={baselineRef.current}
            key={editorKey}
            onCancel={cancelEdit}
            onChange={onEditorChange}
            onReady={setEditorApi}
            onSave={() => void saveEdit()}
          />
        ) : loaded.image ? (
          <div className="flex h-full items-center justify-center overflow-auto p-4">
            {loaded.dataUrl ? (
              <img alt={target.name} className="max-h-full max-w-full object-contain" src={loaded.dataUrl} />
            ) : (
              <Centered>{copy.unavailable}</Centered>
            )}
          </div>
        ) : loaded.binary ? (
          <Centered>{copy.binaryBody(target.name)}</Centered>
        ) : mode === 'rendered' ? (
          <div className="h-full overflow-auto px-4 py-3 text-sm">
            <Streamdown>{loaded.text}</Streamdown>
          </div>
        ) : mode === 'diff' ? (
          <DiffView cwd={workspaceCwd} path={path} />
        ) : (
          <div
            className={cn(
              'h-full overflow-auto [&_pre]:!bg-transparent [&_pre]:!p-2',
              // Read mode is where most phone time is spent — 0.7rem of mono is
              // not a reading size on a handset.
              IS_MOBILE ? 'text-[0.8rem]' : 'text-[0.7rem]'
            )}
          >
            {exceedsHighlightBudget(loaded.text) ? (
              // Plain text past the budget. Shiki tokenises the whole file in one
              // synchronous pass, so a big file froze the entire UI — not the
              // pane, the app — for as long as that took, and this view happily
              // loaded half a megabyte. Every other code surface in the app
              // (tool cards, diffs) already asks this question; the file viewer
              // was the one that didn't, which is why it was the one that hung.
              <pre className="p-2 font-mono whitespace-pre">{loaded.text}</pre>
            ) : (
              // Lazy for the same reason the transcript's fence is: this was
              // the third static path into `react-shiki`, and one static
              // importer anywhere is enough to keep the engine in the entry
              // chunk (MJXHRM-380). The plain <pre> above is the fallback, so
              // the file is readable while the engine loads.
              <Suspense fallback={<pre className="p-2 font-mono whitespace-pre">{loaded.text}</pre>}>
                <PreviewShikiBlock language={loaded.language} theme={shikiTheme}>
                  {loaded.text}
                </PreviewShikiBlock>
              </Suspense>
            )}
          </div>
        )}
      </div>

      {/* The accessory keys live outside the scroll area so they stay pinned
          between the editor and the system keyboard. */}
      {editing && IS_MOBILE && <MobileKeyRow api={editorApi} onSave={() => void saveEdit()} />}
    </div>
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

function Centered({ children }: { children: string }) {
  return (
    <div className="flex h-full items-center justify-center px-6 text-center text-xs text-muted-foreground">
      {children}
    </div>
  )
}

function DiffView({ cwd, path }: { cwd: string; path: string }) {
  const { t } = useI18n()
  const [diff, setDiff] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void getGitRoot(path)
      .then(async ({ root }) => {
        if (!root) {
          return ''
        }

        const res = await getFileDiff(root, path).catch(() => ({ diff: '' }))

        return res.diff
      })
      .then(d => {
        if (!cancelled) {
          setDiff(d)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDiff('')
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [cwd, path])

  if (loading) {
    return <Centered>{t.preview.loading}</Centered>
  }

  if (!diff) {
    return <Centered>{t.rightSidebar.noDiffs}</Centered>
  }

  return (
    <pre className="h-full overflow-auto p-2 font-mono text-[0.7rem] leading-[1.5]">
      {diff.split('\n').map((line, i) => (
        <div
          className={cn(
            'whitespace-pre-wrap',
            line.startsWith('+') && !line.startsWith('+++') && 'bg-(--ui-green)/10 text-(--ui-green)',
            line.startsWith('-') && !line.startsWith('---') && 'bg-(--ui-red)/10 text-(--ui-red)',
            line.startsWith('@@') && 'text-(--ui-text-tertiary)'
          )}
          key={i}
        >
          {line || ' '}
        </div>
      ))}
    </pre>
  )
}
