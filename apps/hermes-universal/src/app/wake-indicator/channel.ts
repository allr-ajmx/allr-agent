/**
 * The wire between the window that OWNS the wake-indicator state and the native
 * light that shows it (MJXHRM-228).
 *
 * `store/wake-indicator.ts` decides when the indicator is live and which of its
 * three states it is in, once, for every platform. The satellite is a second
 * WebView with its own copy of the bundle and its own module state, so it cannot
 * read that atom — it is told. Two channels, both named here so a rename cannot
 * half-land:
 *
 * - `state` — owner → light. The state to draw.
 * - `hello` — light → owner. "I'm up; push me the current state." The window is
 *   opened and its document loads asynchronously, so the push that caused the
 *   open can easily be sent before anything is listening for it.
 *
 * `emit` reaches every window including the sender. That is harmless here
 * because each listener is only ever installed in the side that is not the
 * sender — the light never sends `state`, the owner never sends `hello`.
 */

import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event'

import { IS_TAURI } from '@/lib/platform'
import type { WakeIndicatorState } from '@/store/wake-indicator'

/** The state on its way to the window that draws it. */
export const WAKE_INDICATOR_STATE_EVENT = 'hermes://wake-indicator-state'
/** "I'm up — tell me what to show." */
export const WAKE_INDICATOR_HELLO_EVENT = 'hermes://wake-indicator-hello'

/** A no-op unlisten, so callers off Tauri (tests, web) still get a disposer. */
const NOOP: UnlistenFn = () => {}

async function send(event: string, payload?: unknown): Promise<void> {
  if (!IS_TAURI) {
    return
  }

  try {
    await emit(event, payload)
  } catch {
    // The light may already be gone — a conversation ending while a push is in
    // the air is the normal case. Losing the message is the same outcome as
    // never sending it, and the window is being closed regardless.
  }
}

async function receive<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  if (!IS_TAURI) {
    return NOOP
  }

  try {
    return await listen<T>(event, message => handler(message.payload))
  } catch {
    return NOOP
  }
}

export function emitWakeIndicatorState(state: WakeIndicatorState): Promise<void> {
  return send(WAKE_INDICATOR_STATE_EVENT, state)
}

export function emitWakeIndicatorHello(): Promise<void> {
  return send(WAKE_INDICATOR_HELLO_EVENT)
}

export function onWakeIndicatorState(handler: (state: unknown) => void): Promise<UnlistenFn> {
  return receive<unknown>(WAKE_INDICATOR_STATE_EVENT, handler)
}

export function onWakeIndicatorHello(handler: () => void): Promise<UnlistenFn> {
  return receive<unknown>(WAKE_INDICATOR_HELLO_EVENT, () => handler())
}
