/**
 * `@tauri-apps/api/core`, stubbed for the browser.
 *
 * Storybook runs the app's components in a plain browser tab, where there is no
 * Tauri runtime and `invoke` rejects. Aliasing the FOUR `@tauri-apps/*` entry
 * points (this file, `event`, `app`, and the plugin no-op) neutralises every
 * consumer at once — 36 modules import `api/core` alone — which is far less
 * fragile than stubbing the ~15 `@/store/*` and `@/lib/*` modules that sit on
 * top of them.
 *
 * This also has to beat the app's OWN alias: `vite.config.ts` points
 * `@tauri-apps/api/core` at `src/observability/auto/tauri-core.ts` whenever
 * `NODE_ENV !== 'production'`, which is exactly the Storybook dev case. Both
 * that specifier and its `@tauri-apps/api-real/core` escape hatch are aliased
 * here in `.storybook/main.ts`, so neither path can reach the real module.
 */

/** Commands whose return value something actually reads. Anything not listed
 *  resolves `undefined`, which every fire-and-forget call site tolerates. */
const RESPONSES: Record<string, unknown> = {
  // `lib/surface.ts` — the HUD/satellite grant. `null` means "not a satellite",
  // which is what the composer wants in every story including the HUD one (the
  // HUD story supplies its own wrapper markup rather than a real grant).
  plugin_surface_grant: null,
  // `store/windows.ts` — no second webview in a browser tab.
  window_supports_multiple: false
}

export function invoke<T>(cmd: string, args?: unknown): Promise<T> {
  // Logged rather than silent: an unstubbed command that a story genuinely
  // needed is otherwise invisible until the UI renders subtly wrong.
  console.debug('[storybook] invoke', cmd, args)

  return Promise.resolve(RESPONSES[cmd] as T)
}

export function convertFileSrc(filePath: string): string {
  return filePath
}

export function isTauri(): boolean {
  return false
}

/**
 * Tauri streams multi-message results (PTY output, download progress) through
 * this. Nothing in a story drives one, so it only has to construct and hold an
 * `onmessage` without throwing.
 */
export class Channel<T = unknown> {
  id = 0
  onmessage: ((message: T) => void) | null = null

  toJSON(): string {
    return `__CHANNEL__:${this.id}`
  }
}

export class Resource {
  readonly rid: number = 0

  async close(): Promise<void> {}
}

export function transformCallback(callback?: (response: unknown) => void): number {
  void callback

  return 0
}

export const SERIALIZE_TO_IPC_FN = '__TAURI_TO_IPC_KEY__'

export function addPluginListener(): Promise<{ unregister: () => Promise<void> }> {
  return Promise.resolve({ unregister: () => Promise.resolve() })
}

export function checkPermissions<T>(): Promise<T> {
  return Promise.resolve({ } as T)
}

export function requestPermissions<T>(): Promise<T> {
  return Promise.resolve({ } as T)
}
