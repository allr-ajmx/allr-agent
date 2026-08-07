import {
  cursorCharLeft,
  cursorCharRight,
  cursorLineDown,
  cursorLineUp,
  defaultKeymap,
  history,
  historyKeymap,
  indentLess,
  indentMore,
  indentWithTab,
  redo,
  undo
} from '@codemirror/commands'
import { bracketMatching, indentOnInput, LanguageDescription } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { Compartment, EditorState } from '@codemirror/state'
import { drawSelection, EditorView, keymap, lineNumbers } from '@codemirror/view'
import { useEffect, useRef } from 'react'

import { IS_MOBILE } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { useTheme } from '@/themes/context'

import { githubEditorTheme } from './code-editor-theme'

// Ported from apps/desktop/src/components/chat/code-editor.tsx, slimmed for the
// right-pane spot editor: line numbers, history, selection, bracket matching, and
// per-file syntax highlighting. Mod-s / Mod-Enter save; Esc cancels; light/dark
// follows the app theme live. Dropped desktop's JSON-format + block-highlight +
// imperative apiRef (config-editor features not needed here). Owns its buffer;
// the parent remounts (via React `key`) to load a new file or discard edits.

interface CodeEditorProps {
  className?: string
  /** Read-only: block edits (e.g. while a save is in flight) without unmounting. */
  disabled?: boolean
  filePath: string
  /** Read once at mount. Remount (new `key`) to load a different file. */
  initialValue: string
  onCancel?: () => void
  onChange: (value: string) => void
  /** Handed the imperative API once the view exists (and `null` on teardown) —
   *  the mobile key row drives the editor through it, since a phone keyboard has
   *  no Tab, no brackets row and no arrow keys to bind to. */
  onReady?: (api: CodeEditorApi | null) => void
  onSave?: () => void
}

/** The narrow imperative surface an external key row needs. Deliberately not the
 *  raw EditorView: callers shouldn't have to speak CodeMirror to add a Tab key. */
export interface CodeEditorApi {
  focus: () => void
  /** Insert at the cursor, replacing any selection. */
  insert: (text: string) => void
  move: (direction: 'down' | 'left' | 'right' | 'up') => void
  redo: () => void
  /** Indent the current line(s) — Tab's meaning in an editor, not a literal tab. */
  indent: () => void
  outdent: () => void
  undo: () => void
}

function baseName(filePath: string): string {
  const cleaned = filePath.replace(/[\\/]+$/, '')

  return (
    cleaned
      .slice(cleaned.lastIndexOf('/') + 1)
      .split('\\')
      .pop() ?? cleaned
  )
}

const MONO_FONT = 'var(--font-mono)'
// A phone is a real editing target here, and 0.7rem of monospace on one is not
// readable at arm's length — even after the `html.is-mobile` rem bump. Give the
// code (and its rows) room; the desktop sizes are untouched.
const ROW_HEIGHT = IS_MOBILE ? '1.45rem' : '1.25rem'
const CODE_SIZE = IS_MOBILE ? '0.8rem' : '0.7rem'
const GUTTER_COLOR = 'color-mix(in oklab, var(--muted-foreground) 55%, transparent)'

const LAYOUT_THEME = EditorView.theme({
  '&': { WebkitFontSmoothing: 'antialiased', backgroundColor: 'transparent', height: '100%' },
  '.cm-content': {
    fontFamily: MONO_FONT,
    fontSize: CODE_SIZE,
    fontWeight: '400',
    lineHeight: ROW_HEIGHT,
    padding: '0',
    paddingBottom: '0',
    paddingTop: '0'
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    border: 'none',
    color: GUTTER_COLOR,
    fontFamily: MONO_FONT,
    fontSize: CODE_SIZE
  },
  '.cm-lineNumbers .cm-gutterElement': {
    boxSizing: 'border-box',
    fontVariantNumeric: 'tabular-nums',
    fontWeight: '400',
    lineHeight: ROW_HEIGHT,
    minWidth: '2.25rem',
    padding: '0 0.5rem 0 0',
    textAlign: 'right'
  },
  '.cm-line': {
    fontFamily: MONO_FONT,
    fontSize: CODE_SIZE,
    fontWeight: '400',
    lineHeight: ROW_HEIGHT,
    padding: '0 0.625rem'
  },
  '.cm-scroller': { fontFamily: MONO_FONT, fontSize: CODE_SIZE, lineHeight: ROW_HEIGHT, overflow: 'auto' }
})

/** Wrap the live view in the imperative surface exposed via `onReady`. Every
 *  entry point re-focuses first: a key-row tap moves focus to the button, and an
 *  unfocused editor would silently drop the command. */
function editorApi(view: EditorView): CodeEditorApi {
  const run = (command: (target: EditorView) => boolean) => () => {
    view.focus()
    command(view)
  }

  return {
    focus: () => view.focus(),
    indent: run(indentMore),
    insert: text => {
      view.focus()
      view.dispatch(view.state.replaceSelection(text))
    },
    move: direction => {
      view.focus()

      const command =
        direction === 'left'
          ? cursorCharLeft
          : direction === 'right'
            ? cursorCharRight
            : direction === 'up'
              ? cursorLineUp
              : cursorLineDown

      command(view)
    },
    outdent: run(indentLess),
    redo: run(redo),
    undo: run(undo)
  }
}

export function CodeEditor({
  className,
  disabled = false,
  filePath,
  initialValue,
  onCancel,
  onChange,
  onReady,
  onSave
}: CodeEditorProps) {
  const { resolvedMode } = useTheme()
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const languageConf = useRef(new Compartment())
  const themeConf = useRef(new Compartment())
  const editableConf = useRef(new Compartment())
  const onCancelRef = useRef(onCancel)
  const onChangeRef = useRef(onChange)
  const onReadyRef = useRef(onReady)
  const onSaveRef = useRef(onSave)
  onCancelRef.current = onCancel
  onChangeRef.current = onChange
  onReadyRef.current = onReady
  onSaveRef.current = onSave

  useEffect(() => {
    const host = hostRef.current

    if (!host) {
      return
    }

    const isDark = resolvedMode === 'dark'

    const save = () => {
      onSaveRef.current?.()

      return true
    }

    const state = EditorState.create({
      doc: initialValue,
      extensions: [
        lineNumbers(),
        history(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
          { key: 'Mod-s', preventDefault: true, run: save },
          { key: 'Mod-Enter', preventDefault: true, run: save },
          {
            key: 'Escape',
            run: () => {
              if (!onCancelRef.current) {
                return false
              }

              onCancelRef.current()

              return true
            }
          }
        ]),
        languageConf.current.of([]),
        themeConf.current.of(githubEditorTheme(isDark)),
        editableConf.current.of(EditorState.readOnly.of(disabled)),
        EditorView.updateListener.of(update => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString())
          }
        }),
        LAYOUT_THEME
      ]
    })

    const view = new EditorView({ parent: host, state })
    viewRef.current = view
    view.focus()
    onReadyRef.current?.(editorApi(view))

    return () => {
      onReadyRef.current?.(null)
      view.destroy()
      viewRef.current = null
    }
    // Created once per mount; the parent remounts (via `key`) to load/discard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Lazy-load syntax highlighting for the file's language.
  useEffect(() => {
    let cancelled = false
    const description = LanguageDescription.matchFilename(languages, baseName(filePath))

    if (!description) {
      viewRef.current?.dispatch({ effects: languageConf.current.reconfigure([]) })

      return
    }

    void description.load().then(support => {
      if (!cancelled && viewRef.current) {
        viewRef.current.dispatch({ effects: languageConf.current.reconfigure(support) })
      }
    })

    return () => {
      cancelled = true
    }
  }, [filePath])

  useEffect(() => {
    viewRef.current?.dispatch({ effects: themeConf.current.reconfigure(githubEditorTheme(resolvedMode === 'dark')) })
  }, [resolvedMode])

  useEffect(() => {
    viewRef.current?.dispatch({ effects: editableConf.current.reconfigure(EditorState.readOnly.of(disabled)) })
  }, [disabled])

  return <div className={cn('h-full min-h-0 overflow-hidden', className)} ref={hostRef} />
}
