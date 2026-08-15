import { $appLocale, type Locale, normalizeLocale, translateFrom, TRANSLATIONS } from '@/i18n'
import { IS_DESKTOP } from '@/lib/platform'
import { $connectionPhase, type ConnectionPhase } from '@/store/connection'

// The tray's copy — pushed down, because a native menu cannot read the catalog.
//
// `src-tauri/src/tray.rs` builds the menu with English literals so first paint is
// never blank, and everything after that comes from here. This is the split the
// app already uses wherever the webview owns the words and Rust owns the native
// lever (`appearance.rs` translucency, `keep_awake.rs`): there is no message
// bundle on the Rust side, five locales live in `src/i18n/*.ts`, and nothing over
// there re-renders when `display.language` changes.
//
// Kept OUT of `store/background-mode.ts` on purpose. That module is imported by
// `store/windows.ts`, and this one imports `store/connection`, which reaches a
// large part of the gateway graph — routing the tray push through the store the
// close guard depends on is how an import cycle gets built by accident.

/**
 * The status row's key per connection phase, spelled out one literal at a time.
 *
 * A template (`` `tray.status.${phase}` ``) would resolve identically at runtime
 * and read better — but `scripts/i18n-audit.mjs` harvests reachability from
 * string literals, property names and computed tails, so a key assembled from a
 * template is only "reached" if its LAST segment happens to appear somewhere
 * else in the tree. `tray.status.idle` would have been reachable by accident and
 * `tray.status.probing` not at all, and R1 deletes what it believes is dead.
 */
const STATUS_KEY: Record<ConnectionPhase, string> = {
  connecting: 'tray.status.connecting',
  error: 'tray.status.error',
  idle: 'tray.status.idle',
  probing: 'tray.status.probing',
  ready: 'tray.status.ready'
}

/**
 * Translate against an EXPLICIT locale rather than through `translateNow`.
 *
 * `translateNow` reads the runtime locale, and that is set from an effect in
 * `I18nProvider` — which runs after render, while an atom subscription fires
 * synchronously on `.set()`. So a push triggered by the locale changing would
 * render the language the app was in a moment ago, and the tray would sit one
 * switch behind for the rest of the run.
 */
function tr(locale: Locale, key: string): string {
  return translateFrom(l => TRANSLATIONS[l], locale, key, [])
}

function activeLocale(): Locale {
  return normalizeLocale($appLocale.get())
}

async function push(command: string, args: Record<string, unknown>): Promise<void> {
  if (!IS_DESKTOP) {
    return
  }

  try {
    const { invoke } = await import('@tauri-apps/api/core')

    await invoke(command, args)
  } catch {
    // No tray on this machine (`tray::install` logged the refusal), or no Tauri
    // runtime at all. The menu keeps whatever text it was built with; there is
    // nothing here worth interrupting the user for.
  }
}

async function pushLabels(locale: Locale): Promise<void> {
  await push('tray_set_labels', {
    labels: {
      hud: tr(locale, 'tray.hud'),
      quit: tr(locale, 'tray.quit'),
      show: tr(locale, 'tray.show'),
      tooltip: tr(locale, 'tray.tooltip')
    }
  })
}

async function pushStatus(phase: ConnectionPhase): Promise<void> {
  await push('tray_set_status', { status: { text: tr(activeLocale(), STATUS_KEY[phase]) } })
}

/**
 * Publish the tray's copy and keep it current.
 *
 * Called once per full app window at boot. Both subscriptions fire immediately
 * with the current value (nanostores' `subscribe` contract), so this is also the
 * initial push — no separate first-paint call to fall out of step.
 *
 * The locale subscription is what a native menu cannot do for itself: switching
 * `display.language` re-renders every React surface and leaves the tray reading
 * the language the app booted in until the next restart.
 */
export function initTray(): void {
  if (!IS_DESKTOP) {
    return
  }

  $appLocale.subscribe(locale => {
    void pushLabels(normalizeLocale(locale))
  })

  $connectionPhase.subscribe(phase => {
    void pushStatus(phase)
  })
}
