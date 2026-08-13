import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import { Check, Palette } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { resolveTheme, type ThemeMode, useTheme } from '@/themes'

// Mobile appearance picker: a bottom Sheet with a light/dark/system segmented
// control + a skin grid. Swatches preview each skin's seed background/primary.
// The desktop equivalent is the Appearance settings tab (Track J4 later); this
// keeps skins reachable now from the shared sidebar.

const MODES: ThemeMode[] = ['light', 'dark', 'system']

// The mode segmented control + skin grid, without any container chrome. Shared
// between the sidebar's bottom-sheet ThemePicker and the Appearance settings
// section (Jc8), so both stay in sync.
export function ThemeControls() {
  const { availableThemes, mode, setMode, setTheme, themeName } = useTheme()
  const { t } = useI18n()

  const selectMode = (next: ThemeMode) => {
    triggerHaptic('selection')
    setMode(next)
  }

  const selectSkin = (name: string) => {
    triggerHaptic('selection')
    setTheme(name)
  }

  return (
    <>
      <div>
        <div className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {t.settings.appearance.colorMode}
        </div>
        <div className="grid grid-cols-3 gap-2">
          {MODES.map(m => (
            <Button
              aria-pressed={mode === m}
              className={cn(mode === m && 'border-primary text-foreground')}
              key={m}
              onClick={() => selectMode(m)}
              size="sm"
              variant={mode === m ? 'outline' : 'ghost'}
            >
              {t.settings.modeOptions[m].label}
            </Button>
          ))}
        </div>
      </div>

      <div className="mt-4">
        <div className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {t.settings.appearance.themeTitle}
        </div>
        <div className="grid grid-cols-2 gap-2">
          {availableThemes.map(theme => {
            const selected = theme.name === themeName
            const seed = resolveTheme(theme.name)
            const swatchBg = seed?.colors.background ?? '#888'
            const swatchDot = seed?.colors.primary ?? seed?.colors.ring ?? '#888'

            return (
              <button
                aria-label={theme.label}
                aria-pressed={selected}
                className={cn(
                  'flex items-center gap-2.5 rounded-lg border p-2.5 text-start transition-colors',
                  selected ? 'border-primary bg-accent' : 'border-border hover:bg-accent'
                )}
                key={theme.name}
                onClick={() => selectSkin(theme.name)}
                type="button"
              >
                <span
                  className="grid size-7 shrink-0 place-items-center rounded-full border border-border"
                  style={{ background: swatchBg }}
                >
                  <span className="size-3 rounded-full" style={{ background: swatchDot }} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground">{theme.label}</span>
                </span>
                {selected && <Check className="size-4 shrink-0 text-primary" />}
              </button>
            )
          })}
        </div>
      </div>
    </>
  )
}

export interface ThemePickerProps {
  className?: string
  collapsed?: boolean
}

export function ThemePicker({ className, collapsed = false }: ThemePickerProps) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)

  return (
    <Sheet onOpenChange={setOpen} open={open}>
      <SheetTrigger
        aria-label={t.settings.appearance.title}
        className={cn(
          'inline-flex min-w-32 items-center gap-2 rounded-md border border-border bg-card px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground',
          collapsed && 'min-w-0 px-2',
          className
        )}
        title={t.settings.appearance.title}
      >
        <Palette className="size-4 shrink-0" />
        {!collapsed && <span className="truncate">{t.settings.appearance.title}</span>}
      </SheetTrigger>
      <SheetContent className="max-h-[min(32rem,85vh)] gap-0 overflow-y-auto rounded-t-xl p-4" side="bottom">
        <SheetHeader className="p-0 pb-4">
          <SheetTitle>{t.settings.appearance.title}</SheetTitle>
          <SheetDescription>{t.settings.appearance.colorModeDesc}</SheetDescription>
        </SheetHeader>
        <ThemeControls />
      </SheetContent>
    </Sheet>
  )
}
