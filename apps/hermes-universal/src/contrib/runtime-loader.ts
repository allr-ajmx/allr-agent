/**
 * Runtime plugin loader — plugins as CODE, not registry edits, loaded after
 * build time. The pipeline every non-bundled plugin takes:
 *
 *   source (plain ESM js) -> [integrity check] -> bare-specifier rewrite
 *   (`@hermes/plugin-sdk` / `react*` -> live shim blobs, see sdk/runtime.ts)
 *   -> blob `import()` -> validate default HermesPlugin -> register(ctx)
 *
 * Loading the same plugin id again disposes the previous registrations first
 * (agent rewrites a plugin file -> clean reload). Failures toast + log; a
 * broken plugin can never take the app down.
 *
 * The source is whichever `PluginDisk` is in force (contrib/plugin-disk.ts): this
 * device's `desktop-plugins` tree, or the connected gateway's copy of it.
 *
 * SECURITY — this is NOT a capability boundary. A loaded plugin is evaluated
 * as ESM in the webview realm with FULL app authority: the React singleton,
 * the whole SDK (`host.request` gateway RPC, `ctx.rest`, storage, `navigate`).
 * The isolation here is *error* isolation only (ContribBoundary, isolated
 * listeners) — a plugin can't crash the app, but it can do anything the app
 * can. That's acceptable for local sources (disk files can already run code),
 * and `integrity` only proves the bytes match a hash — it does NOT sandbox.
 * A remote source (https + allowlist) must NOT reuse this pipeline as-is:
 * it needs a real boundary (iframe/worker + CSP + capability gating) before
 * it can land. The `{ integrity }` option is the transport seam, not the
 * trust seam.
 *
 * Note the gateway door is, strictly, code from another machine. It is not a
 * remote-fetch-from-the-internet path — it is the user's own backend, the same
 * one that already serves the workspace and executes their agent — but it IS a
 * trust decision, which is why it is switchable off (see plugin-disk.ts).
 */

import { installPluginSdk, sdkImportMap } from '@/sdk/runtime'
import { $connection } from '@/store/connection'
import { notifyError } from '@/store/notifications'
import { $activeProfile } from '@/store/profiles'

import { createPluginContext, type HermesPlugin } from './plugin'
import {
  $restDoorEnabled,
  type DiskEntry,
  type PluginDisk,
  resolvePluginDisk,
  REST_CONTENT_DIFF_CAP
} from './plugin-disk'
import { dropPlugin, pluginActive, type PluginKind, publishPlugin } from './plugins-store'

interface LoadOptions {
  /** Absolute plugin.js path (disk plugins) — recorded for reveal/inventory. */
  file?: string
  /** `sha256-<base64>` — verified against the source before evaluation. */
  integrity?: string
  /** Inventory bucket; the disk door is the default runtime source. */
  kind?: PluginKind
}

/** Live runtime plugins: id -> disposers (unload/reload support). */
const loaded = new Map<string, (() => void)[]>()

// Matches the specifier of a static `from '…'`, a side-effect `import '…'`, or
// a dynamic `import('…')` — anchored to import/export syntax so a bare string
// literal (e.g. `notify('react')`) is never touched.
//
// It is a regex, not a parser: a COMMENTED-OUT import still matches. That fails
// closed (the plugin gets a named "unsupported import" error rather than a
// silently ignored dependency), which is the right way round, but it will confuse
// an author who left dead import lines in the file.
const importSpecifierRe = () => /(from\s*|import\s*\(\s*|import\s+)(['"])([^'"]+)\2/g

/** Rewrite ONLY mapped import specifiers (@hermes/plugin-sdk, react*) to their
 *  live shim blob URLs — never occurrences inside strings/comments. */
function rewriteSpecifiers(source: string): string {
  const map = sdkImportMap()

  return source.replace(importSpecifierRe(), (whole, pre, quote, spec) =>
    map[spec] ? `${pre}${quote}${map[spec]}${quote}` : whole
  )
}

/** Bare import specifiers the loader can't resolve (not relative/URL, not in
 *  the SDK map). Surfaced up-front so they don't fail as a cryptic native
 *  "Failed to resolve module specifier" from the blob import. */
function unsupportedImports(source: string): string[] {
  const map = sdkImportMap()
  const bare = new Set<string>()

  for (const m of source.matchAll(importSpecifierRe())) {
    const spec = m[3]

    // Skip relative/absolute (./ ../ /) and any URL scheme (blob: http(s):).
    if (spec && !/^[./]/.test(spec) && !/^[a-z][a-z0-9+.-]*:/i.test(spec) && !map[spec]) {
      bare.add(spec)
    }
  }

  return [...bare]
}

/** SHA-256 of `source` as standard SRI base64 — the change token for a door that
 *  can't give us an mtime, and the comparison for an `integrity` option. */
async function sha256(source: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source))

  return btoa(String.fromCharCode(...new Uint8Array(digest)))
}

async function verifyIntegrity(source: string, integrity: string): Promise<boolean> {
  const [algo, expected] = integrity.split('-', 2)

  if (algo !== 'sha256' || !expected) {
    return false
  }

  // Standard SRI base64 (`sha256-<base64>`) — a base64url-encoded hash won't match.
  return (await sha256(source)) === expected
}

export function unloadRuntimePlugin(id: string): void {
  loaded.get(id)?.forEach(dispose => dispose())
  loaded.delete(id)
}

/** Evaluate + register one runtime plugin. Returns its id, or null on failure. */
export async function loadRuntimePlugin(
  source: string,
  origin: string,
  options: LoadOptions = {}
): Promise<null | string> {
  installPluginSdk()

  try {
    if (options.integrity && !(await verifyIntegrity(source, options.integrity))) {
      throw new Error(`integrity check failed for ${origin}`)
    }

    const unsupported = unsupportedImports(source)

    if (unsupported.length > 0) {
      throw new Error(
        `unsupported import${unsupported.length > 1 ? 's' : ''}: ${unsupported.join(', ')} — ` +
          `runtime plugins may only import @hermes/plugin-sdk and react`
      )
    }

    const url = URL.createObjectURL(new Blob([rewriteSpecifiers(source)], { type: 'text/javascript' }))

    let mod: { default?: HermesPlugin }

    try {
      mod = await import(/* @vite-ignore */ url)
    } finally {
      URL.revokeObjectURL(url)
    }

    const plugin = mod.default

    if (!plugin?.id || typeof plugin.register !== 'function') {
      throw new Error(`${origin} has no valid default HermesPlugin export`)
    }

    const record = {
      id: plugin.id,
      name: plugin.name ?? plugin.id,
      kind: options.kind ?? 'disk',
      file: options.file
    }

    const activate = () => {
      // Reload = dispose the previous incarnation, then register fresh.
      unloadRuntimePlugin(plugin.id)
      const disposers: (() => void)[] = []
      plugin.register(createPluginContext(plugin.id, dispose => disposers.push(dispose)))
      loaded.set(plugin.id, disposers)
      publishPlugin({ ...record, status: 'loaded' })
    }

    publishPlugin({ ...record, status: 'disabled' }, { activate, deactivate: () => unloadRuntimePlugin(plugin.id) })

    // A disabled plugin still inventories (settings shows it, toggle
    // reactivates via the handle above) — it just never registers.
    if (pluginActive(plugin.id, plugin.defaultEnabled ?? true)) {
      activate()
    }

    return plugin.id
  } catch (error) {
    console.error(`[plugins] runtime load failed (${origin})`, error)
    notifyError(error, `Plugin "${origin}" failed to load`)
    publishPlugin({
      id: origin,
      name: origin,
      kind: options.kind ?? 'disk',
      file: options.file,
      status: 'error',
      error: error instanceof Error ? error.message : String(error)
    })

    return null
  }
}

// ---------------------------------------------------------------------------
// The disk plugin door (agent- or user-written plugin.js). SELF-MAINTAINING —
// no reload ceremony:
//  - each tick compares every folder's change token, so saving the file hot
//    reloads the plugin in place;
//  - folder membership is reconciled on the same tick, so a new folder loads and
//    a deleted one unloads.
// Desktop watches the fs and keeps a 5s poll as its fallback; universal polls
// only (2s local / 10s gateway — see plugin-disk.ts). A native watcher would
// need a new Rust dependency and Android inotify semantics that only a device
// build can validate: FIXME(MJX-53/watcher).
//
// Panes land via placement adoption and STAY where the user drags them — the
// tree treats not-yet-loaded pane ids as hidden, so boot and reload are
// collapse -> appear, never a placeholder flash.
// ---------------------------------------------------------------------------

interface DiskPlugin {
  file: string
  /** Loaded plugin id (null while broken — kept so a fixing save reloads). */
  id: null | string
  /** Last-seen change token: the door's `stamp`, or a source hash when it has
   *  none. Empty until first load. */
  stamp: string
}

const disk = new Map<string, DiskPlugin>()
let watching = false
let scanning = false
let timer: null | number = null
/** The door the running poll belongs to, so a door change restarts it. */
let activeDoor: null | PluginDisk = null

/** Tear down every loaded disk plugin — used when the door itself changes
 *  (profile switch, gateway-door toggle), since the inventory then describes a
 *  different filesystem entirely. */
function unloadAllDiskPlugins(): void {
  for (const [name, record] of disk) {
    if (record.id) {
      unloadRuntimePlugin(record.id)
      dropPlugin(record.id)
    }

    dropPlugin(name)
  }

  disk.clear()
}

async function loadDiskPlugin(door: PluginDisk, entry: DiskEntry, stamp: string): Promise<void> {
  const record = disk.get(entry.name)
  const prevId = record?.id

  try {
    const source = await door.read(entry)
    const id = await loadRuntimePlugin(source, entry.name, { file: entry.file })

    // A hot-edit that changes `plugin.id`: loadRuntimePlugin only disposes the
    // NEW id, so unload the previous incarnation here or its contributions +
    // inventory row orphan.
    if (id && prevId && prevId !== id) {
      unloadRuntimePlugin(prevId)
      dropPlugin(prevId)
    }

    if (record) {
      record.id = id ?? record.id
      record.stamp = stamp
    }

    // A fixing save under a different plugin id — drop the folder-named
    // error record so the inventory shows one row, not a ghost.
    if (id && id !== entry.name) {
      dropPlugin(entry.name)
    }
  } catch {
    // File vanished mid-read — the next scan reconciles.
  }
}

/**
 * Reconcile the inventory against the door: load new folders, reload changed
 * ones, unload vanished ones.
 *
 * `door` is injectable so tests can drive the whole reconciliation loop without
 * Tauri or a gateway.
 */
export async function scanDiskPlugins(door?: PluginDisk): Promise<void> {
  // Re-entrancy guard: the poll must not overlap a slow in-flight scan (reads
  // and loads can exceed the interval).
  if (scanning) {
    return
  }

  scanning = true

  try {
    const active = door ?? (await resolvePluginDisk())

    if (!active) {
      return
    }

    const entries = await active.list()
    const seen = new Set<string>()

    // Hashing every folder's source per tick is the gateway door's only way to
    // spot an edit, and it costs one HTTP read each. Past the cap, reconcile
    // MEMBERSHIP only — a new or deleted folder still lands, but an in-place
    // edit needs the manual Rescan.
    const diffContent = active.hashToDetectChange && entries.length <= REST_CONTENT_DIFF_CAP

    for (const entry of entries) {
      seen.add(entry.name)

      const known = disk.get(entry.name)

      if (!known) {
        disk.set(entry.name, { file: entry.file, id: null, stamp: '' })
        await loadDiskPlugin(active, entry, await changeToken(active, entry, true))

        continue
      }

      // Cheap path: the door gave us a token, so compare it.
      if (!active.hashToDetectChange) {
        if (entry.stamp !== known.stamp) {
          await loadDiskPlugin(active, entry, entry.stamp)
        }

        continue
      }

      if (!diffContent) {
        continue
      }

      const stamp = await changeToken(active, entry, false)

      if (stamp && stamp !== known.stamp) {
        await loadDiskPlugin(active, entry, stamp)
      }
    }

    // Folder deleted -> plugin gone, cleanly (inventory row included).
    for (const [name, record] of disk) {
      if (seen.has(name)) {
        continue
      }

      if (record.id) {
        unloadRuntimePlugin(record.id)
        dropPlugin(record.id)
      }

      dropPlugin(name)
      disk.delete(name)
    }
  } catch {
    // No plugin root, or no gateway yet — nothing to reconcile.
  } finally {
    scanning = false
  }
}

/** The change token to record for `entry`: the door's own stamp when it has one,
 *  else a hash of the current source. `optimistic` skips the extra read for a
 *  brand-new folder (loadDiskPlugin is about to read it anyway). */
async function changeToken(door: PluginDisk, entry: DiskEntry, optimistic: boolean): Promise<string> {
  if (!door.hashToDetectChange) {
    return entry.stamp
  }

  if (optimistic) {
    // Recorded on the next tick; a first load doesn't need a token to compare.
    return ''
  }

  try {
    return await sha256(await door.read(entry))
  } catch {
    return ''
  }
}

/** Manual rescan (the "Reload plugins" command / the settings Rescan button). */
export const discoverRuntimePlugins = (): void => void scanDiskPlugins()

/** Start the self-maintaining disk door: initial scan, then a visibility-gated
 *  poll at the door's own cadence. Idempotent. */
export function watchRuntimePlugins(): void {
  if (watching) {
    return
  }

  watching = true

  const start = async () => {
    const door = await resolvePluginDisk()
    activeDoor = door

    if (timer !== null) {
      window.clearInterval(timer)
      timer = null
    }

    if (!door) {
      return
    }

    await scanDiskPlugins(door)

    timer = window.setInterval(() => {
      // A background tab shouldn't poll a filesystem — or worse, the gateway.
      if (document.visibilityState !== 'visible') {
        return
      }

      void scanDiskPlugins(activeDoor ?? undefined)
    }, door.pollMs)
  }

  void start()

  // The door itself can change under us: a profile switch repoints the local
  // root, and the gateway-door toggle swaps which filesystem we're reading. Both
  // describe a different set of files, so drop everything and rescan rather than
  // diffing across them.
  const restart = () => {
    unloadAllDiskPlugins()
    void start()
  }

  $restDoorEnabled.listen(restart)

  // Only the PROFILE matters here, not every connection change — a plain
  // reconnect reads the same files, and unloading every plugin for it would make
  // a dropped socket look like a plugin bug.
  let lastProfile = doorProfile()

  const onProfileChange = () => {
    const next = doorProfile()

    if (next !== lastProfile) {
      lastProfile = next
      restart()
    }
  }

  $connection.listen(onProfileChange)
  $activeProfile.listen(onProfileChange)
}

function doorProfile(): null | string {
  return $connection.get()?.profile ?? $activeProfile.get() ?? null
}

/** Test seam: reset the module's disk state between cases. */
export function __resetRuntimeLoaderForTests(): void {
  unloadAllDiskPlugins()
  loaded.clear()

  if (timer !== null) {
    window.clearInterval(timer)
    timer = null
  }

  watching = false
  scanning = false
  activeDoor = null
}
