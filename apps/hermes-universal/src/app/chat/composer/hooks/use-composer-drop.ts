import { type DragEvent as ReactDragEvent, useRef, useState } from 'react'

import { triggerHaptic } from '@/lib/haptics'
import { IS_MOBILE } from '@/lib/platform'

import { ALLR_PATHS_MIME, extractDroppedFiles, partitionDroppedFiles } from '../../hooks/use-composer-actions'
import { dragHasAttachments, droppedFileInlineRefs, type InlineRefInput } from '../inline-refs'
import type { ChatBarProps } from '../types'

interface UseComposerDropArgs {
  cwd: ChatBarProps['cwd']
  insertInlineRefs: (refs: InlineRefInput[]) => boolean
  onAttachDroppedItems: ChatBarProps['onAttachDroppedItems']
  requestMainFocus: () => void
}

/**
 * Drag-and-drop attachment engine. Splits drops by origin: in-app drags
 * (project tree / gutter) stay inline `@file:`/`@line:` refs the gateway
 * resolves directly; OS/Finder drops (absolute local paths a remote gateway
 * can't read, image bytes vision needs) route through the upload pipeline.
 * Off the keystroke path; consumes `insertInlineRefs` + the attach handler.
 */
export function useComposerDrop({
  cwd,
  insertInlineRefs,
  onAttachDroppedItems,
  requestMainFocus
}: UseComposerDropArgs) {
  const [dragActive, setDragActive] = useState(false)
  const dragDepthRef = useRef(0)

  // Touch has no file drag-and-drop — the composer's HTML5 DnD is a mouse-only
  // affordance. On mobile the drop overlay (COMPOSER_DROP_ACTIVE_CLASS) must
  // never light and the enter/leave depth machine must stay inert, so return a
  // same-shaped set of no-op handlers with dragActive permanently false. Hooks
  // above stay unconditional (IS_MOBILE is a module constant), so this early
  // return keeps the hook order stable.
  if (IS_MOBILE) {
    const noop = () => {}

    // Inert, but not silent on a FILE drag. "No file DnD" is a statement about
    // what these webviews offer the user, not a guarantee the engine will never
    // deliver a drop — and an unprevented file drop navigates the document to a
    // `file://` URL, which on a phone means the whole app disappears with no back
    // button. Cancelling costs nothing on a platform where the event should not
    // arrive in the first place. The INPUT handlers stay true no-ops: dragging
    // text inside a contenteditable is a real touch gesture, and cancelling it
    // would break moving text by long-press.
    const cancelFileDrag = (event: ReactDragEvent<HTMLFormElement>) => {
      if (dragHasAttachments(event.dataTransfer, ALLR_PATHS_MIME)) {
        event.preventDefault()
      }
    }

    return {
      dragActive: false,
      handleDragEnter: cancelFileDrag,
      handleDragLeave: noop,
      handleDragOver: cancelFileDrag,
      handleDrop: cancelFileDrag,
      handleInputDragOver: noop,
      handleInputDrop: noop
    }
  }

  const resetDragState = () => {
    dragDepthRef.current = 0
    setDragActive(false)
  }

  // `preventDefault()` comes BEFORE any question about what we can do with the
  // drop, and that ordering is load-bearing.
  //
  // A `dragover` that is not prevented tells the webview we do not want the drag,
  // so the webview performs ITS default — for a file, navigating the document to
  // the `file://` URL, which reloads the whole SPA out from under the user and
  // takes the unsent draft with it. It never showed up on the Tauri desktop shell
  // because `dragDropEnabled` makes Tauri swallow HTML5 drag-and-drop at the
  // window level and deliver paths through `onDragDropEvent` instead
  // (`app/chat/use-file-drop.ts`). Everywhere Tauri is NOT in the way — a plain
  // browser on `vite dev`, the mobile webviews — the default is live, and it used
  // to be reachable simply because `onAttachDroppedItems` was optional and no
  // caller passed it (MJXHRM-A2).
  //
  // Refusing a drop is a legitimate outcome; navigating away is never one. So the
  // handler-absent case still cancels the browser's default and then does
  // nothing, rather than declining to speak at all.
  const handleDragEnter = (event: ReactDragEvent<HTMLFormElement>) => {
    if (!dragHasAttachments(event.dataTransfer, ALLR_PATHS_MIME)) {
      return
    }

    event.preventDefault()

    if (!onAttachDroppedItems) {
      return
    }

    dragDepthRef.current += 1

    if (!dragActive) {
      setDragActive(true)
    }
  }

  const handleDragOver = (event: ReactDragEvent<HTMLFormElement>) => {
    if (!dragHasAttachments(event.dataTransfer, ALLR_PATHS_MIME)) {
      return
    }

    event.preventDefault()

    // `dropEffect` is only meaningful once something will actually consume the
    // drop; a cancelled-but-unhandled drag keeps the browser's own cursor.
    if (onAttachDroppedItems) {
      event.dataTransfer.dropEffect = 'copy'
    }
  }

  const handleDragLeave = (event: ReactDragEvent<HTMLFormElement>) => {
    if (!onAttachDroppedItems) {
      return
    }

    event.preventDefault()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)

    if (dragDepthRef.current === 0) {
      setDragActive(false)
    }
  }

  const handleDrop = (event: ReactDragEvent<HTMLFormElement>) => {
    if (!dragHasAttachments(event.dataTransfer, ALLR_PATHS_MIME)) {
      return
    }

    event.preventDefault()
    resetDragState()

    if (!onAttachDroppedItems) {
      return
    }

    const candidates = extractDroppedFiles(event.dataTransfer)

    if (candidates.length === 0) {
      return
    }

    // In-app drags (project tree / gutter) are workspace-relative paths the
    // gateway resolves directly, so they stay inline @file:/@line: refs. OS
    // drops are absolute local paths a remote gateway can't read (and images
    // need byte upload for vision), so route them through the upload pipeline.
    const { inAppRefs, osDrops } = partitionDroppedFiles(candidates)
    const refs = droppedFileInlineRefs(inAppRefs, cwd)

    if (refs.length && insertInlineRefs(refs)) {
      triggerHaptic('selection')
    }

    if (osDrops.length) {
      void Promise.resolve(onAttachDroppedItems(osDrops)).then(attached => {
        if (attached) {
          triggerHaptic('selection')
          requestMainFocus()
        }
      })
    }
  }

  const handleInputDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!dragHasAttachments(event.dataTransfer, ALLR_PATHS_MIME)) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
  }

  const handleInputDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!dragHasAttachments(event.dataTransfer, ALLR_PATHS_MIME)) {
      return
    }

    const candidates = extractDroppedFiles(event.dataTransfer)

    if (!candidates.length) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    resetDragState()

    // Dropping straight onto the text box used to inline-ref *every* file —
    // including OS/Finder drops, whose absolute local path a remote gateway
    // can't read and whose image bytes never reached vision. Split by origin:
    // in-app drags stay inline refs; OS drops go through the upload pipeline.
    // (When no upload handler is wired, fall back to inline refs for all.)
    const attach = onAttachDroppedItems
    const { inAppRefs, osDrops } = partitionDroppedFiles(candidates)
    const refs = droppedFileInlineRefs(attach ? inAppRefs : candidates, cwd)

    if (refs.length && insertInlineRefs(refs)) {
      triggerHaptic('selection')
    }

    if (attach && osDrops.length) {
      void Promise.resolve(attach(osDrops)).then(attached => {
        if (attached) {
          triggerHaptic('selection')
          requestMainFocus()
        }
      })
    }
  }

  return {
    dragActive,
    handleDragEnter,
    handleDragLeave,
    handleDragOver,
    handleDrop,
    handleInputDragOver,
    handleInputDrop
  }
}
