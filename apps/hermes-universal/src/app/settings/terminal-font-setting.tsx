import { useEffect, useRef, useState } from 'react'

import { useOnProfileSwitch } from '@/app/hooks/use-on-profile-switch'
import {
  resolveTerminalFontFamily,
  setTerminalFontFamilyFromConfig,
  TERMINAL_FONT_SUGGESTIONS,
  terminalFontFamilyFromConfig
} from '@/app/right-pane/terminal/terminal-font'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { saveHermesConfig } from '@/hermes'
import { useI18n } from '@/i18n'
import { notifyError } from '@/store/notifications'
import type { HermesConfigRecord } from '@/types/hermes'

import { setNested } from './helpers'
import { ListRow } from './primitives'
import { setHermesConfigCache, useHermesConfigRecord } from './use-config-record'

// The Settings half of `terminal.font_family` — the consumption half lives in
// `app/right-pane/terminal/terminal-font.ts`. Ported from desktop
// `app/settings/terminal-font-setting.tsx`; the only adaptations are the import
// paths (universal's terminal is `right-pane`, not `right-sidebar`) and reading
// the family through `terminalFontFamilyFromConfig` instead of `getNested`.
//
// Free text with a datalist rather than a closed <select>: the useful families
// are whatever the host happens to have installed, which the webview cannot
// enumerate, and an authored CSS stack has to stay typeable.
const AUTOSAVE_DELAY_MS = 550

export function TerminalFontSetting() {
  const { t } = useI18n()
  const copy = t.settings.appearance
  const { data: loadedConfig } = useHermesConfigRecord()
  // draft === null ⇔ unseeded: nothing painted yet for this profile. The
  // profile-switch handler resets it to null and records the config object it
  // was looking at (`staleConfig`) — the seed effect refuses to re-seed from
  // that same object, so the previous profile's cached record can't repopulate
  // the field; the next profile's fetch (a new object) seeds it.
  const [draft, setDraft] = useState<null | string>(null)
  const [staleConfig, setStaleConfig] = useState<HermesConfigRecord | null>(null)
  const [saveVersion, setSaveVersion] = useState(0)
  const saveVersionRef = useRef(0)

  // Lexically outside every useEffect so async save callbacks can cancel the
  // in-flight version without assigning to a ref inside an effect body.
  const cancelPendingSave = () => {
    saveVersionRef.current = 0
  }

  useEffect(() => {
    if (!loadedConfig || draft !== null || loadedConfig === staleConfig) {
      return
    }

    const value = terminalFontFamilyFromConfig(loadedConfig)
    setDraft(value)
    setTerminalFontFamilyFromConfig(value)
  }, [draft, loadedConfig, staleConfig])

  useOnProfileSwitch(() => {
    saveVersionRef.current += 1
    setDraft(null)
    setStaleConfig(loadedConfig ?? null)
    setSaveVersion(0)
    // Do not show the previous profile's font while the new profile loads.
    setTerminalFontFamilyFromConfig('')
  })

  useEffect(() => {
    if (draft === null || saveVersion === 0 || !loadedConfig) {
      return
    }

    const version = saveVersion
    const value = draft.trim()

    // Already persisted (or a cache refresh confirmed it) — nothing to save.
    // This also terminates the effect re-run after a successful save updates
    // the shared config cache.
    if (value === terminalFontFamilyFromConfig(loadedConfig)) {
      return
    }

    // The last successfully saved value IS what the shared config cache holds —
    // successful saves write it back via setHermesConfigCache, so rollback
    // re-derives from there instead of mirroring into a ref.
    const rollback = terminalFontFamilyFromConfig(loadedConfig)

    const timeout = window.setTimeout(() => {
      const next = setNested(loadedConfig, 'terminal.font_family', value)

      void saveHermesConfig(next)
        .then(result => {
          if (!result.ok) {
            throw new Error(t.settings.config.autosaveFailed)
          }

          if (saveVersionRef.current !== version) {
            return
          }

          setHermesConfigCache(next)
          // Re-assert the atom against what the gateway now holds. Idempotent in
          // the normal case (it already says `value`, so nothing changes and
          // nothing broadcasts) — it exists for the race where a PEER WebView
          // revalidated its config record during the debounce, read the
          // pre-save value, and pushed that back over the bus. This is the
          // moment we know which of the two is authoritative.
          setTerminalFontFamilyFromConfig(value)
        })
        .catch(error => {
          if (saveVersionRef.current !== version) {
            return
          }

          cancelPendingSave()
          setSaveVersion(0)
          setDraft(rollback)
          setTerminalFontFamilyFromConfig(rollback)
          notifyError(error, t.settings.config.autosaveFailed)
        })
    }, AUTOSAVE_DELAY_MS)

    return () => window.clearTimeout(timeout)
  }, [draft, loadedConfig, saveVersion, t.settings.config.autosaveFailed])

  // Every keystroke pushes the atom, so an open terminal re-renders in the new
  // face while the save is still being debounced.
  const update = (value: string) => {
    saveVersionRef.current += 1
    setDraft(value)
    setSaveVersion(saveVersionRef.current)
    setTerminalFontFamilyFromConfig(value)
  }

  const value = draft ?? ''
  const previewFontFamily = resolveTerminalFontFamily(value)

  return (
    <ListRow
      below={
        <div className="mt-3 space-y-2">
          <div className="flex items-center gap-3">
            <Input
              aria-label={copy.terminalFontTitle}
              className="flex-1"
              disabled={draft === null}
              list="hermes-terminal-font-families"
              onChange={event => update(event.target.value)}
              placeholder={copy.terminalFontPlaceholder}
              value={value}
            />
            <Button disabled={!value || draft === null} onClick={() => update('')} size="inline" variant="text">
              {copy.terminalFontReset}
            </Button>
          </div>
          <datalist id="hermes-terminal-font-families">
            {TERMINAL_FONT_SUGGESTIONS.map(font => (
              <option key={font} value={font} />
            ))}
          </datalist>
          <div
            aria-label={copy.terminalFontPreview}
            className="overflow-hidden px-1 py-2 text-sm text-(--ui-text-secondary)"
            style={{ fontFamily: previewFontFamily }}
          >
            <span className="mr-2 text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
              {copy.terminalFontPreview}
            </span>
            <span> ~/project git:main ❯</span>
          </div>
        </div>
      }
      description={copy.terminalFontDesc}
      title={copy.terminalFontTitle}
      wide
    />
  )
}
