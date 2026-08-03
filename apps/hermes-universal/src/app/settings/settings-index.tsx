import { useState } from 'react'
import { Link } from 'react-router-dom'

import { SidebarTrigger } from '@/app/shell/sidebar'
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
import { getHermesConfigDefaults, saveHermesConfig } from '@/hermes'
import { useI18n } from '@/i18n'
import { ChevronRight, Refresh } from '@/lib/icons'
import { notify, notifyError } from '@/store/notifications'

import { SettingsContent } from './primitives'
import { useSettingsNav } from './settings-nav'
import { invalidateHermesConfig, setHermesConfigCache } from './use-config-record'

// The mobile drill-in index ships reset-only. Config export/import lives on the
// desktop-shell overlay footer instead (`settings-view.tsx`), where the Tauri
// dialog + fs plugins are available — this list is the touch surface and has no
// file-picker affordance to hang them off.
function ResetToDefaults() {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)

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

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button className="mt-6 w-full" variant="outline">
          <Refresh className="size-4" />
          {t.settings.resetToDefaults}
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
  )
}

export function SettingsIndex() {
  const { t } = useI18n()
  const nav = useSettingsNav()

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-border p-3">
        <SidebarTrigger className="md:hidden" />
        <h1 className="text-base font-semibold text-foreground">{t.nav.settings}</h1>
      </header>
      <SettingsContent>
        <div className="pt-1">
          {nav.map(entry => {
            const Icon = entry.icon

            return (
              <Link
                className="flex items-center gap-3 border-b border-border/60 py-3.5 text-sm text-foreground transition-colors last:border-b-0 hover:text-primary"
                key={entry.id}
                to={`/settings/${entry.id}`}
              >
                <Icon className="size-5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-medium">{entry.label}</span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
              </Link>
            )
          })}
        </div>
        <ResetToDefaults />
      </SettingsContent>
    </div>
  )
}
