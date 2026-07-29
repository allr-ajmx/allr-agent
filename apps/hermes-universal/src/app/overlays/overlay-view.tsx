import { type ReactNode, useEffect } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { triggerHaptic } from '@/lib/haptics'
import { cn } from '@/lib/utils'

// Ported from apps/desktop/src/app/overlays/overlay-view.tsx. The full-screen
// modal card that hosts an overlay view (settings, …). Adapted for Tauri: the
// titlebar strip uses `data-tauri-drag-region` instead of the Electron
// `-webkit-app-region` classes, and haptics/close-label come from the universal
// seams.

interface OverlayViewProps {
  children: ReactNode
  onClose: () => void
  closeLabel?: string
  contentClassName?: string
  headerContent?: ReactNode
  rootClassName?: string
}

export function OverlayView({
  children,
  onClose,
  closeLabel = 'Close',
  contentClassName,
  headerContent,
  rootClassName
}: OverlayViewProps) {
  const closeOverlay = () => {
    void triggerHaptic('selection')
    onClose()
  }

  // Esc dismisses the overlay. Nested Radix dialogs stop propagation themselves,
  // so opening (e.g.) a select inside Settings still closes the popover first.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) {
        return
      }

      event.preventDefault()
      void triggerHaptic('selection')
      onClose()
    }

    window.addEventListener('keydown', onKeyDown)

    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div
      className={cn(
        'fixed inset-0 z-50 bg-black/22 backdrop-blur-[0.125rem]',
        // Equidistant inset on every side, driven by the titlebar height so the
        // card clears the OS traffic-lights vertically.
        'p-[calc(var(--titlebar-height)+0.625rem)]',
        'sm:p-[calc(var(--titlebar-height)+0.875rem)]'
      )}
      onClick={event => {
        if (event.target === event.currentTarget) {
          closeOverlay()
        }
      }}
      role="presentation"
    >
      <div
        className={cn(
          'relative flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-chat-surface-background) shadow-md',
          rootClassName
        )}
      >
        <div
          className="pointer-events-none absolute inset-x-0 top-0 z-10 h-[calc(var(--titlebar-height)+0.1875rem)]"
          data-tauri-drag-region
        >
          {headerContent && (
            <div className="pointer-events-auto absolute left-1/2 top-[calc(0.5rem+var(--titlebar-height)/2)] -translate-x-1/2 -translate-y-1/2">
              {headerContent}
            </div>
          )}

          <Button
            aria-label={closeLabel}
            className="pointer-events-auto absolute right-3 top-[calc(0.1875rem+var(--titlebar-height)/2)] -translate-y-1/2 text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground"
            onClick={closeOverlay}
            size="icon-titlebar"
            variant="ghost"
          >
            <Codicon name="close" size="1rem" />
          </Button>
        </div>

        {/* No top padding here: the split-layout columns own their own titlebar
            clearance so their backgrounds run flush to the card top. */}
        <div className={cn('min-h-0 flex flex-1 flex-col', contentClassName)}>{children}</div>
      </div>
    </div>
  )
}
