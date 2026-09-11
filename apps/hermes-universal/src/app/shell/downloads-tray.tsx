import { useRef } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Progress } from '@/components/ui/progress'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { createTap, isCoarsePointer } from '@/lib/touch'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import {
  $recentDownloads,
  cancelDownload,
  clearFinishedDownloads,
  dismissDownload,
  downloadErrorMessage,
  openDownload,
  revealDownload
} from '@/store/downloads'
import { downloadFraction, type DownloadItem, formatBytes, isActive } from '@/store/downloads-reducer'

import { type TitlebarButtonVariantProps, titlebarButtonVariants } from './titlebar-button'

// The downloads tray: the app's one place to see what is being written to this
// device and to stop it.
//
// It lives in the titlebar rather than in the Files pane because a download is
// not about the pane it was started from — a 4 GB file queued from a transcript
// attachment is still going ten minutes after that chat scrolled away, and the
// pane it came from may be closed or in another window entirely. Rule 21 is why
// this works at all: `store/downloads.ts` broadcasts rows between WebViews, so
// this component renders its peers' transfers too and cancel reaches them.
//
// Mounted twice — the desktop titlebar's right cluster and the mobile top bar's
// `right` slot — with `density` doing what it does for `TitlebarButton`.
//
// The button is ALWAYS present, the way a browser's is. It used to unmount 60
// seconds after the last transfer finished, which made "where did that file
// go?" unanswerable two minutes later — so the dot badge is now the only thing
// that varies with activity, and the panel is the one route back to a past
// download. The list is session-only by design: nothing here is persisted, so a
// reload starts empty rather than restoring rows whose Rust-side transfer died
// with the old webview.

/**
 * A button that resolves its own taps (rule 31).
 *
 * On a touch screen `click` is not an event the page receives, it is a verdict
 * the engine reaches after ruling out a scroll — and these buttons sit inside a
 * portalled, scrollable list, which is the exact situation where the Android
 * WebView rules against a quick jab. `createTap` reads `pointerup` directly; the
 * capture-phase guard then kills the synthetic click if one does arrive, so a
 * tap can never both tap and click. A mouse never arms the gesture (`createTap`
 * ignores `pointerType === 'mouse'`) and its native click path is untouched.
 */
function TapButton({
  className,
  disabled,
  label,
  onTap,
  children
}: {
  className?: string
  disabled?: boolean
  label: string
  onTap: () => void
  children: React.ReactNode
}) {
  const tapRef = useRef<null | ReturnType<typeof createTap>>(null)
  const handlerRef = useRef(onTap)

  handlerRef.current = onTap

  if (!tapRef.current) {
    tapRef.current = createTap({ onTap: () => handlerRef.current() })
  }

  const tap = tapRef.current

  return (
    // `Tip`, never the native `title=` attribute: `no-native-title.test.ts`
    // scans for it, and an OS tooltip is unstyled and half a second late.
    <Tip label={label}>
      <button
        aria-label={label}
        className={cn(
          // A finger gets a real target even though the glyph is small;
          // `coarse:` rather than a media-query const so a touchscreen laptop
          // gets it too.
          'grid size-6 shrink-0 place-items-center rounded text-(--ui-text-quaternary) transition-colors hover:text-foreground coarse:size-11',
          disabled && 'pointer-events-none opacity-40',
          className
        )}
        disabled={disabled}
        onClick={() => handlerRef.current()}
        onClickCapture={event => {
          if (tap.fired()) {
            event.preventDefault()
            event.stopPropagation()
          }
        }}
        onPointerCancel={tap.cancel}
        onPointerDown={tap.down}
        onPointerMove={tap.move}
        onPointerUp={tap.up}
        type="button"
      >
        {children}
      </button>
    </Tip>
  )
}

function DownloadRow({ item }: { item: DownloadItem }) {
  const { t } = useI18n()
  const fraction = downloadFraction(item)
  const running = isActive(item)

  const statusLabel = {
    cancelled: t.downloads.status.cancelled,
    done: t.downloads.status.done,
    failed: t.downloads.status.failed,
    queued: t.downloads.status.queued,
    running: t.downloads.status.running
  }[item.status]

  const rowTapRef = useRef<null | ReturnType<typeof createTap>>(null)

  if (!rowTapRef.current) {
    rowTapRef.current = createTap({
      onTap: () => {
        // Asked at GESTURE time, not read off the frozen `IS_MOBILE` const
        // (rule 31): what matters is how this row is being touched right now.
        // A finger has no hover to reveal the row's buttons with, so the row
        // body itself opens a finished download; a mouse leaves the row inert
        // and uses the explicit buttons, which is what a desktop user expects.
        if (isCoarsePointer() && item.status === 'done') {
          void openDownload(item.id)
        }
      }
    })
  }

  const rowTap = rowTapRef.current

  return (
    <li
      className="group/download flex flex-col gap-1 rounded-md px-2 py-1.5 hover:bg-(--ui-control-hover-background)"
      onPointerCancel={rowTap.cancel}
      onPointerDown={rowTap.down}
      onPointerMove={rowTap.move}
      onPointerUp={rowTap.up}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Codicon
          className={cn(
            'shrink-0',
            item.status === 'failed' && 'text-(--ui-red)',
            item.status === 'done' && 'text-(--ui-green)'
          )}
          name={item.kind === 'folder' ? 'file-zip' : 'cloud-download'}
          size="0.875rem"
        />
        <span className="min-w-0 flex-1 truncate text-xs" title={item.dest}>
          {item.name}
        </span>
        {running ? (
          <TapButton label={t.downloads.cancel} onTap={() => void cancelDownload(item.id)}>
            <Codicon name="close" size="0.75rem" />
          </TapButton>
        ) : (
          <>
            {item.status === 'done' && (
              <>
                <TapButton label={t.downloads.reveal} onTap={() => void revealDownload(item.id)}>
                  <Codicon name="folder-opened" size="0.75rem" />
                </TapButton>
                <TapButton label={t.downloads.open} onTap={() => void openDownload(item.id)}>
                  <Codicon name="link-external" size="0.75rem" />
                </TapButton>
              </>
            )}
            <TapButton label={t.downloads.dismiss} onTap={() => dismissDownload(item.id)}>
              <Codicon name="trash" size="0.75rem" />
            </TapButton>
          </>
        )}
      </div>

      {/* The bar goes indeterminate when there is no endpoint to measure
          against — a streamed archive has no Content-Length, so a percentage
          would be an invention. */}
      <Progress
        destructive={item.status === 'failed'}
        indeterminate={fraction === null && running}
        size="sm"
        value={fraction ?? 0}
      />

      <div className="flex items-center justify-between gap-2 text-[0.625rem] text-(--ui-text-quaternary)">
        <span className="truncate">{item.status === 'failed' ? downloadErrorMessage(item.error) : statusLabel}</span>
        <span className="shrink-0 tabular-nums">
          {item.total === null || item.total <= 0
            ? formatBytes(item.received)
            : t.downloads.ofTotal(formatBytes(item.received), formatBytes(item.total))}
        </span>
      </div>
    </li>
  )
}

export function DownloadsTray({ density = 'desktop' }: TitlebarButtonVariantProps) {
  const { t } = useI18n()
  const items = useStore($recentDownloads)
  const activeCount = items.filter(isActive).length

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          // Same CVA as every other titlebar control, but NOT wrapped in `Tip`:
          // a tooltip fights an open menu, so the trigger names itself with
          // `aria-label` exactly the way `LayoutMenu` does.
          aria-label={activeCount > 0 ? t.downloads.inProgress(activeCount) : t.downloads.title}
          className={cn(titlebarButtonVariants({ density }), 'relative')}
          size="icon"
          type="button"
          variant="ghost"
        >
          <Codicon name="cloud-download" size={density === 'mobile' ? '1.4rem' : undefined} />
          {activeCount > 0 && (
            // A dot, not a number: the count is in the aria-label and the list,
            // and a digit at this size is unreadable next to the glyph.
            <span className="absolute top-0.5 end-0.5 size-1.5 rounded-full bg-primary" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        aria-label={t.downloads.title}
        className="w-80 max-w-[calc(100vw-1rem)]"
        // Rule 32's ceiling. The lift half of that rule does not apply — this
        // surface holds no focusable text field, so no keyboard can ever come up
        // under it — but the ceiling does: Radix sizes itself off the LAYOUT
        // viewport, and on a phone that is taller than what the user can see.
        style={{ maxHeight: 'calc(var(--visual-viewport-height, 100vh) - 5rem)' }}
      >
        <div className="flex items-center justify-between gap-2 px-2.5 pt-1 pb-1.5">
          <span className="text-[0.625rem] font-medium tracking-wide text-(--ui-text-quaternary) uppercase">
            {t.downloads.title}
          </span>
          {items.some(item => !isActive(item)) && (
            <TapButton
              className="size-auto w-auto px-1 text-[0.625rem] coarse:size-auto coarse:min-h-11 coarse:px-2"
              label={t.downloads.clearFinished}
              onTap={clearFinishedDownloads}
            >
              {t.downloads.clearFinished}
            </TapButton>
          )}
        </div>
        <ul className="flex flex-col gap-0.5">
          {/* The button is unconditional now, so the list it opens can be
              empty — and an empty `<ul>` renders as a menu with a heading and
              nothing under it, which reads as broken rather than as idle. */}
          {items.length === 0 ? (
            <li className="px-2.5 py-3 text-center text-xs text-(--ui-text-quaternary)">{t.downloads.empty}</li>
          ) : (
            items.map(item => <DownloadRow item={item} key={item.id} />)
          )}
        </ul>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
