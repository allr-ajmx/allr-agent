import { memo, useState } from 'react'

import { StatusRow } from '@/components/chat/status-row'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { openExternalLink } from '@/lib/external-link'
import { useStoreSelector } from '@/lib/use-session-slice'
import { cn } from '@/lib/utils'
import { notifyError } from '@/store/notifications'
import { $activePreviewPath, requestClosePreviewTab, setPreviewTarget } from '@/store/preview'
import { type PreviewArtifact } from '@/store/preview-status'

const URL_TARGET = /^https?:\/\//i

/**
 * Resolve a recorded artifact target into the file path the right pane opens.
 * Relative targets resolve against the cwd captured at detection time, since the
 * session may have moved on by the time the row is clicked.
 */
function filePathFor(item: PreviewArtifact): string {
  const target = item.target.trim().replace(/^file:\/\//, '')

  if (target.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(target)) {
    return target
  }

  const cwd = item.cwd.trim().replace(/[\\/]+$/, '')

  return cwd ? `${cwd}/${target.replace(/^\.\//, '')}` : target
}

interface PreviewStatusRowProps {
  item: PreviewArtifact
  onDismiss: (id: string) => void
}

/**
 * One detected artifact, single line, always visible: name + open + dismiss.
 *
 * Ported from desktop, with the activation deliberately reshaped. Desktop toggles
 * an in-app WEBVIEW preview pane and sends plain clicks to the system browser via
 * its Electron `openPreviewInBrowser` bridge. Universal's preview pane is a file
 * viewer/editor with no URL surface, so there is nothing to toggle for a URL and
 * no browser trip needed for a file. The row therefore routes by target type
 * instead of by modifier key:
 * - `http(s)://…` (including localhost dev servers) → the system browser, through
 *   the existing `openExternalLink` seam (Tauri `open_external`).
 * - anything else → a tab in the right-pane file viewer; clicking an already-open
 *   tab closes it, preserving desktop's toggle feel.
 */
export const PreviewStatusRow = memo(function PreviewStatusRow({ item, onDismiss }: PreviewStatusRowProps) {
  const { t } = useI18n()
  const [opening, setOpening] = useState(false)

  const isUrl = URL_TARGET.test(item.target.trim())
  const path = isUrl ? '' : filePathFor(item)
  // A preview is a TILE now, so "showing" is a property of the tab list, not of
  // a pane's open flag. The old `$paneOpen(PREVIEW_PANE_ID)` conjunct named the
  // singleton rail pane that no longer exists in the layout tree.
  //
  // NARROWED to the BOOLEAN this row actually uses (MJXHRM-381), the same call
  // `coding-row.tsx` makes against `$pullRequestsByBranch` and for the same
  // reason: `$activePreviewPath` is a global that moves on every preview tab
  // open/switch/close, and one of these rows is mounted per artifact per tile —
  // so a whole-atom read repainted every artifact row in every tile whenever any
  // preview tab changed. The `memo()` on this component could never help against
  // that: the re-render came from its own subscription, not from a prop.
  const isOpen = useStoreSelector($activePreviewPath, active => !isUrl && active === path)

  const activate = async () => {
    if (opening) {
      return
    }

    if (isOpen) {
      requestClosePreviewTab(path)

      return
    }

    setOpening(true)

    try {
      if (isUrl) {
        await openExternalLink(item.target.trim())
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
    <StatusRow
      leading={
        <Codicon
          aria-hidden
          className={cn('text-muted-foreground/70', opening && 'animate-pulse')}
          name={isUrl ? 'globe' : 'file'}
          size="0.8rem"
        />
      }
      onActivate={() => void activate()}
      trailing={
        <Tip label={t.statusStack.dismiss}>
          <Button
            aria-label={t.statusStack.dismiss}
            className="-my-1 size-4 rounded-md text-muted-foreground/60 hover:text-foreground/90"
            onClick={event => {
              event.stopPropagation()
              onDismiss(item.id)
            }}
            size="icon-xs"
            type="button"
            variant="ghost"
          >
            <Codicon name="close" size="0.75rem" />
          </Button>
        </Tip>
      }
      trailingVisible
    >
      <Tip
        label={
          // inline-flex (not flex): a block child collapses Tip's decoration
          // wrapper geometry and mis-positions the tooltip (desktop #62022).
          <span className="inline-flex flex-col gap-0.5">
            <span>{item.target}</span>
            <span className="opacity-70">{isUrl ? t.preview.openInBrowser : t.preview.openPreview}</span>
          </span>
        }
      >
        <span className="min-w-0 max-w-[18rem] truncate text-[0.73rem] leading-4 text-foreground/92">{item.label}</span>
      </Tip>
    </StatusRow>
  )
})
