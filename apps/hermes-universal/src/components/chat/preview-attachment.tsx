import { useStore } from '@nanostores/react'
import { useState } from 'react'

import { useSessionView } from '@/app/chat/session-view'
import { useI18n } from '@/i18n'
import { openExternalLink } from '@/lib/external-link'
import { MonitorPlay } from '@/lib/icons'
import { previewName } from '@/lib/preview-targets'
import { useStoreSelector } from '@/lib/use-session-slice'
import { notifyError } from '@/store/notifications'
import { $activePreviewPath, closePreviewTab, setPreviewTarget } from '@/store/preview'

const URL_TARGET = /^https?:\/\//i

/**
 * Resolve a previewable target from a transcript into the path the right pane
 * opens. Relative targets resolve against the session's own cwd — this link
 * lives in ONE session's transcript, so it must not resolve against whichever
 * chat happens to be primary.
 */
function filePathFor(target: string, cwd: string): string {
  const cleaned = target.trim().replace(/^file:\/\//, '')

  if (cleaned.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(cleaned)) {
    return cleaned
  }

  const base = cwd.trim().replace(/[\\/]+$/, '')

  return base ? `${base}/${cleaned.replace(/^\.\//, '')}` : cleaned
}

/**
 * A previewable link found in a completed assistant reply, rendered as a toggle
 * under the message.
 *
 * Ported from desktop `components/chat/preview-attachment.tsx`, with the
 * activation reshaped exactly as the composer's `PreviewStatusRow` already
 * reshaped it: desktop toggles an in-app WEBVIEW preview and tracks which
 * source opened each rail tab (`$previewTabSources` / `openPreview`). Universal's
 * preview pane is a file viewer with no URL surface, so there is nothing to
 * toggle for a URL and no source-attribution layer to keep. The target type
 * decides instead:
 * - `http(s)://…` → the system browser via the `openExternalLink` seam.
 * - anything else → a right-pane file tab; clicking an open one closes it,
 *   preserving desktop's toggle feel.
 */
export function PreviewAttachment({ target }: { target: string }) {
  const { t } = useI18n()
  const cwd = useStore(useSessionView().$cwd)
  const [opening, setOpening] = useState(false)

  const isUrl = URL_TARGET.test(target.trim())
  const path = isUrl ? '' : filePathFor(target, cwd)
  // A preview is a TILE now — "showing" is the tab list's business, not a
  // singleton pane's open flag (see preview-row.tsx).
  //
  // NARROWED to the boolean (MJXHRM-381): one of these renders per previewable
  // link in a transcript, across every mounted transcript, and nothing else
  // re-renders them when a preview tab changes — so the whole-atom read was the
  // sole reason every one of them repainted on every tab open/switch/close.
  const isActive = useStoreSelector($activePreviewPath, active => !isUrl && active === path)
  const name = previewName(target)

  const togglePreview = async () => {
    if (opening) {
      return
    }

    if (isActive) {
      closePreviewTab(path)

      return
    }

    setOpening(true)

    try {
      if (isUrl) {
        await openExternalLink(target.trim())
      } else {
        setPreviewTarget(path)
      }
    } catch (error) {
      notifyError(error, t.preview.unavailable)
    } finally {
      setOpening(false)
    }
  }

  return (
    <div className="flex w-full max-w-160 items-center gap-2 rounded-lg border border-border/55 bg-card/55 px-2.5 py-1.5 text-sm">
      <span className="grid size-6 shrink-0 place-items-center rounded-md bg-muted/55 text-muted-foreground/85">
        <MonitorPlay className="size-3.5" />
      </span>
      <span className="min-w-0 flex-1 truncate text-[0.78rem] font-medium text-foreground/90" title={target}>
        {name}
      </span>
      <button
        className="shrink-0 rounded-md border border-border/55 bg-background/40 px-2 py-1 text-[0.7rem] font-medium text-muted-foreground transition-colors hover:bg-accent/55 hover:text-foreground disabled:opacity-50"
        disabled={opening}
        onClick={() => void togglePreview()}
        type="button"
      >
        {opening
          ? t.preview.opening
          : isActive
            ? t.preview.hide
            : isUrl
              ? t.preview.openInBrowser
              : t.preview.openPreview}
      </button>
    </div>
  )
}
