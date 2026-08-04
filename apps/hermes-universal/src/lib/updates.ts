import { openExternalLink } from '@/lib/external-link'
import { IS_TAURI } from '@/lib/platform'

// App update checks (MJX-6). The version lookup itself runs in Rust
// (src-tauri/src/updates.rs) — the webview CSP is `connect-src 'self' ipc:`, so
// JS can't reach the GitHub API / Play listing / iTunes Lookup at all. This is
// just the typed IPC seam, shaped like `openExternalLink` above it: lazily
// imported and guarded by IS_TAURI so plain-web dev and vitest degrade to null
// instead of throwing on a missing runtime.

/** Which authority answered the check. `disabled` = built without the
 *  `update-checks` cargo feature (the default), so no network call was made. */
export type UpdateSource = 'appstore' | 'disabled' | 'github' | 'play'

/** Why we don't know the published version. Absent on a successful check. */
export type UpdateReason = 'checks_disabled' | 'unparsed' | 'unreachable'

export interface UpdateStatus {
  source: UpdateSource
  currentVersion: string
  latestVersion: null | string
  updateAvailable: boolean
  /** Release asset URL, or a `market://` / `itms-apps://` store deep link. */
  downloadUrl: null | string
  /** Human-facing page for the same thing (release page / store listing). */
  notesUrl: null | string
  checkedAtMs: number
  reason: null | UpdateReason
}

/**
 * Ask the native side whether a newer build is published. Results are cached in
 * Rust for 6h; `force` bypasses that. Resolves to null off Tauri, or if the
 * command is unavailable — callers then render version-only.
 */
export async function checkAppUpdate(force = false): Promise<null | UpdateStatus> {
  if (!IS_TAURI) {
    return null
  }

  try {
    const { invoke } = await import('@tauri-apps/api/core')

    return await invoke<UpdateStatus>('update_check', { force })
  } catch {
    return null
  }
}

/**
 * Open the update destination. Store deep links (`market://`, `itms-apps://`)
 * must go through the native opener — window.open can't handle them — so the
 * https fallback is only used when there is no Tauri runtime at all.
 */
export async function openAppDownload(url: string, fallback?: null | string): Promise<void> {
  if (IS_TAURI) {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('update_open_download', { url, fallback: fallback ?? null })

      return
    } catch {
      // Native command unavailable — fall through.
    }
  }

  const webUrl = /^https?:\/\//i.test(url) ? url : (fallback ?? url)

  await openExternalLink(webUrl)
}
