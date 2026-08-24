/**
 * `@tauri-apps/api/event`, stubbed for the browser. 16 modules import it —
 * `lib/webview-broadcast.ts`, the theme appearance sync, the gateway event
 * router — and all of them subscribe at module init.
 *
 * `listen` resolving a no-op unlisten is the whole contract: nothing in a story
 * emits, so no listener ever has to fire.
 */

export type UnlistenFn = () => void

export function listen(event: string): Promise<UnlistenFn> {
  void event

  return Promise.resolve(() => {})
}

export function once(event: string): Promise<UnlistenFn> {
  return listen(event)
}

export function emit(event: string, payload?: unknown): Promise<void> {
  console.debug('[storybook] emit', event, payload)

  return Promise.resolve()
}

export function emitTo(target: unknown, event: string, payload?: unknown): Promise<void> {
  return emit(event, payload)
}

export const TauriEvent = {
  DRAG_DROP: 'tauri://drag-drop',
  DRAG_ENTER: 'tauri://drag-enter',
  DRAG_LEAVE: 'tauri://drag-leave',
  DRAG_OVER: 'tauri://drag-over',
  WINDOW_BLUR: 'tauri://blur',
  WINDOW_CLOSE_REQUESTED: 'tauri://close-requested',
  WINDOW_FOCUS: 'tauri://focus',
  WINDOW_RESIZED: 'tauri://resize',
  WINDOW_THEME_CHANGED: 'tauri://theme-changed'
} as const
