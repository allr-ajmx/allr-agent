/**
 * When a repeating renderer loop is worth running at all.
 *
 * A spinner, a ticker, any `setInterval` that exists to be looked at: none of
 * it earns its wake-ups while nobody is looking. The window can be minimized,
 * occluded by another workspace, or simply unfocused, and a transcript with a
 * dozen live rows keeps every one of them ticking regardless.
 *
 * Ported from desktop's `lib/renderer-loop-pause.ts` minus its Electron
 * `onWindowStateChanged` hook — Tauri has no such bridge here, so a minimized
 * window is detected through `document.visibilityState`, which is what the
 * WebKitGTK/WebView2/WKWebView hosts report when the surface stops compositing.
 */
export function createRendererLoopPauseController(onChange: () => void, { pauseWhenUnfocused = true } = {}) {
  let windowFocused = document.hasFocus()

  const onVisibilityChange = () => onChange()

  const onBlur = () => {
    if (windowFocused) {
      windowFocused = false
      onChange()
    }
  }

  const onFocus = () => {
    if (!windowFocused) {
      windowFocused = true
      onChange()
    }
  }

  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('blur', onBlur)
  window.addEventListener('focus', onFocus)

  return {
    dispose: () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('focus', onFocus)
    },
    isPaused: () => document.visibilityState === 'hidden' || (pauseWhenUnfocused && !windowFocused)
  }
}
