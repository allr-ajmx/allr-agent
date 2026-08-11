import { useEffect, useMemo } from 'react'

import type { StatusbarItem } from '@/app/shell/statusbar-controls'
import { useI18n } from '@/i18n'
import { EyeOff } from '@/lib/icons'
import { useStore } from '@/store/atom'
import { $focusView, type FocusRequester, pushFocusView, syncFocusView } from '@/store/focus-view'

/**
 * The focus-view badge — the half of `/focus` that keeps the reduced mode from
 * being invisible.
 *
 * A user who left focus on yesterday, or turned it on from the CLI, otherwise
 * meets a transcript with no tool activity in it and nothing saying why. The
 * badge is the answer, and clicking it is the way out; it deliberately carries
 * no `toggleLabel`, so it cannot be hidden from the bar's customize menu — a
 * hidden indicator for a hiding mode is the bug it exists to prevent.
 *
 * Returns null while focus is off: an always-present "focus: off" segment would
 * spend a slot on the state that needs no explanation.
 */
export function useFocusViewStatusbarItem(requestGateway: FocusRequester): null | StatusbarItem {
  const { t } = useI18n()
  const copy = t.shell.statusbar
  const focusView = useStore($focusView)

  // Adopt the gateway's shared `display.focus_view` on connect. Failures are
  // swallowed: an older gateway that doesn't know the key must not cost the
  // user their locally persisted mode.
  useEffect(() => {
    void syncFocusView(requestGateway).catch(() => undefined)
  }, [requestGateway])

  return useMemo<null | StatusbarItem>(() => {
    if (!focusView) {
      return null
    }

    return {
      className: 'text-foreground',
      icon: <EyeOff className="size-3.5" />,
      id: 'focus-view',
      label: copy.focusView,
      onSelect: () => {
        void pushFocusView(requestGateway, false).catch(() => undefined)
      },
      title: copy.focusViewTitle,
      variant: 'action'
    }
  }, [copy.focusView, copy.focusViewTitle, focusView, requestGateway])
}
