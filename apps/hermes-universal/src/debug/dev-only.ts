// Dev-only diagnostics entry. Statically imported from `main.tsx` ABOVE the
// `react-dom` import — that ordering is load-bearing and non-negotiable.
//
// react-dom captures the devtools hook at MODULE INIT, not at `createRoot`.
// Installing bippy after react-dom has evaluated yields `renderers=0` and
// `commits=0` — the hook object exists but react-dom never registered with it.
// A dynamic `import()` here would resolve a microtask after main.tsx's static
// graph (react-dom included) had already evaluated, so this must be a plain
// static import chain, whose evaluation order ESM guarantees.
//
// Production builds don't tree-shake this away (a static side-effect import
// can't be eliminated) — instead `vite.config.ts` aliases this module to
// `dev-only.noop.ts` whenever the build isn't serving dev, so neither bippy
// nor the counter reaches a shipped renderer.
//
// Usage, from the devtools console (WebKitGTK: Web Inspector):
//
//   __RENDER_COUNTS__.start()
//   // ...drag a sash, stream a turn, whatever you are measuring...
//   __RENDER_COUNTS__.stop()
//   console.table(__RENDER_COUNTS__.report())
//
// The `wasted` column is the fix list: components that re-rendered with no
// changed props, state or context. `__RENDER_COUNTS__.explain('Pane')` then
// names the ancestor each of those cascaded from.

import './render-counter'

export {}
