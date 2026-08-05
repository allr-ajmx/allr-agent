/**
 * One entry point for everything observability installs at boot.
 *
 * main.tsx calls `installObservability()` and nothing else, so the question
 * "what does tracing cost this app at startup" has one place to look, and the
 * dev/bench-only pieces are gated here rather than at each call site.
 *
 * The gate matches the one the bench route already uses (`app/contrib/panes.tsx`),
 * so a dev build and a `--mode benchmark` build — which is a real production
 * frontend that keeps the bench — both light up, while `npm run build` folds it
 * all away.
 */

import { installEventTiming } from './auto/events'

const DEV_TOOLS_ENABLED = import.meta.env.DEV || import.meta.env.VITE_ENABLE_BENCH === 'true'

export function installObservability(): void {
  // SHIPS. One PerformanceObserver, no code in any interaction path, and it
  // records nothing while recording is off — so there is no reason to withhold
  // it from the builds where the interesting jank actually happens.
  installEventTiming()

  if (!DEV_TOOLS_ENABLED) {
    return
  }

  // Dev/bench only below: the console surface, the collector exporter, and the
  // HUD. A release build must not carry a hardcoded collector URL, and a dynamic
  // import keeps it all out of the main chunk as well as out of the release.
  //
  // The HUD is installed HERE rather than mounted by the app, and that is not an
  // implementation detail. It owns raw DOM outside React, so it neither joins the
  // app's render commits nor waits on them — it is up before the first render,
  // stays up through a gateway outage or a routing failure, and survives a blank
  // screen, which is exactly the state someone reaches for a tracer in. Ordered
  // after the console so it can hang `hud()` off the same object.
  void import('./exporter').then(async exporter => {
    exporter.installTraceConsole()

    const hud = await import('@/dev/trace-hud')

    hud.installTraceHud()
  })

  // The FPS HUD is its OWN import chain, not appended to the one above: it does
  // not depend on the tracer, and an exporter that fails to load (no collector,
  // a bad build) must not take the frame-rate readout down with it. They only
  // share the gate and the panel chrome.
  void import('@/dev/fps-hud').then(hud => hud.installFpsHud())
}
