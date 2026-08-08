import { type Connection, connectionCacheKey, resolveTerminalWsUrl } from '@/store/gateway-config'
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
// When the gateway advertises `shell_pty_reattach` we dial with a stable
// `?attach=<token>` so the shell survives WS drops: the server replays its ring
// buffer on reattach, and an abnormal close (network drop) is retried with capped
// backoff instead of ending the pane. Older gateways (no reattach) keep the v1
// EPHEMERAL behaviour — no token, a dropped socket is a dead shell — so nothing
// regresses when talking to a backend that predates MJXHRM-184.
//
// Terminal close codes are NEVER retried: 4410 (shell exited), 4401 (auth),
// 4403/4408 (refused), 4404 (disabled), 4409 (superseded — another device took
// over), 1011 (no POSIX PTY). Only a transport-level drop reconnects.

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
/** Abnormal closure — no close frame arrived (the socket dropped under us). This
 *  is the one code, alongside a missing code, that a reattachable shell retries. */
const CLOSE_ABNORMAL = 1006

/** Reconnect backoff for a reattachable shell: capped exponential from 500ms. */
const RECONNECT_BASE_MS = 500
const RECONNECT_MAX_MS = 10_000

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
  /** The stable `?attach=` token, or null when the gateway can't reattach — which
   *  is also the flag for "may this drop reconnect at all". */
  private attachToken: null | string = null
  private reconnectAttempts = 0
  private reconnectTimer: null | ReturnType<typeof setTimeout> = null

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
    // Ask before dialling. An older gateway has no `/api/shell-pty`, and the refusal
    // it sends back is a bare 403 that reads as "session expired" — so the capability
    // has to come from `/api/health`, where absence means the build predates it.
    const features = await gatewayFeatures(this.connection)

    if (!features.shellPty) {
      this.end({ kind: 'unsupported' })

      return
    }

    if (this.closed) {
      return
    }

    // A stable token per (backend identity, terminal pane) so a reconnect — and a
    // deliberate Restart — reattach to the SAME shell. connectionCacheKey survives
    // ssh re-tunnels; the terminal id survives tab switches. Only when the gateway
    // advertises reattach: an ephemeral gateway must not be handed a token it will
    // reject. resolveTerminalWsUrl url-encodes it via URLSearchParams.
    this.attachToken =
      features.shellPtyReattach && this.options.terminalId
        ? `${connectionCacheKey(this.connection)}:${this.options.terminalId}`
        : null

    await this.connect(false)
  }

  /** Dial (or re-dial) the shell. `reattach` marks a reconnect so the ready signal
   *  can tell the pane the server replayed scrollback. */
  private async connect(reattach: boolean): Promise<void> {
    if (this.closed || this.ended) {
      return
    }

    let url: string

    // The cwd is a query param, path-hardened server-side; omitted entirely when the
    // session has no workspace so the backend picks its own default. `attach` opts
    // into the keep-alive shell + ring-buffer replay.
    const params: Record<string, string> = {}

    if (this.options.cwd) {
      params.cwd = this.options.cwd
    }

    if (this.attachToken) {
      params.attach = this.attachToken
    }

    try {
      url = await resolveTerminalWsUrl(this.connection, params)
    } catch (err) {
      // A ticket mint failing is the session having expired, not a broken terminal.
      this.end(endForError(err instanceof Error ? err.message : String(err)))

      return
    }

    if (this.closed || this.ended) {
      return
    }

    this.socket = new TerminalSocket(url, {
      onBinary: bytes => this.handlers.onData(bytes),
      onClose: code => this.handleClose(code),
      onError: message => this.handleError(message),
      onOpen: () => {
        this.live = true
        this.reconnectAttempts = 0
        this.handlers.onReady({ host: hostLabel(this.connection), replayed: reattach })

        // The PTY spawns at the server's default size; push ours immediately so
        // the first prompt wraps to the real viewport.
        if (this.size) {
          this.socket?.sendText(resizeEscape(this.size.cols, this.size.rows))
        }
      },
      onText: text => this.handlers.onData(text)
    })
  }

  private handleClose(code: number | undefined): void {
    this.live = false

    if (this.closed || this.ended) {
      return
    }

    if (this.shouldReconnect(code)) {
      this.scheduleReconnect()

      return
    }

    this.end(endForCloseCode(code))
  }

  private handleError(message: string): void {
    this.live = false

    if (this.closed || this.ended) {
      return
    }

    // Reuse the close-error mapping: a 404/401/403 upgrade failure is terminal
    // (unsupported/auth), but a bare transport error on a reattachable shell is a
    // network blip worth retrying.
    const mapped = endForError(message)

    if (this.attachToken && mapped.kind === 'error') {
      this.scheduleReconnect()

      return
    }

    this.end(mapped)
  }

  /** Only a reattachable shell reconnects, and only on a transport-level drop —
   *  1006 (no close frame) or a missing code. Every server close code (4401/4403/
   *  4404/4408/4409/4410) and 1011 is a deliberate end, handled by endForCloseCode. */
  private shouldReconnect(code: number | undefined): boolean {
    return this.attachToken !== null && (code === undefined || code === CLOSE_ABNORMAL)
  }

  private scheduleReconnect(): void {
    if (this.closed || this.ended) {
      return
    }

    // Drop the dead socket's listeners before dialling again.
    this.socket?.close()
    this.socket = null
    this.handlers.onStatus?.('reconnecting')

    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.reconnectAttempts)
    this.reconnectAttempts += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect(true)
    }, delay)
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

    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    this.socket?.close()
    this.socket = null
  }
}
