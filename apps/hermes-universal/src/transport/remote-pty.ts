import { type Connection, resolveTerminalWsUrl } from '@/store/gateway-config'
import { gatewayFeatures } from '@/store/gateway-features'

import { TerminalSocket } from './terminal-socket'
import type {
  TerminalEnd,
  TerminalTransport,
  TerminalTransportHandlers,
  TerminalTransportOptions
} from './terminal-transport'

// The gateway-hosted shell: `/api/shell-pty` over the Rust WS transport. The
// server spawns the operator's `$SHELL` on the BACKEND host and pumps raw bytes
// both ways; the only in-band control is the resize escape below, which the
// server's pump consumes without writing it to the PTY.
//
// v1 is deliberately EPHEMERAL: no `?attach=` token, so a dropped socket is a
// dead shell and the pane says so rather than silently restarting. Keep-alive +
// scrollback replay (the server already has the registry for it) is MJXHRM-164.

/** ESC, kept as a named constant so no raw control byte lands in the source. */
const ESC = '\u001b'

/** The server's `_RESIZE_RE`: `ESC [RESIZE:cols;rows]`, matched on the raw frame. */
function resizeEscape(cols: number, rows: number): string {
  return `${ESC}[RESIZE:${cols};${rows}]`
}

/** WS close codes, shared 1:1 with `/api/pty` (hermes_cli/web_server.py). */
const CLOSE_AUTH = 4401
const CLOSE_FORBIDDEN = 4403
const CLOSE_DISABLED = 4404
const CLOSE_PEER = 4408
const CLOSE_SUPERSEDED = 4409
const CLOSE_PROCESS_EXITED = 4410
/** The server's "no POSIX PTY here" path (native-Windows gateway) closes 1011. */
const CLOSE_INTERNAL = 1011

function endForCloseCode(code: number | undefined): TerminalEnd {
  switch (code) {
    case CLOSE_AUTH:
      return { kind: 'auth' }

    case CLOSE_DISABLED:
      return { kind: 'disabled' }

    case CLOSE_FORBIDDEN:

    case CLOSE_PEER:
      return { kind: 'refused' }

    case CLOSE_INTERNAL:
      return { kind: 'unsupported' }

    case CLOSE_SUPERSEDED:
      return { kind: 'superseded' }

    case CLOSE_PROCESS_EXITED:
      return { kind: 'exited' }

    default:
      // A clean close with no code is the shell ending normally; anything else
      // is the socket dropping under us, which — with no reattach — is the same
      // outcome from the user's side.
      return { kind: 'exited' }
  }
}

/** An upgrade that never completed fails in Rust with the HTTP status in the message
 *  rather than a WS close code.
 *
 *  Note the 403 here is genuinely auth/origin/peer: a gateway that does not HAVE
 *  `/api/shell-pty` is caught by the capability probe in `init()` and never reaches
 *  this point. Without that probe it could not be told apart — uvicorn answers every
 *  pre-accept close with a bare 403, and a route Starlette never matched is one of
 *  them, so the 404 branch below only ever fires for a reverse proxy in the way. */
function endForError(message: string): TerminalEnd {
  if (/\b404\b|not found/i.test(message)) {
    return { detail: message, kind: 'unsupported' }
  }

  if (/\b401\b|\b403\b|unauthor|forbidden|reauth/i.test(message)) {
    return { detail: message, kind: 'auth' }
  }

  return { detail: message, kind: 'error' }
}

/** What the pane calls the machine you're typing into. An ssh connection's baseUrl
 *  is an ephemeral loopback port, which tells the user nothing — show the host. */
function hostLabel(conn: Connection): string {
  if (conn.mode === 'ssh' && conn.remoteHost) {
    return conn.remoteHost
  }

  try {
    return new URL(conn.baseUrl).host
  } catch {
    return conn.baseUrl
  }
}

export class RemotePtySocket implements TerminalTransport {
  private socket: TerminalSocket | null = null
  private closed = false
  private ended = false
  private live = false
  private size: null | { cols: number; rows: number } = null

  constructor(
    private readonly connection: Connection,
    private readonly options: TerminalTransportOptions,
    private readonly handlers: TerminalTransportHandlers
  ) {
    this.size = { cols: options.cols, rows: options.rows }
    void this.init()
  }

  private end(value: TerminalEnd): void {
    if (this.ended || this.closed) {
      return
    }

    this.ended = true
    this.live = false
    this.handlers.onEnd(value)
  }

  private async init(): Promise<void> {
    let url: string

    // Ask before dialling. An older gateway has no `/api/shell-pty`, and the refusal
    // it sends back is a bare 403 that reads as "session expired" — so the capability
    // has to come from `/api/health`, where absence means the build predates it.
    if (!(await gatewayFeatures(this.connection)).shellPty) {
      this.end({ kind: 'unsupported' })

      return
    }

    if (this.closed) {
      return
    }

    try {
      // The cwd is a query param, path-hardened server-side; omitted entirely when
      // the session has no workspace so the backend picks its own default.
      url = await resolveTerminalWsUrl(this.connection, this.options.cwd ? { cwd: this.options.cwd } : {})
    } catch (err) {
      // A ticket mint failing is the session having expired, not a broken terminal.
      this.end(endForError(err instanceof Error ? err.message : String(err)))

      return
    }

    if (this.closed) {
      return
    }

    this.socket = new TerminalSocket(url, {
      onBinary: bytes => this.handlers.onData(bytes),
      onClose: code => this.end(endForCloseCode(code)),
      onError: message => this.end(endForError(message)),
      onOpen: () => {
        this.live = true
        this.handlers.onReady({ host: hostLabel(this.connection) })

        // The PTY spawns at the server's default size; push ours immediately so
        // the first prompt wraps to the real viewport.
        if (this.size) {
          this.socket?.sendText(resizeEscape(this.size.cols, this.size.rows))
        }
      },
      onText: text => this.handlers.onData(text)
    })
  }

  write(data: string): void {
    if (this.live) {
      this.socket?.sendText(data)
    }
  }

  resize(cols: number, rows: number): void {
    this.size = { cols, rows }

    if (this.live) {
      this.socket?.sendText(resizeEscape(cols, rows))
    }
  }

  close(): void {
    this.closed = true
    this.live = false
    this.socket?.close()
    this.socket = null
  }
}
