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

const DEV_TOOLS_ENABLED = import.meta.env.DEV || import.meta.env.VITE_ENABLE_BENCH === 'true'

export function installObservability(): void {
  // Autocaptures that SHIP go here, unconditionally — they cost nothing while
  // recording is off and they are the ones worth having from a real user.

  if (!DEV_TOOLS_ENABLED) {
    return
  }

  // Dev/bench only below: the console surface and the collector exporter. A
  // release build must not carry a hardcoded collector URL, and a dynamic
  // import keeps it out of the main chunk as well as out of the release.
  void import('./exporter').then(m => m.installTraceConsole())
}
