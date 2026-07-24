// Deterministic safe-area insets.
//
// `env(safe-area-inset-*)` is the CSS way to read the notch / status-bar / home-
// indicator insets, but on the mobile webviews Tauri embeds (WKWebView on iOS,
// the system WebView on Android) those values read as 0 for the first frame(s)
// and only resolve *shortly after* the page paints. Anything padded with the raw
// `env()` — a top bar, the composer — therefore renders at y=0 and then jumps
// once the real inset arrives. That is the "top bar is sometimes placed
// correctly and sometimes not" flicker.
//
// So we own the value instead of trusting `env()`'s timing: probe the resolved
// inset off a hidden element, publish it to `:root` as `--safe-area-inset-*`,
// and RE-probe across the moments the webview tends to settle or change insets
// (next frame, window load, a short bounded retry, plus rotation / viewport
// resizes forever). Consumers read `var(--safe-area-inset-top)` and get a stable
// number from the first published frame rather than a 0-that-becomes-N.
//
// The CSS fallback for these vars is `env(...)` itself (declared in styles.css
// :root), so on desktop/web — where this init still runs but env() is 0 — the
// vars simply stay 0 and nothing changes. This module never throws.

const SIDES = ['top', 'right', 'bottom', 'left'] as const

type Side = (typeof SIDES)[number]

// Re-probe schedule (ms) after init, to catch the webview resolving env() late.
// Frame 0 (rAF) covers most; the trailing entries cover the slow WKWebView tail.
const RETRY_DELAYS_MS = [50, 150, 400, 1_000] as const

let started = false
let probe: HTMLDivElement | null = null

/** The hidden element whose paddings ARE the env() insets — we read them back
 *  resolved to px. Created once, kept out of layout and off the a11y tree. */
function ensureProbe(): HTMLDivElement | null {
  if (typeof document === 'undefined') {
    return null
  }

  if (probe) {
    return probe
  }

  const el = document.createElement('div')

  el.setAttribute('aria-hidden', 'true')
  el.style.cssText = [
    'position:fixed',
    'top:0',
    'left:0',
    'width:0',
    'height:0',
    'visibility:hidden',
    'pointer-events:none',
    'z-index:-1',
    'padding-top:env(safe-area-inset-top)',
    'padding-right:env(safe-area-inset-right)',
    'padding-bottom:env(safe-area-inset-bottom)',
    'padding-left:env(safe-area-inset-left)'
  ].join(';')

  document.body.appendChild(el)
  probe = el

  return el
}

/** Read the four resolved insets off the probe and write any that changed to
 *  `:root`. Writing only-on-change keeps this cheap to call on every resize. */
function measureAndPublish(): void {
  const el = ensureProbe()

  if (!el) {
    return
  }

  const cs = getComputedStyle(el)
  const root = document.documentElement.style

  for (const side of SIDES) {
    const key: Side = side
    // paddingTop / paddingRight / …
    const value = cs.getPropertyValue(`padding-${key}`)
    const next = value && value !== '0px' ? value : '0px'
    const cssVar = `--safe-area-inset-${key}`

    if (root.getPropertyValue(cssVar) !== next) {
      root.setProperty(cssVar, next)
    }
  }
}

/**
 * Start publishing `--safe-area-inset-{top,right,bottom,left}` to `:root` and
 * keep them correct across the webview's late env() resolution and later
 * orientation / viewport changes. Idempotent — safe to call once at startup on
 * every platform (a no-op where env() is 0).
 */
export function initSafeAreaInsets(): void {
  if (started || typeof window === 'undefined' || typeof document === 'undefined') {
    return
  }

  started = true

  const publish = () => measureAndPublish()

  const run = () => {
    publish()
    // Next paint: the single most common moment env() flips from 0 to real.
    requestAnimationFrame(publish)
    // Bounded retries for the slow WKWebView tail.
    for (const delay of RETRY_DELAYS_MS) {
      window.setTimeout(publish, delay)
    }
  }

  // `document.body` may not exist yet if this runs before the DOM is parsed.
  if (document.body) {
    run()
  } else {
    document.addEventListener('DOMContentLoaded', run, { once: true })
  }

  // Insets change on rotation and when the visual viewport reflows (rotation,
  // keyboard on some platforms). Keep these live for the app's lifetime.
  window.addEventListener('load', publish)
  window.addEventListener('resize', publish)
  window.addEventListener('orientationchange', publish)
  window.visualViewport?.addEventListener('resize', publish)
  window.visualViewport?.addEventListener('scroll', publish)
}
