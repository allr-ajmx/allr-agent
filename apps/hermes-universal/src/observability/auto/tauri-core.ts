/**
 * Trace context across the IPC boundary.
 *
 * WHAT PROBLEM THIS SOLVES
 *
 * The Rust half of this app is already traced, and its spans were landing in
 * Jaeger as their own separate traces: 93 `wry::custom_protocol::handle` roots
 * and 34 `app::emit` roots in a single sample window, each two to four spans
 * long, sitting next to the frontend trace that caused every one of them. A
 * frontend `http.request` span could say a call took 400ms and could not say
 * whether that was DNS, TLS, gateway think-time or deserialisation — the answer
 * existed, in a trace with no link to the question.
 *
 * A W3C `traceparent` on the invoke closes it. The backend reads it as a remote
 * parent, so Tauri's per-command spans become children of the frontend span that
 * issued the call.
 *
 * WHY A HEADER AND NOT AN ARGUMENT
 *
 * `InvokeOptions.headers` is out of band, so no command signature changes and no
 * command has to know tracing exists. Tauri v2 carries it over the custom-
 * protocol IPC, which is the transport this app already uses — the
 * `wry::custom_protocol::handle` spans are the proof it arrives.
 *
 * DEV/BENCH ONLY, via the vite alias. Not because the header is expensive — it
 * is one string, and only while recording — but because a release build has no
 * exporter to send the resulting spans to, so the propagation would have nothing
 * to join.
 *
 * ONE INSTANCE. `export *` re-exports the real module's own bindings rather than
 * re-creating them: `Channel`, `Resource` and `transformCallback` carry identity
 * that Tauri compares against, and a second copy would break them in ways that
 * look nothing like a tracing bug.
 */

import { invoke as realInvoke } from '@tauri-apps/api-real/core'
import type { InvokeArgs, InvokeOptions } from '@tauri-apps/api/core'

import { traceparentFor } from '../otlp'
import { currentContext } from '../span'

/**
 * Merge a `traceparent` into whatever headers the caller already passed.
 *
 * `HeadersInit` is three shapes (a `Headers`, an array of pairs, a record) and
 * all three appear in the wild, so this normalises rather than assuming. A
 * caller's own headers always win — this is telemetry, and telemetry does not
 * get to overwrite an application header even by accident.
 */
function withTraceparent(traceparent: string, headers: InvokeOptions['headers'] | undefined): HeadersInit {
  const merged = new Headers(headers)

  if (!merged.has('traceparent')) {
    merged.set('traceparent', traceparent)
  }

  return merged
}

export function invoke<T>(cmd: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> {
  const context = currentContext()

  if (!context) {
    return realInvoke<T>(cmd, args, options)
  }

  return realInvoke<T>(cmd, args, {
    ...options,
    headers: withTraceparent(traceparentFor(context.trace, context.serial), options?.headers)
  })
}

export * from '@tauri-apps/api-real/core'
