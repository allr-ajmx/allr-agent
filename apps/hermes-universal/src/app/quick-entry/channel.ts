/**
 * The quick window ⇄ primary window wire (MJXHRM-384).
 *
 * Desktop ran this over Electron IPC, which meant a hop through the main process
 * and a cache there so a window opened after the last push still knew what the
 * gateway was doing. Universal's windows are webviews of ONE app talking to ONE
 * Rust backend, and Tauri's event bus already broadcasts to all of them — so the
 * two sides talk directly and the "cache" is a hello the quick window sends on
 * mount to ask for a fresh push.
 *
 * Three channels, all named here so a rename cannot half-land:
 *
 * - `submit` — quick window → primary. The captured text and where it goes.
 * - `state`  — primary → quick window. Gateway reachable + recent sessions.
 * - `hello`  — quick window → primary. "I just opened, push me the state."
 *
 * `emit` reaches every window including the sender; each listener below is only
 * ever installed in the side that is not the sender, so nothing loops.
 */

import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event'

import { IS_TAURI } from '@/lib/platform'
import type { QuickEntryStatePush, QuickEntrySubmitPayload } from '@/store/quick-entry'

/** Captured text on its way to the window that can actually send it. */
export const QUICK_ENTRY_SUBMIT_EVENT = 'hermes://quick-entry-submit'
/** Gateway truth on its way to the window that has no gateway. */
export const QUICK_ENTRY_STATE_EVENT = 'hermes://quick-entry-state'
/** "I'm up — tell me what the backend is doing." */
export const QUICK_ENTRY_HELLO_EVENT = 'hermes://quick-entry-hello'

/** A no-op unlisten, so callers off Tauri (tests, web) still get a disposer. */
const NOOP: UnlistenFn = () => {}

async function send(event: string, payload?: unknown): Promise<void> {
  if (!IS_TAURI) {
    return
  }

  try {
    await emit(event, payload)
  } catch (err) {
    // The other window may already be gone (a dismiss racing a submit is the
    // normal case). Losing the message is the same outcome as never sending it.
    console.warn('[quick-entry] could not emit', event, err)
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

export function emitQuickEntryHello(): Promise<void> {
  return send(QUICK_ENTRY_HELLO_EVENT)
}

export function emitQuickEntryState(state: QuickEntryStatePush): Promise<void> {
  return send(QUICK_ENTRY_STATE_EVENT, state)
}

export function emitQuickEntrySubmit(payload: QuickEntrySubmitPayload): Promise<void> {
  return send(QUICK_ENTRY_SUBMIT_EVENT, payload)
}

export function onQuickEntryHello(handler: () => void): Promise<UnlistenFn> {
  return receive<unknown>(QUICK_ENTRY_HELLO_EVENT, () => handler())
}

export function onQuickEntryState(handler: (state: unknown) => void): Promise<UnlistenFn> {
  return receive<unknown>(QUICK_ENTRY_STATE_EVENT, handler)
}

export function onQuickEntrySubmit(handler: (payload: unknown) => void): Promise<UnlistenFn> {
  return receive<unknown>(QUICK_ENTRY_SUBMIT_EVENT, handler)
}
