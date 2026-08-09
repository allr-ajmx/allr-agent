import { LOCAL_MODE_SUPPORTED } from '@/lib/platform'
import type { Connection, GatewayMode } from '@/store/gateway-config'

import { LocalPtySocket } from './local-pty'
import { RemotePtySocket } from './remote-pty'

// Which machine the right-pane terminal shells into.
//
// The rule is "the shell follows the WORKSPACE, not the device". Everything else
// in the right pane already resolves through the gateway (`/api/fs/*` for the file
// tree, `/api/git/*` for review), so spawning a LOCAL shell while connected to a
// remote/cloud/ssh backend puts the terminal on a different machine than the files
// it is meant to operate on — you `git status` your laptop while browsing the
// server's repo. A phone makes that fatal (there is no local shell at all), but
// the incoherence is not mobile-specific, so the resolution isn't either.
//
//   local  → LocalPtySocket  (Tauri portable-pty; same machine, no WS hop)
//   remote → RemotePtySocket (`/api/shell-pty` on the gateway host)
//
// `ssh` resolves REMOTE even though its baseUrl is a 127.0.0.1 tunnel: the tunnel
// terminates at `hermes serve` on the remote host, so shell-pty lands there — which
// is the host whose files the rest of the pane is showing.

export type TerminalTransportKind = 'local' | 'remote'

/** User override for the resolution rule (Settings → Terminal → "Shell runs on"). */
export type TerminalHostPreference = 'auto' | 'device' | 'gateway'

export interface TerminalTransportInputs {
  /** False when there is no live connection — nothing to reach a remote shell through. */
  hasConnection: boolean
  /** `LOCAL_MODE_SUPPORTED` in production; a parameter so the rule is testable. */
  localSupported: boolean
  mode: GatewayMode | undefined
  preference: TerminalHostPreference
}

/**
 * Pure resolution of the rule above. Order matters:
 *   1. No local shell on this platform (phone) → remote, always. `device` can't
 *      be honoured because `pty_spawn` returns `unsupported_platform` there.
 *   2. No connection → local. Remote is unreachable without a baseUrl, and a
 *      desktop with no gateway still deserves a working terminal.
 *   3. An explicit preference wins over the mode.
 *   4. Otherwise: only a `local`-mode gateway is this machine.
 */
export function resolveTerminalTransportKind(inputs: TerminalTransportInputs): TerminalTransportKind {
  if (!inputs.localSupported) {
    return 'remote'
  }

  if (!inputs.hasConnection) {
    return 'local'
  }

  if (inputs.preference === 'device') {
    return 'local'
  }

  if (inputs.preference === 'gateway') {
    return 'remote'
  }

  return inputs.mode === 'local' ? 'local' : 'remote'
}

/** Why a terminal stopped. Drives the pane's end state — every one of these is a
 *  distinct sentence to the user, never a blank rectangle. */
export type TerminalEndKind =
  /** 4401 — the gateway session expired. */
  | 'auth'
  /** 4404 — the gateway has the endpoint but it's switched off. */
  | 'disabled'
  /** Transport/spawn failure with a message worth showing. */
  | 'error'
  /** The shell itself exited (local exit, or 4410). Deliberate — never auto-restart. */
  | 'exited'
  /** 4403 / 4408 — host, origin or peer rejected the upgrade. */
  | 'refused'
  /** 4409 — another device attached to this session. */
  | 'superseded'
  /** No shell available at all: mobile local PTY stub, or a gateway with no
   *  `/api/shell-pty` (older build, or a Windows gateway with no POSIX PTY). */
  | 'unsupported'

export interface TerminalEnd {
  kind: TerminalEndKind
  /** Server text or transport error — shown verbatim under the headline. */
  detail?: string
}

/** In-flight status the transport surfaces between ready and ended. Only the
 *  reattaching remote shell emits these; local + first-connect are covered by
 *  `onReady`/`onEnd`. */
export type TerminalStatus = 'reconnecting'

export interface TerminalTransportHandlers {
  /** PTY output. Bytes from both paths; the remote WS also delivers text frames. */
  onData: (data: string | Uint8Array) => void
  onEnd: (end: TerminalEnd) => void
  /** The shell is live. `host` is what the pane shows the user ("this device" vs
   *  the gateway's host), so they always know which machine they're typing into.
   *  `replayed` marks a reattach whose scrollback the server just replayed, so the
   *  burst of buffered output reads as "reconnected", not a glitch. */
  onReady: (info: { host: string; replayed?: boolean }) => void
  /** A reattachable remote shell dropped and is retrying. One-shot per drop. */
  onStatus?: (status: TerminalStatus) => void
}

export interface TerminalTransportOptions {
  cols: number
  /** Snapshotted at spawn — a terminal keeps the directory it was opened in. */
  cwd?: string
  rows: number
  /** Stable per-pane id (store/terminals.ts). Threaded to the remote transport so
   *  it can derive the `?attach=` reattach token; unused by the local shell. */
  terminalId?: string
}

export interface TerminalTransport {
  close: () => void
  resize: (cols: number, rows: number) => void
  write: (data: string) => void
}

/** Adapts LocalPtySocket to the shared transport shape. */
function createLocalTransport(
  options: TerminalTransportOptions,
  handlers: TerminalTransportHandlers
): TerminalTransport {
  let ended = false

  const end = (value: TerminalEnd) => {
    if (!ended) {
      ended = true
      handlers.onEnd(value)
    }
  }

  const socket = new LocalPtySocket(options, {
    onData: handlers.onData,
    onError: message =>
      // The mobile build's pty.rs stub answers every command with this; it is a
      // capability gap, not a crash, so say so.
      end(message.includes('unsupported_platform') ? { kind: 'unsupported' } : { detail: message, kind: 'error' }),
    onExit: () => end({ kind: 'exited' }),
    onSpawn: () => handlers.onReady({ host: 'device' })
  })

  return {
    close: () => socket.close(),
    resize: (cols, rows) => socket.resize(cols, rows),
    write: data => socket.write(data)
  }
}

/**
 * Build the transport for one terminal. Resolution happens ONCE, at spawn: a
 * gateway switch must not yank the shell out from under a running command, and
 * the pane is keyed on the connection anyway.
 */
export function createTerminalTransport(
  kind: TerminalTransportKind,
  connection: Connection | null,
  options: TerminalTransportOptions,
  handlers: TerminalTransportHandlers
): TerminalTransport {
  if (kind === 'local') {
    return createLocalTransport(options, handlers)
  }

  if (!connection) {
    handlers.onEnd({ kind: 'unsupported' })

    return { close: () => {}, resize: () => {}, write: () => {} }
  }

  return new RemotePtySocket(connection, options, handlers)
}

/** The production inputs for {@link resolveTerminalTransportKind}. */
export function terminalTransportInputs(
  connection: Connection | null,
  preference: TerminalHostPreference
): TerminalTransportInputs {
  return {
    hasConnection: connection !== null,
    localSupported: LOCAL_MODE_SUPPORTED,
    mode: connection?.mode,
    preference
  }
}
