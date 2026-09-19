import { PhysicalPosition } from '@tauri-apps/api/dpi'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { useCallback, useEffect, useState } from 'react'

import { IS_TAURI } from '@/lib/platform'

export const HUD_POSITION_STORAGE_KEY = 'hermes:hud-window-position'

export interface HudWindowPosition {
  x: number
  y: number
}

/**
 * Hook to support Command/Ctrl + Drag on the HUD window to move it freely
 * and remember its resting position across sessions and summons.
 */
export function useHudDrag(): {
  commandHeld: boolean
  onPointerDown: (event: React.PointerEvent) => void
} {
  const [commandHeld, setCommandHeld] = useState(false)

  // Track Meta/Control key state so we can show appropriate cursor styles
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Meta' || event.key === 'Control') {
        setCommandHeld(true)
      }
    }

    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Meta' || event.key === 'Control') {
        setCommandHeld(false)
      }
    }

    const handleBlur = () => {
      setCommandHeld(false)
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    window.addEventListener('blur', handleBlur)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      window.removeEventListener('blur', handleBlur)
    }
  }, [])

  // Restore saved resting position on initial mount
  useEffect(() => {
    if (!IS_TAURI) {
      return
    }
    void (async () => {
      try {
        const win = getCurrentWebviewWindow()

        // Restore saved position if available
        try {
          const saved = window.localStorage.getItem(HUD_POSITION_STORAGE_KEY)

          if (saved) {
            const parsed = JSON.parse(saved) as HudWindowPosition

            if (
              typeof parsed?.x === 'number' &&
              typeof parsed?.y === 'number' &&
              Number.isFinite(parsed.x) &&
              Number.isFinite(parsed.y)
            ) {
              await win.setPosition(new PhysicalPosition(parsed.x, parsed.y))
            }
          }
        } catch {
          // Bad JSON or storage error — ignore
        }
      } catch {
        // Non-tauri or window system error
      }
    })()
  }, [])

  // Handle Command/Ctrl + PointerDown to initiate native window dragging
  // and persist the resting position ONLY when user finishes dragging.
  const onPointerDown = useCallback((event: React.PointerEvent) => {
    if (event.metaKey || event.ctrlKey) {
      event.preventDefault()

      if (IS_TAURI) {
        try {
          const win = getCurrentWebviewWindow()
          void win.startDragging()

          const handleDragEnd = () => {
            window.removeEventListener('pointerup', handleDragEnd)
            window.removeEventListener('blur', handleDragEnd)

            void (async () => {
              try {
                const pos = await win.outerPosition()

                if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
                  window.localStorage.setItem(HUD_POSITION_STORAGE_KEY, JSON.stringify({ x: pos.x, y: pos.y }))
                }
              } catch {
                // Ignore
              }
            })()
          }

          window.addEventListener('pointerup', handleDragEnd, { once: true })
          window.addEventListener('blur', handleDragEnd, { once: true })
        } catch {
          // Ignore
        }
      }
    }
  }, [])

  return { commandHeld, onPointerDown }
}
