/**
 * Run identity — what makes one capture findable among hundreds in Jaeger.
 *
 * Without a label every trace looks alike: same service, same operation names,
 * differing only by timestamp. Comparing "before the fix" against "after" then
 * means squinting at clocks. Two levers, in increasing order of usefulness:
 *
 *   VITE_TRACE_RUN=before-fix npm run tauri dev     build/dev-time
 *   __hermesTrace.run('after-fix')                  runtime, no rebuild
 *
 * Either way it surfaces as the resource attribute `hermes.run`, which Jaeger
 * indexes as a process tag and offers in its search box. `service.name` stays
 * `hermes-universal` — the label is a FILTER, not an identity, and minting a
 * service per experiment would turn the service dropdown into a junk drawer.
 *
 * `__TRACE_RUN_DEFAULT__` is replaced at build time by vite.config.ts with the
 * current git branch, so even an unlabelled run says where it came from.
 */

declare const __TRACE_RUN_DEFAULT__: string | undefined

export const SERVICE_NAME = 'hermes-universal'

function initialRun(): string {
  const explicit = import.meta.env.VITE_TRACE_RUN as string | undefined

  if (explicit) {
    return explicit
  }

  // `typeof` guard rather than a bare read: the define is absent in test runs
  // and in any consumer that doesn't go through this vite config, where a bare
  // reference would throw a ReferenceError at module load.
  return typeof __TRACE_RUN_DEFAULT__ === 'string' && __TRACE_RUN_DEFAULT__ ? __TRACE_RUN_DEFAULT__ : 'local'
}

let runLabel = initialRun()

export function getRun(): string {
  return runLabel
}

export function setRun(label: string): void {
  runLabel = label
}

/**
 * Per-page random nonce, so trace ids don't collide across reloads or windows.
 *
 * Without it, two runs would mint the same ids and Jaeger — which keys on
 * traceId — would merge unrelated sessions into one trace. 8 hex chars leaves
 * 24 for the per-trace counter, filling OTLP's 32-char traceId exactly.
 */
export const SESSION_NONCE = Math.floor(Math.random() * 0xffffffff)
  .toString(16)
  .padStart(8, '0')
