/**
 * nanostores autocapture — every store write becomes a span, with no per-store
 * code and no way to forget a new one.
 *
 * WHY THIS IS AUTOMATIC RATHER THAN HAND-PLACED
 *
 * This module exists because of a specific, expensive mistake. Chasing a janky
 * sidebar drag, a span was placed by hand on `$layoutTree` — the obvious
 * suspect — and it recorded *nothing*, because an edge sidebar is a fixed track
 * and writes `$paneStates` instead. The capture came back clean and empty, with
 * no hint that the instrument was pointed at the wrong object, and it cost a
 * full measure-and-report round to notice. A hand-placed span encodes a guess
 * about where the time goes; being wrong about the location is silent. Wrapping
 * the constructor makes being wrong cost nothing.
 *
 * HOW IT IS INSTALLED
 *
 * vite.config.ts aliases `nanostores` to this module, so all ~140 call sites are
 * covered — including the ~34 files that import the package directly rather than
 * through the `@/store/atom` seam. It re-exports the real package's entire
 * surface and replaces only `atom`, `map` and `computed`.
 *
 * DEV/BENCH ONLY. A store write is a hot path — one per stream token — and
 * wrapping it in release to record nothing is a cost with no matching benefit.
 * The signals worth having from a real user are interaction latency and the
 * semantic spans, not this.
 *
 * TWO THINGS THAT WOULD BREAK IT SILENTLY
 *
 * 1. Returning a *different* nanostores instance. `resolve.dedupe` covers only
 *    react/react-dom; two nanostores copies would leave `useStore` subscribed to
 *    stores nobody writes to, and the UI would simply stop updating. Hence the
 *    `export *` — same objects, same identities, one instance.
 * 2. Recording every write. `$petActivity` is written on every reasoning token
 *    and `$voiceConversation` on every audio frame; without a floor the buffer
 *    fills in seconds and the trace is chatter. See NOISE_FLOOR_MS.
 */

import * as real from 'nanostores-real'

import { isRecording, recordSpan } from '../span'

/**
 * Only writes at least this expensive become spans.
 *
 * The point of store spans is to catch a write whose synchronous fan-out is
 * expensive — nanostores notifies listeners inline, so an `atom.set` that
 * triggers a cascade shows its cost right here. A write that costs nothing is
 * not evidence of anything, and there are a lot of them: `$sessionStates` at
 * ~30Hz while streaming, `$layoutTree` and `$dropHint` once per frame while
 * dragging, `$petActivity` per reasoning token, `$voiceConversation` per audio
 * frame. Recording those would exhaust the span buffer before the interesting
 * write ever happened.
 *
 * 1ms rather than 0 also matches the clock: WebKitGTK clamps performance.now()
 * to 1ms, so anything below this is indistinguishable from zero anyway.
 */
const NOISE_FLOOR_MS = 1

type Writable<T> = { set(value: T): void }

/**
 * Wrap a store's `set` so the write — and everything nanostores runs
 * synchronously off it — is timed.
 *
 * Patches the instance rather than the prototype: nanostores builds stores from
 * closures, so there is no shared prototype to patch, and per-instance keeps the
 * blast radius to stores this app created.
 */
function instrument<S extends Writable<unknown>>(store: S, name: string): S {
  const original = store.set.bind(store)

  // `isRecording()` is CALLED per write rather than captured once: these stores
  // are constructed at module load, long before anyone turns recording on.
  //
  // Importing the span core directly is safe despite this module standing in
  // for `nanostores`: span.ts has no imports at all, so there is no cycle.
  store.set = (value: unknown) => {
    if (!isRecording()) {
      original(value)

      return
    }

    const startedAt = performance.now()

    original(value)

    const elapsed = performance.now() - startedAt

    if (elapsed >= NOISE_FLOOR_MS) {
      recordSpan('store.set', startedAt, startedAt + elapsed, { store: name })
    }
  }

  return store
}

/**
 * `name` is appended by the vite transform in vite.config.ts, which rewrites
 * `export const $foo = atom(...)` to pass `'$foo'`. Real nanostores ignores
 * extra arguments, so the transform is inert whenever this alias is off.
 *
 * Three sites construct stores dynamically and pass their own name instead:
 * lib/persisted.ts (uses its storage key), store/composer.ts (per-composer
 * scope), and sdk/index.ts (plugin-created, no module identity).
 */
export function atom<T>(initial?: T, name?: string): ReturnType<typeof real.atom<T>> {
  return instrument(real.atom(initial as T), name ?? 'anonymous') as ReturnType<typeof real.atom<T>>
}

export function map<T extends object>(initial?: T, name?: string): ReturnType<typeof real.map<T>> {
  return instrument(real.map(initial as T), name ?? 'anonymous') as ReturnType<typeof real.map<T>>
}

/**
 * `computed` is NOT instrumented. Its value is derived, not written — timing it
 * would attribute the recompute to whichever store happened to trigger it, and
 * that store's own span already contains the recompute because nanostores runs
 * it synchronously inside the notification.
 */
export const computed = real.computed

// Everything else, unchanged and — critically — from the same instance.
export * from 'nanostores-real'
