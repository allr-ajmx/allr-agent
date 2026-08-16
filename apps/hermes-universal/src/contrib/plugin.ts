/**
 * The plugin authoring contract. A plugin is a file that default-exports a
 * `HermesPlugin`; it never touches the registry directly — it receives a
 * scoped `PluginContext` whose `register` auto-tags provenance
 * (`source: 'plugin:<id>'`) and namespaces the contribution id
 * (`<id>:<localId>`), so authors write plain contributions and collisions
 * between plugins are impossible.
 *
 * Bundled plugins live in `src/plugins/<name>/plugin.tsx` and are discovered by
 * `discoverBundledPlugins()` (contrib/plugins.ts) — no import, no registry edit.
 * Runtime-loaded plugins (disk / gateway) drive the SAME contract through
 * contrib/runtime-loader.ts.
 *
 * SECURITY: this is error isolation, not a capability boundary. A plugin runs in
 * the webview realm with the app's full authority; the id scoping below prevents
 * ACCIDENTAL collisions, not deliberate reach.
 */

import { toTileContribution } from '@/components/pane-shell/tile/registry'
import type { Tile } from '@/components/pane-shell/tile/types'
import { pluginRest, type PluginRestOptions } from '@/hermes'
import { createPluginI18n, type PluginI18n } from '@/i18n'
import { writeClipboardText } from '@/lib/clipboard'
import { tryOpenExternalLink } from '@/lib/external-link'
import { pluginSocket } from '@/lib/plugin-transport'
import { tryRevealPathInFileManager } from '@/lib/reveal-path'
import { readKey, writeKey } from '@/lib/storage'
import { dispatchPluginNativeNotification, type PluginNativeNotificationInput } from '@/store/native-notifications'

import { registry } from './registry'
import type { Contribution } from './types'

export type { PluginRestOptions } from '@/hermes'
export type { PluginNativeNotificationInput } from '@/store/native-notifications'

/** A contribution as a plugin author writes it — provenance + id scoping are
 *  the host's job, so those fields are off-limits here. */
export type PluginContribution = Omit<Contribution, 'source' | 'id'> & { id: string }

/** A tile as a plugin declares it: `source` is stamped by the context and `id`
 *  is namespaced, so neither is the author's to set. */
export type PluginTile = Omit<Tile, 'source'>

/** Namespaced JSON persistence (the VS Code `globalState` analog). Keys live
 *  under `hermes.plugin.<id>.` — plugins can't read or clobber each other. */
export interface PluginStorage {
  get<T>(key: string, fallback: T): T
  set(key: string, value: unknown): void
  remove(key: string): void
}

/** The curated OS door — every way a plugin reaches outside the app window, in
 *  one attributed namespace. The desktop app's identical contract sits over the
 *  Electron preload bridge; here each member sits over the Tauri capability that
 *  matches it. Every member resolves a result instead of throwing when the
 *  capability can't apply (plain-web dev, Android, an older shell), so callers
 *  branch on the return value rather than sniffing the platform. */
export interface PluginOs {
  /** Native OS notification, attributed to this plugin. Gated by Settings ▸
   *  Notifications ▸ "Plugin notifications" and fires only while the user is
   *  away from Hermes — use `host.notify` for the in-app toast. Throttled per
   *  plugin; reserve it for genuinely notable events. */
  notify: (input: PluginNativeNotificationInput) => void
  /** Open a URL with the OS default handler (browser, mail client, custom
   *  schemes like `spotify:`). Resolves false when the shell can't. */
  openExternal: (url: string) => Promise<boolean>
  /** Reveal a path in the OS file manager (Finder / Explorer). Resolves false
   *  when unavailable — including on mobile, which has no file manager to
   *  reveal into. */
  revealPath: (path: string) => Promise<boolean>
  /** Write text to the system clipboard. Resolves false when unavailable. */
  writeClipboard: (text: string) => Promise<boolean>
}

export interface PluginContext {
  /** The resolved plugin source tag, e.g. `'plugin:cost-meter'`. */
  readonly source: string
  /** Register one contribution (id namespaced, source stamped). */
  register: (c: PluginContribution) => () => void
  /** Contribute a layout TILE — the typed door for `area: 'panes'`. Prefer it
   *  over `register({ area: PANES_AREA, … })`: a tile's chrome and sizing are
   *  declared fields here instead of an untyped `data` blob, and only this path
   *  can express fields added later (the mount lifecycle). */
  registerTile: (tile: PluginTile) => () => void
  /** Register several at once; the returned disposer removes all of them. */
  registerMany: (cs: PluginContribution[]) => () => void
  /** Register an arbitrary cleanup to run on unload/disable — for side effects
   *  that aren't contributions or sockets (store subscriptions, timers). Runs
   *  alongside every other disposer when the plugin deactivates. */
  onDispose: (fn: () => void) => void
  /** REST to this plugin's own backend namespace (`/api/plugins/<id>`); `path`
   *  is relative ('/board'). The sanctioned door for a plugin that ships a
   *  `plugin_api.py` — profile-aware, namespace-scoped by construction. Use
   *  `host.request` for gateway JSON-RPC. */
  rest: <T>(path: string, opts?: PluginRestOptions) => Promise<T>
  /** Live twin of `rest`: a WebSocket to this plugin's own namespace
   *  ('/events'), JSON frames to `onMessage`, auto-reconnect, disposer
   *  returned. Authenticates on EVERY gateway mode (a ws-ticket where there is
   *  no `token` — see lib/plugin-transport), and FOLLOWS the connection like
   *  `rest` does: call it whenever you like — before the app has dialled is
   *  normal, since plugins register first — and it re-homes itself onto the
   *  gateway the user switches to. Still treat it as an accelerator over your
   *  polling and never a replacement: a socket can always drop, a ticket mint
   *  can fail on an expired session, and neither is reported back to you. */
  socket: (path: string, onMessage: (data: unknown) => void) => () => void
  /** The curated OS door: native notification, open-external, reveal-in-file-
   *  manager, clipboard — attributed to this plugin, result-shaped (never throws
   *  for a missing capability). */
  os: PluginOs
  /** Plugin-scoped persistence. */
  storage: PluginStorage
  /** Plugin-scoped i18n: ship + register locale bundles under this plugin,
   *  resolved against the app's active locale — no core `en.ts` edit. */
  i18n: PluginI18n
}

export interface HermesPlugin {
  /** Stable slug — becomes the `plugin:<id>` source and the id namespace. */
  id: string
  /** Human name for settings / about UI. */
  name?: string
  /** One line on what the plugin does, shown under its name in Settings ▸
   *  Plugins. Write it for a user deciding whether to switch this on. */
  description?: string
  /** Registers on load when the user hasn't chosen (default true). Set false
   *  for opt-in plugins: they inventory in Settings ▸ Plugins, off until the
   *  user flips the switch. */
  defaultEnabled?: boolean
  /** Called once at load; wire contributions through `ctx`. */
  register: (ctx: PluginContext) => void
}

function createPluginStorage(pluginId: string): PluginStorage {
  const scoped = (key: string) => `hermes.plugin.${pluginId}.${key}`

  return {
    get(key, fallback) {
      const raw = readKey(scoped(key))

      if (raw === null) {
        return fallback
      }

      try {
        return JSON.parse(raw)
      } catch {
        return fallback
      }
    },
    set: (key, value) => writeKey(scoped(key), JSON.stringify(value)),
    remove: key => writeKey(scoped(key), null)
  }
}

// Never throws for a missing capability: this SDK runs in the Tauri webview on
// desktop, in the Android WebView, and in a plain browser during dev — three
// hosts with three different answers for each door. So every door degrades to a
// false result the plugin branches on, and a plugin written against the desktop
// app's `ctx.os` runs here unmodified.
function createPluginOs(pluginId: string): PluginOs {
  const attempt = async (run: () => Promise<unknown>): Promise<boolean> => {
    try {
      await run()

      return true
    } catch {
      return false
    }
  }

  return {
    notify: input => {
      try {
        dispatchPluginNativeNotification(pluginId, input)
      } catch {
        // A notification the OS won't take must not break the plugin's caller.
      }
    },
    // The app's own native door (`open_external`), in its result-shaped form.
    //
    // NOT the opener plugin's JS `openUrl`: `opener:allow-open-url` enables that
    // command "without any pre-configured scope", and the plugin refuses every
    // url that no scope entry matches — with an empty allow-list that is ALL of
    // them, on every platform. Routing a plugin through it made `openExternal`
    // resolve `false` always, which this contract renders as "the platform can't
    // do this" rather than as the bug it was. `lib/external-link` explains the
    // ACL in full.
    openExternal: url => tryOpenExternalLink(url),
    revealPath: path => tryRevealPathInFileManager(path),
    // The app's single clipboard write seam (@/lib/clipboard), which throws only
    // when BOTH the OS plugin and the engine refuse — WebKitGTK gates the async
    // Clipboard API more tightly than Chromium does, and that refusal is what
    // `false` means here.
    writeClipboard: text => attempt(() => writeClipboardText(text))
  }
}

/** Build the scoped context handed to a plugin's `register`. `onDispose`
 *  receives every registration's disposer (the loader's unload/reload hook). */
export function createPluginContext(pluginId: string, onDispose?: (dispose: () => void) => void): PluginContext {
  const source = `plugin:${pluginId}`
  const scope = (c: PluginContribution): Contribution => ({ ...c, id: `${pluginId}:${c.id}`, source })

  const scopeTile = (tile: PluginTile): Contribution => ({
    ...toTileContribution({ ...tile, source }),
    id: `${pluginId}:${tile.id}`
  })

  const track = (dispose: () => void) => {
    onDispose?.(dispose)

    return dispose
  }

  return {
    source,
    register: c => track(registry.register(scope(c))),
    registerTile: tile => track(registry.register(scopeTile(tile))),
    registerMany: cs => track(registry.registerMany(cs.map(scope))),
    onDispose: fn => void track(fn),
    rest: <T>(path: string, opts?: PluginRestOptions) => pluginRest<T>(pluginId, path, opts),
    socket: (path, onMessage) => track(pluginSocket(pluginId, path, onMessage)),
    os: createPluginOs(pluginId),
    storage: createPluginStorage(pluginId),
    i18n: createPluginI18n(pluginId, track)
  }
}
