import { ListRow } from '@/app/settings/primitives'
import { Switch } from '@/components/ui/switch'
import { useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import { useStore } from '@/store/atom'
import { $quickEntryEnabled, setQuickEntryEnabled } from '@/store/quick-entry'

import { canUseQuickEntry } from './quick-entry'

/**
 * Quick Entry's settings row — the enable switch, and nothing else.
 *
 * Desktop's `quick-entry-settings.tsx` also carried a free-text accelerator
 * field, plus the copy for the two ways it could fail ("not a valid shortcut",
 * "another app already uses this"). None of that is ours to own: universal
 * registers global chords from the rebindable keybind registry, so Settings ▸
 * Keyboard shortcuts already binds this one, already validates what it accepts,
 * and already shows conflicts — a second, bespoke shortcut field would be a
 * second place for the answer to be wrong.
 *
 * The switch stays because it is a genuinely different question from "what is
 * the chord": it is how a user turns the surface off without losing the binding
 * they chose. Device-local (`$quickEntryEnabled`), like keep-awake beside it.
 *
 * Lives in `app/quick-entry/` rather than in `app/settings/` so the feature is
 * one directory; Settings imports it the same way it imports the pet section.
 */
export function QuickEntryRow() {
  const { t } = useI18n()
  const copy = t.quickEntry
  const enabled = useStore($quickEntryEnabled)

  if (!canUseQuickEntry()) {
    return null
  }

  return (
    <ListRow
      action={
        <Switch
          aria-label={copy.settingsTitle}
          checked={enabled}
          onCheckedChange={on => {
            triggerHaptic('selection')
            setQuickEntryEnabled(on)
          }}
        />
      }
      description={`${copy.settingsDesc} ${copy.shortcutHint}`}
      title={copy.settingsTitle}
    />
  )
}
