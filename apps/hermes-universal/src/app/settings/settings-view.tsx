import { open, save } from '@tauri-apps/plugin-dialog'
import { readFile, writeTextFile } from '@tauri-apps/plugin-fs'
import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

import { OverlayMain, OverlayNav, type OverlayNavGroup, OverlaySplitLayout } from '@/app/overlays/overlay-split-layout'
import { OverlayView } from '@/app/overlays/overlay-view'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@/components/ui/dialog'
import { getHermesConfigDefaults, getHermesConfigRecord, saveHermesConfig } from '@/hermes'
import { useI18n } from '@/i18n'
import { Download, Refresh, Upload } from '@/lib/icons'
import { notify, notifyError } from '@/store/notifications'

import { SECTIONS } from './constants'
import { useSettingsNavGroups } from './settings-nav'
import { SectionBody } from './settings-section'
import { invalidateHermesConfig, setHermesConfigCache } from './use-config-record'

const DEFAULT_SECTION = SECTIONS[0]?.id ?? 'model'

// The nav footer: Export / Import / Reset (matches desktop). Export & import round-
// trip the whole config record through a native Tauri file dialog; reset restores
// defaults behind a confirm dialog.
function SettingsFooter() {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)

  const exportConfig = async () => {
    try {
      const cfg = await getHermesConfigRecord()
      const path = await save({ defaultPath: 'hermes-config.json', filters: [{ extensions: ['json'], name: 'JSON' }] })

      if (!path) {
        return
      }

      await writeTextFile(path, JSON.stringify(cfg, null, 2))
      notify({ kind: 'success', message: t.settings.exportConfig })
    } catch (err) {
      notifyError(err, t.settings.exportFailed)
    }
  }

  const importConfig = async () => {
    const path = await open({ filters: [{ extensions: ['json'], name: 'JSON' }], multiple: false })

    if (!path || typeof path !== 'string') {
      return
    }

    try {
      const parsed = JSON.parse(new TextDecoder().decode(await readFile(path)))
      await saveHermesConfig(parsed)
      setHermesConfigCache(parsed)
      void invalidateHermesConfig()
      notify({ kind: 'success', message: t.settings.config.imported })
    } catch (err) {
      notifyError(err, t.settings.config.invalidJson)
    }
  }

  const reset = async () => {
    setBusy(true)

    try {
      const defaults = await getHermesConfigDefaults()
      await saveHermesConfig(defaults)
      setHermesConfigCache(defaults)
      void invalidateHermesConfig()
      notify({ kind: 'success', message: t.settings.resetToDefaults })
    } catch (err) {
      notifyError(err, t.settings.resetFailed)
    } finally {
      setBusy(false)
    }
  }

  const iconBtn = 'text-muted-foreground hover:text-foreground'

  return (
    <>
      <Button
        aria-label={t.settings.exportConfig}
        className={iconBtn}
        onClick={() => void exportConfig()}
        size="icon-sm"
        title={t.settings.exportConfig}
        variant="ghost"
      >
        <Download className="size-4" />
      </Button>
      <Button
        aria-label={t.settings.importConfig}
        className={iconBtn}
        onClick={() => void importConfig()}
        size="icon-sm"
        title={t.settings.importConfig}
        variant="ghost"
      >
        <Upload className="size-4" />
      </Button>
      <Dialog>
        <DialogTrigger asChild>
          <Button
            aria-label={t.settings.resetToDefaults}
            className="text-muted-foreground hover:text-destructive"
            size="icon-sm"
            title={t.settings.resetToDefaults}
            variant="ghost"
          >
            <Refresh className="size-4" />
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.settings.resetToDefaults}</DialogTitle>
            <DialogDescription>{t.settings.resetConfirm}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost">{t.common.cancel}</Button>
            </DialogClose>
            <DialogClose asChild>
              <Button disabled={busy} onClick={() => void reset()} variant="destructive">
                {t.settings.resetToDefaults}
              </Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

// The desktop-style settings portal: a full-window OverlayView card with a left
// nav rail (→ tab-dropdown on narrow) and the active section on the right. The
// active section id is the `/settings/:section` route param (default `model`);
// nav selection navigates the route, so existing deep-links keep working.
export function SettingsView({ returnPath = '/' }: { returnPath?: string }) {
  const { t } = useI18n()
  const navigate = useNavigate()
  // Rendered as a top-level overlay (not a routed element), so the active section
  // is parsed from the path rather than route params: `/settings/:group(/:sub)`.
  // `section` keeps the full path (e.g. `providers/keys`) for sub-tab routing;
  // `topId` is the first segment, used for parent-group highlighting.
  const { pathname } = useLocation()
  const section = pathname.startsWith('/settings/') ? pathname.slice('/settings/'.length) : DEFAULT_SECTION
  const topId = section.split('/')[0]

  const groups: OverlayNavGroup[] = useSettingsNavGroups().map(group => ({
    active: group.id === topId,
    gapBefore: group.gapBefore,
    icon: group.icon,
    id: group.id,
    label: group.label,
    // `replace` so switching sections never stacks history (keeps close correct).
    onSelect: () => navigate(`/settings/${group.id}`, { replace: true }),
    children: group.children?.map(child => ({
      active: child.id === section,
      icon: child.icon,
      id: child.id,
      label: child.label,
      onSelect: () => navigate(`/settings/${child.id}`, { replace: true })
    }))
  }))

  // Close returns to the route the user was on before opening settings, not the
  // previously-viewed settings section.
  const close = () => navigate(returnPath)

  return (
    <OverlayView closeLabel={t.settings.closeSettings} onClose={close}>
      <OverlaySplitLayout>
        <OverlayNav footer={<SettingsFooter />} groups={groups} />
        <OverlayMain className="px-0 pb-0">
          <SectionBody section={section} />
        </OverlayMain>
      </OverlaySplitLayout>
    </OverlayView>
  )
}
