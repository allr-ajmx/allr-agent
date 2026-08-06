/**
 * The one dev/bench gate, in one place.
 *
 * `install.ts` used to declare this inline, which was fine while it was the
 * only gate. It no longer is: the frame clock, the engine probe, the layout
 * counters and the React profiler all need the same answer, and a constant
 * copied into five modules is a constant that eventually disagrees with itself
 * — a release build shipping one of them by accident would be silent.
 *
 * The expression matches the bench route's own gate (`app/contrib/panes.tsx`),
 * so a dev build and a `--mode benchmark` build — a real production frontend
 * that keeps the bench — both light up, while `npm run build` folds it away.
 */
export const DEV_TOOLS_ENABLED = import.meta.env.DEV || import.meta.env.VITE_ENABLE_BENCH === 'true'
