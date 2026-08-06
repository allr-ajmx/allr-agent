/**
 * One entry point for everything observability installs at boot.
 *
 * main.tsx calls `installObservability()` and nothing else, so the question
 * "what does tracing cost this app at startup" has one place to look, and the
 * dev/bench-only pieces are gated here rather than at each call site.
 *
 * The gate itself lives in `enabled.ts` — several modules below now need the
 * same answer, and a constant copied around is a constant that eventually
 * disagrees with itself.
 */

import { installEventTiming, setFrameCounter } from './auto/events'
import { DEV_TOOLS_ENABLED } from './enabled'

export function installObservability(): void {
  // SHIPS. One PerformanceObserver, no code in any interaction path, and it
  // records nothing while recording is off — so there is no reason to withhold
  // it from the builds where the interesting jank actually happens.
  installEventTiming()

  if (!DEV_TOOLS_ENABLED) {
    return
  }

  // Dev/bench only below: the frame clock, the console surface, the collector
  // exporter, and the two HUDs. A release build must not carry a hardcoded
  // collector URL, and a dynamic import keeps it all out of the main chunk as
  // well as out of the release.
  //
  // The frame clock comes FIRST because both chains below depend on it — the FPS
  // HUD reads its pacing, the tracer parents every in-frame span to it — and it
  // must own its MessageChannel before anyone asks it for a frame. It runs no
  // rAF loop until one of them says it wants frames.
  void import('./auto/frames').then(frames => {
    frames.installFrames()
    // Lets the shipped interaction autocapture say how many frames an
    // interaction spanned, without importing the dev-only clock to do it.
    setFrameCounter(frames.framesIn)

    // The engine probe rides the same clock, and is the one instrument that can
    // decompose the presentation phase the interaction spans report as opaque.
    void import('./auto/engine-probe').then(probe => probe.installEngineProbe())
    // React commit timing + the per-frame totals for the tracks pass.
    void import('./auto/layout-counters').then(counters => counters.installLayoutCounters())

    // The HUD is installed HERE rather than mounted by the app, and that is not
    // an implementation detail. It owns raw DOM outside React, so it neither
    // joins the app's render commits nor waits on them — it is up before the
    // first render, stays up through a gateway outage or a routing failure, and
    // survives a blank screen, which is exactly the state someone reaches for a
    // tracer in. Ordered after the console so it can hang `hud()` off the same
    // object.
    void import('./exporter').then(async exporter => {
      exporter.installTraceConsole()

      // Recording is the tracer's own reason to want frames — including when it
      // resumes from the persisted flag above, with nobody having clicked
      // anything. Read the status rather than a listener argument so the two
      // paths cannot drift.
      const followRecording = () => frames.setFramesActive('recording', exporter.tracer.status().recording)

      followRecording()
      exporter.tracer.subscribe(followRecording)

      const hud = await import('@/dev/trace-hud')

      hud.installTraceHud()
    })

    // The FPS HUD is its OWN import chain, not appended to the one above: it
    // does not depend on the tracer, and an exporter that fails to load (no
    // collector, a bad build) must not take the frame-rate readout down with
    // it. They share the gate, the panel chrome, and now the frame clock.
    void import('@/dev/fps-hud').then(hud => hud.installFpsHud())
  })
}
