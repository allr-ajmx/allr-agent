import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification'

import { Codecs, persistentAtom } from '@/lib/persisted'

// Native OS notifications (tauri-plugin-notification), separate from the in-app
// toast feed in notifications.ts. Adapted from apps/desktop/src/store/
// native-notifications.ts: the desktop `window.hermesDesktop.notify` bridge is
// swapped for the Tauri plugin, and the multi-session gating is simplified —
// mobile has a single active conversation, so "fire when the app is
// backgrounded" is the whole rule. Per-kind toggles + throttle are kept.

export type NativeNotificationKind = 'approval' | 'backgroundDone' | 'input' | 'plugin' | 'turnDone' | 'turnError'

export const NATIVE_NOTIFICATION_KINDS: readonly NativeNotificationKind[] = [
  'approval',
  'input',
  'turnDone',
  'turnError',
  'backgroundDone',
  'plugin'
]

export interface NativeNotificationPrefs {
  enabled: boolean
  kinds: Record<NativeNotificationKind, boolean>
}

const DEFAULT_PREFS: NativeNotificationPrefs = {
  enabled: true,
  kinds: { approval: true, backgroundDone: true, input: true, plugin: true, turnDone: true, turnError: true }
}

// A stored blob predates every kind added after it was written (and localStorage
// is untrusted anyway), so merge onto the defaults rather than trusting the
// parsed shape: without this a newly added kind reads back `undefined` and is
// silently off for everyone who has ever touched these prefs. Mirrors desktop's
// `readPrefs`.
function sanitizePrefs(value: unknown): NativeNotificationPrefs {
  const parsed = (value ?? {}) as Partial<NativeNotificationPrefs>
  const kinds = { ...DEFAULT_PREFS.kinds }

  for (const kind of NATIVE_NOTIFICATION_KINDS) {
    const stored = parsed.kinds?.[kind]

    if (typeof stored === 'boolean') {
      kinds[kind] = stored
    }
  }

  return { enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULT_PREFS.enabled, kinds }
}

export const $nativeNotifyPrefs = persistentAtom<NativeNotificationPrefs>(
  'hermes.native-notifications',
  DEFAULT_PREFS,
  Codecs.json<NativeNotificationPrefs>(sanitizePrefs)
)

export function setNativeNotifyEnabled(enabled: boolean) {
  $nativeNotifyPrefs.set({ ...$nativeNotifyPrefs.get(), enabled })
}

export function setNativeNotifyKind(kind: NativeNotificationKind, on: boolean) {
  const prev = $nativeNotifyPrefs.get()
  $nativeNotifyPrefs.set({ ...prev, kinds: { ...prev.kinds, [kind]: on } })
}

// De-dupe replayed events for the same kind+session. Self-evicting: entries
// older than the window are pruned on every dispatch, so the map can't grow.
const THROTTLE_MS = 1000
const lastFiredAt = new Map<string, number>()

function throttled(key: string, now: number): boolean {
  for (const [k, at] of lastFiredAt) {
    if (now - at >= THROTTLE_MS) {
      lastFiredAt.delete(k)
    }
  }

  if (lastFiredAt.has(key)) {
    return true
  }

  lastFiredAt.set(key, now)

  return false
}

// "Backgrounded" = the app isn't on screen. On the Android WebView `document.hidden`
// flips when the app is sent to the background; `hasFocus` covers the rest.
function isBackgrounded(): boolean {
  if (typeof document === 'undefined') {
    return false
  }

  if (document.hidden) {
    return true
  }

  return typeof document.hasFocus === 'function' && !document.hasFocus()
}

// Cache the granted state so we only prompt once per session.
let permissionGranted: boolean | null = null

async function ensurePermission(): Promise<boolean> {
  if (permissionGranted !== null) {
    return permissionGranted
  }

  try {
    let granted = await isPermissionGranted()

    if (!granted) {
      granted = (await requestPermission()) === 'granted'
    }

    permissionGranted = granted

    return granted
  } catch {
    // No Tauri host (web dev) or the plugin is unavailable.
    permissionGranted = false

    return false
  }
}

export interface NativeNotificationInput {
  kind: NativeNotificationKind
  title: string
  body?: string
  sessionId?: null | string
  silent?: boolean
  /**
   * Extra throttle/dedupe discriminator for session-less notifications (e.g. the
   * plugin id), so unrelated emitters of the same kind don't collapse into one
   * another.
   */
  tag?: string
}

export function dispatchNativeNotification(input: NativeNotificationInput): void {
  const prefs = $nativeNotifyPrefs.get()

  if (!prefs.enabled || !prefs.kinds[input.kind]) {
    return
  }

  if (!isBackgrounded()) {
    return
  }

  if (throttled(`${input.kind}:${input.sessionId ?? input.tag ?? ''}`, Date.now())) {
    return
  }

  void ensurePermission().then(granted => {
    if (!granted) {
      return
    }

    try {
      sendNotification({ title: input.title, body: input.body, silent: input.silent })
    } catch {
      // Best-effort: a delivery failure shouldn't surface to the user.
    }
  })
}

// -- the plugin door (`ctx.os.notify`) ----------------------------------------

export interface PluginNativeNotificationInput {
  title: string
  body?: string
  silent?: boolean
}

/** Native OS notification on behalf of a plugin. One "Plugin notifications"
 *  preference gates all plugins; the plugin id keys throttling/dedupe so two
 *  plugins can't collapse each other's notifications. Fires only while the user
 *  is away from Hermes — the in-app toast (`host.notify`) covers the foreground
 *  case. */
export function dispatchPluginNativeNotification(pluginId: string, input: PluginNativeNotificationInput): void {
  dispatchNativeNotification({ ...input, kind: 'plugin', tag: pluginId })
}

// Settings "send test" — bypasses the background/throttle gating. Returns whether
// the OS accepted it so the panel can flag a silent permission failure.
export async function sendTestNativeNotification(title: string, body: string): Promise<boolean> {
  if (!(await ensurePermission())) {
    return false
  }

  try {
    sendNotification({ title, body })

    return true
  } catch {
    return false
  }
}
