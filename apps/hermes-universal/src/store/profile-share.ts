/**
 * Profile share: export/import a profile as a portable bundle.
 *
 * The archive is the CLI's own `hermes profile export` tar.gz (config, skills,
 * SOUL.md, cron — credentials always excluded), plus one app-authored file at
 * the root: `desktop.json`, the appearance/interface overlay (skin + mode, any
 * user-theme definitions the skin needs, the profile rail color, the layout
 * tree). A CLI import of the same archive simply carries the file along; this
 * import applies it, so the receiver gets the whole look — theme, layout,
 * skills — as a ready-to-use profile.
 *
 * Ported from desktop `src/store/profile-share.ts` (6e7eafc7e8). Two seams
 * differ, both deliberately:
 *
 *   • APPEARANCE IS GLOBAL HERE. Desktop keeps skin/mode as per-profile prefs
 *     (`skinPref.resolve(key)`); universal has one global skin + mode
 *     (themes/context.tsx says so in as many words). So the overlay snapshots
 *     and assigns the global choice. `profileColor` is genuinely per-profile in
 *     both, and is keyed as such.
 *
 *   • PATHS ARE ON THE BACKEND, AND THE BACKEND IS USUALLY NOT THIS MACHINE.
 *     Desktop can use a native save/open dialog because "the native dialogs and
 *     the backend share the filesystem for local and pooled backends". For
 *     universal the gateway owns the disk (see lib/desktop-fs), so export lets
 *     the BACKEND name the file (under `HERMES_HOME/profile-exports`) and
 *     reports the path, and import picks through the REMOTE file picker. A
 *     native dialog here would hand the backend a path on the wrong machine.
 */

import { isLayoutNode, normalize } from '@/components/pane-shell/tree/model'
import { $layoutTree, adoptImportedTree } from '@/components/pane-shell/tree/store'
import { translateNow } from '@/i18n'
import { selectRemotePaths } from '@/lib/desktop-fs'
import { exportProfileArchive, importProfileArchive, type ProfileDesktopOverlay } from '@/lib/gateway-rest'
import { $mode, $skin, type ThemeMode } from '@/themes/context'
import { BUILTIN_THEMES } from '@/themes/presets'
import type { DesktopTheme } from '@/themes/types'
import { $userThemes, installUserTheme, resolveTheme } from '@/themes/user-themes'

import { notify, notifyError } from './notifications'
import { $activeGatewayProfile, $profileColors, normalizeProfileKey, setProfileColor } from './profile'
import { refreshProfiles, setActiveProfile } from './profiles'

/** Filename of the overlay inside the archive (profile root). Kept as
 *  `desktop.json` — it is a cross-app contract, not an app name. */
export const DESKTOP_OVERLAY_FILENAME = 'desktop.json'

const OVERLAY_VERSION = 1

/**
 * Snapshot the appearance/interface for `profile` into the overlay. The layout
 * tree is global (one window layout, not per-profile) — it rides along so the
 * receiver can opt into the sender's whole interface.
 */
export function buildDesktopOverlay(profile: string): ProfileDesktopOverlay {
  const key = normalizeProfileKey(profile)
  const skin = $skin.get()

  // Bundle the full definition of any non-built-in theme the skin points at, so
  // the receiver's picker can resolve it. Built-ins resolve by name.
  const themes: Record<string, unknown> = {}
  const userTheme = BUILTIN_THEMES[skin] ? undefined : $userThemes.get()[skin]

  if (userTheme) {
    themes[userTheme.name] = userTheme
  }

  return {
    version: OVERLAY_VERSION,
    skin,
    mode: $mode.get(),
    ...(Object.keys(themes).length ? { themes } : {}),
    profileColor: $profileColors.get()[key] ?? null,
    // Null in a satellite window, which holds no tree of its own — better an
    // absent layout than someone else's.
    layoutTree: $layoutTree.get()
  }
}

/** Export `profile` (backend archive + appearance overlay). Returns the archive
 *  path ON THE BACKEND. */
export async function exportProfileBundle(profile: string, output?: string): Promise<string> {
  const overlay = buildDesktopOverlay(profile)

  const { archive } = await exportProfileArchive(profile, {
    extraFiles: { [DESKTOP_OVERLAY_FILENAME]: JSON.stringify(overlay, null, 2) },
    output
  })

  return archive
}

const isThemeMode = (value: unknown): value is ThemeMode => value === 'light' || value === 'dark' || value === 'system'

/**
 * Apply an imported overlay: install bundled themes, adopt the skin + mode,
 * assign the new profile's rail color, and (when present) adopt the sender's
 * layout tree. Every step is independent and best-effort — a malformed half
 * never blocks the rest, and a missing overlay is a plain CLI-exported archive
 * (no-op).
 */
export function applyDesktopOverlay(profile: string, overlay: null | ProfileDesktopOverlay | undefined): void {
  if (!overlay || typeof overlay !== 'object') {
    return
  }

  const key = normalizeProfileKey(profile)

  // 1. Bundled theme definitions. installUserTheme validates shape and refuses
  //    built-in collisions; a bad entry just doesn't install.
  for (const theme of Object.values(overlay.themes ?? {})) {
    try {
      installUserTheme(theme as DesktopTheme)
    } catch {
      // Invalid/colliding theme — the skin assignment below falls back.
    }
  }

  // 2. Appearance. Only assign a skin that actually resolves, so the pref never
  //    points at nothing.
  if (typeof overlay.skin === 'string' && resolveTheme(overlay.skin)) {
    $skin.set(overlay.skin)
  }

  if (isThemeMode(overlay.mode)) {
    $mode.set(overlay.mode)
  }

  // 3. Rail color.
  if (typeof overlay.profileColor === 'string' && overlay.profileColor) {
    setProfileColor(key, overlay.profileColor)
  }

  // 4. Layout tree — global by design (one window layout). Normalized through
  //    the same canonicalizer the boot load uses; a null result means the tree
  //    was junk, so the current layout stays.
  //
  //    `adoptImportedTree` rather than `applyTree`: this tree was authored by
  //    the ARCHIVE, not by the window unpacking it, and on Android that window
  //    is the Profiles Activity — which does not own the persisted layout, so a
  //    plain `applyTree` had its write swallowed while still clearing the user's
  //    pane sizes and pins. It is also what tells the other live windows to stop
  //    holding the layout they booted with (MJXHRM-420).
  if (overlay.layoutTree != null && isLayoutNode(overlay.layoutTree)) {
    const tree = normalize(overlay.layoutTree)

    if (tree) {
      adoptImportedTree(tree)
    }
  }
}

/** Import an archive, apply its overlay, return the new profile name. */
export async function importProfileBundle(archive: string, name?: string): Promise<string> {
  const result = await importProfileArchive(archive, name)
  applyDesktopOverlay(result.name, result.desktop)

  return result.name
}

/** The profile the export pickers should default to — the active one. */
export function activeProfileKey(): string {
  return normalizeProfileKey($activeGatewayProfile.get())
}

// ── Dialog-driven flows ──────────────────────────────────────────────────────
// One store function per user verb, so every door (the Profiles overlay's row
// menu, its header button, any future menu item) funnels through the same
// wiring. Toasts via the shared notification store; strings via translateNow so
// the flows stay callable from non-React surfaces.

const ARCHIVE_FILTERS = [{ extensions: ['tar.gz', 'tgz'], name: 'Hermes profile' }]

/**
 * Export `profile` (default: the active one). The BACKEND chooses the location
 * — `HERMES_HOME/profile-exports` — and the resulting path is surfaced in the
 * toast, because on a remote gateway the archive is written on that machine and
 * a local save dialog would be a lie.
 *
 * Returns the archive path, or null when the export failed.
 */
export async function runExportProfileFlow(profile?: string): Promise<null | string> {
  const target = normalizeProfileKey(profile ?? activeProfileKey())

  try {
    const archive = await exportProfileBundle(target)
    notify({ kind: 'success', title: translateNow('profiles.exported'), message: archive })

    return archive
  } catch (error) {
    notifyError(error, translateNow('profiles.failedExport'))

    return null
  }
}

/**
 * Pick an archive on the BACKEND filesystem and import it as a new profile,
 * landing the user in it. Returns the new profile name, or null when cancelled
 * or failed.
 */
export async function runImportProfileFlow(): Promise<null | string> {
  const paths = await selectRemotePaths({
    filters: ARCHIVE_FILTERS,
    multiple: false,
    title: translateNow('profiles.importProfile')
  })

  const archive = paths?.[0]

  if (!archive) {
    return null
  }

  try {
    const name = await importProfileBundle(archive)
    notify({ kind: 'success', title: translateNow('profiles.imported'), message: name })
    // Same landing as the create dialog's onCreated: refresh the list, then
    // switch the app into the new profile.
    await refreshProfiles()
    setActiveProfile(name)

    return name
  } catch (error) {
    notifyError(error, translateNow('profiles.failedImport'))

    return null
  }
}
