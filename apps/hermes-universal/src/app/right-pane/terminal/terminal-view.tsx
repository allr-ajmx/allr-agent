import '@xterm/xterm/css/xterm.css'

import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { type Translations, useI18n } from '@/i18n'
import { IS_MOBILE, LOCAL_MODE_SUPPORTED } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import { $connection } from '@/store/connection'
import { forgetGatewayFeatures } from '@/store/gateway-features'
import { $terminalHostPreference } from '@/store/terminals'
import { $effectiveCwd } from '@/store/workspace-events'
import { useTheme } from '@/themes/context'
import type { DesktopTheme } from '@/themes/types'
import {
  createTerminalTransport,
  resolveTerminalTransportKind,
  type TerminalEnd,
  type TerminalTransport,
  terminalTransportInputs,
  type TerminalTransportKind
} from '@/transport/terminal-transport'

import { applyTerminalModifiers, MobileTerminalKeys, nextModifierState, type TerminalModifiers } from './mobile-keys'
import { terminalTheme, withSurface } from './terminal-theme'

// The right-pane integrated terminal: an xterm bound to whichever shell the
// workspace actually lives on. The transport is chosen at spawn by the gateway
// mode (transport/terminal-transport.ts) — a local portable-pty shell for a
// `local` gateway, `/api/shell-pty` on the backend host for remote/cloud/ssh, and
// always remote on a phone, which has no local shell to spawn.
//
// Wiring is identical either way: raw keystrokes out, xterm.onResize → transport
// resize, PTY output written straight to xterm, WebGL renderer on wide hosts only.

// SGR mouse reports (from xterm's own mouse tracking) must not be forwarded to
// the PTY — the shell would double-handle them.
// eslint-disable-next-line no-control-regex -- ESC (\x1b) is the sequence being matched; that's the point.
const SGR_MOUSE_RE = /^\x1b\[<\d+;\d+;\d+[Mm]$/

type Status = 'connecting' | 'ended' | 'open' | 'reattached' | 'reconnecting'

/** How long the one-shot "Reattached (replayed)" chip stays up before settling to
 *  the plain live state, so the replayed scrollback burst reads as a reconnect. */
const REATTACHED_CHIP_MS = 2500

/** Phone floor for the terminal type, and the bounds pinch-zoom moves between.
 *  The low end still has to fit ~80 columns on a tablet; the high end is where a
 *  narrow phone drops to ~30 columns and stops being a terminal. */
const MOBILE_FONT_SIZE = 13
const MIN_FONT_SIZE = 8
const MAX_FONT_SIZE = 22

// Build the full xterm ITheme for the live skin: a complete, readable ANSI table
// per painted mode (VS Code defaults, overlaid with the skin's palette if it ever
// ships one), with background + block-cursor glyph bound to the live skin surface.
// `renderedMode` (luminance-derived) picks the light/dark table so a light-surface
// "dark" skin still gets the legible light palette. xterm's minimumContrastRatio
// (set on the Terminal) then clamps every glyph readable against the surface.
function buildTerminalTheme(theme: DesktopTheme, mode: 'light' | 'dark') {
  const palette = mode === 'dark' ? (theme.darkTerminal ?? theme.terminal) : theme.terminal

  return withSurface(terminalTheme(mode, palette))
}

/** The end state, as a sentence. Every transport failure lands here, so the pane
 *  can always say WHAT happened and WHERE, instead of going blank. */
function endCopy(t: Translations, end: TerminalEnd, kind: TerminalTransportKind): { body: string; title: string } {
  const copy = t.rightSidebar

  switch (end.kind) {
    case 'auth':
      return { body: copy.terminalEndAuthBody, title: copy.terminalEndAuthTitle }

    case 'disabled':
      return { body: copy.terminalEndDisabledBody, title: copy.terminalEndDisabledTitle }

    case 'error':
      return { body: copy.terminalEndErrorBody, title: copy.terminalEndErrorTitle }

    case 'refused':
      return { body: copy.terminalEndRefusedBody, title: copy.terminalEndRefusedTitle }

    case 'superseded':
      return { body: copy.terminalEndSupersededBody, title: copy.terminalEndSupersededTitle }

    case 'unsupported':
      return kind === 'remote'
        ? { body: copy.terminalEndNoGatewayShellBody, title: copy.terminalEndNoGatewayShellTitle }
        : { body: copy.terminalEndNoLocalShellBody, title: copy.terminalEndNoLocalShellTitle }

    case 'exited':

    default:
      return { body: copy.terminalEndExitedBody, title: copy.terminalEndExitedTitle }
  }
}

export function TerminalView({ id }: { id: string }) {
  const { t } = useI18n()
  const { renderedMode, theme: appTheme } = useTheme()

  const connection = useStore($connection)
  const preference = useStore($terminalHostPreference)

  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const webglRef = useRef<WebglAddon | null>(null)
  const socketRef = useRef<TerminalTransport | null>(null)
  const reattachTimerRef = useRef<null | ReturnType<typeof setTimeout>>(null)
  const [status, setStatus] = useState<Status>('connecting')
  const [end, setEnd] = useState<TerminalEnd | null>(null)
  const [shellHost, setShellHost] = useState<null | string>(null)
  // Bumped by "Restart" — the only way to respawn. A shell exiting is deliberate,
  // and with no reattach a dropped socket is a dead shell, so neither auto-retries.
  const [attempt, setAttempt] = useState(0)
  // Sticky for the session once a gateway turns out to have no terminal API: this
  // pane shells into the device instead. Cleared by Restart, which also re-probes.
  const [fellBack, setFellBack] = useState(false)

  // Sticky Ctrl/Alt for the key row. Held in a ref as well as state because the
  // xterm data handler is registered once, at mount, and must read them live.
  const [modifiers, setModifiers] = useState<TerminalModifiers>({ alt: 'off', ctrl: 'off' })
  const modifiersRef = useRef(modifiers)
  modifiersRef.current = modifiers

  /** The single write path: apply the armed modifiers, then clear the one-shots. */
  const sendRef = useRef((data: string) => {
    const active = modifiersRef.current
    socketRef.current?.write(applyTerminalModifiers(data, active))

    if (active.alt === 'armed' || active.ctrl === 'armed') {
      setModifiers(current => ({
        alt: current.alt === 'armed' ? 'off' : current.alt,
        ctrl: current.ctrl === 'armed' ? 'off' : current.ctrl
      }))
    }
  })

  // Build the xterm instance once.
  useEffect(() => {
    const host = hostRef.current

    if (!host) {
      return
    }

    const term = new Terminal({
      allowProposedApi: true,
      // Opaque canvas: keeps WebGL crisp and gives the contrast clamp a real
      // background to measure against (withSurface paints the skin surface).
      allowTransparency: false,
      convertEol: true,
      cursorBlink: true,
      // Desktop's exact stack (apps/desktop/.../use-terminal-session.ts). It
      // needs no `ui-monospace` repair: every entry is a concrete family and
      // the bundled JetBrains Mono leads, so it resolves on every webview.
      fontFamily: "'JetBrains Mono', 'Cascadia Code', 'SF Mono', Menlo, Consolas, monospace",
      // 12px is a desktop reading size held at desk distance. A handset gets a
      // point more as its floor, and pinch-to-zoom from there (below).
      fontSize: IS_MOBILE ? MOBILE_FONT_SIZE : 12,
      // VS Code's terminal.integrated.minimumContrastRatio (4.5). xterm defaults
      // to 1 (off), which paints the raw saturated ANSI palette — vivid green/cyan
      // on a light surface reads as candy. Clamping darkens/lightens each glyph
      // against the live surface at render time so every color stays legible.
      minimumContrastRatio: 4.5,
      scrollback: 5000,
      theme: buildTerminalTheme(appTheme, renderedMode)
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    const unicode = new Unicode11Addon()
    term.loadAddon(unicode)
    term.unicode.activeVersion = '11'
    term.loadAddon(new WebLinksAddon())
    term.open(host)

    // WebGL renders oversized cells on narrow/mobile hosts — canvas fallback there.
    if (host.clientWidth >= 768) {
      try {
        const webgl = new WebglAddon()
        webgl.onContextLoss(() => {
          webgl.dispose()
          webglRef.current = null
        })
        term.loadAddon(webgl)
        webglRef.current = webgl
      } catch {
        /* fall back to the default renderer */
      }
    }

    try {
      fit.fit()
    } catch {
      /* host not laid out yet */
    }

    termRef.current = term
    fitRef.current = fit

    // xterm measures the glyph cell ONCE, at open(). With `font-display: swap`
    // that measurement can land on the fallback face and never be redone, which
    // leaves the grid mis-sized for the rest of the session. Re-measure as soon
    // as the bundled face is actually available. (jsdom has no document.fonts.)
    let disposed = false
    void document.fonts
      ?.load(`${term.options.fontSize ?? 12}px "JetBrains Mono"`)
      .then(() => {
        if (disposed) {
          return
        }

        term.clearTextureAtlas()

        try {
          fit.fit()
        } catch {
          /* host gone or mid-transition */
        }
      })
      .catch(() => {
        /* face unavailable — the fallback measurement stands */
      })

    const onData = term.onData(data => {
      if (SGR_MOUSE_RE.test(data)) {
        return
      }

      // Everything typed goes through the same gate as the key row, so a Ctrl
      // armed there applies to the letter that follows from the system keyboard.
      sendRef.current(data)
    })

    const onResize = term.onResize(({ cols, rows }) => socketRef.current?.resize(cols, rows))

    let raf = 0

    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        try {
          fit.fit()
        } catch {
          /* mid-transition */
        }
      })
    })

    ro.observe(host)

    return () => {
      disposed = true
      onData.dispose()
      onResize.dispose()
      cancelAnimationFrame(raf)
      ro.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
      webglRef.current = null
    }
  }, [])

  // Spawn the shell once per attempt. The cwd and the connection are SNAPSHOTTED
  // here rather than subscribed: switching chats must not cd a running shell, and
  // switching gateways must not yank it out from under a live command. Re-running
  // is an explicit user act (Restart), never automatic.
  useEffect(() => {
    let disposed = false

    const term = termRef.current

    if (!term) {
      return
    }

    setStatus('connecting')
    setEnd(null)

    try {
      fitRef.current?.fit()
    } catch {
      /* host not laid out yet */
    }

    const conn = $connection.get()

    // Already fell back — re-resolving would only dial the same absent endpoint again.
    const kind = fellBack
      ? 'local'
      : resolveTerminalTransportKind(terminalTransportInputs(conn, $terminalHostPreference.get()))

    socketRef.current = createTerminalTransport(
      kind,
      conn,
      { cols: term.cols, cwd: $effectiveCwd.get() || undefined, rows: term.rows, terminalId: id },
      {
        onData: data => termRef.current?.write(data),
        onEnd: reason => {
          if (disposed) {
            return
          }

          // A gateway with no terminal API is a dead end on a phone, but a desktop has
          // a shell of its own — take it rather than paint a blank rectangle. The chip
          // then says so, because this shell is NOT on the machine the file tree shows.
          if (reason.kind === 'unsupported' && kind === 'remote' && LOCAL_MODE_SUPPORTED && !fellBack) {
            setFellBack(true)

            return
          }

          setEnd(reason)
          setStatus('ended')
        },
        onReady: info => {
          if (disposed) {
            return
          }

          setShellHost(info.host)

          // A reattach replays the server's scrollback buffer — flag it for a beat so
          // the burst reads as "reconnected", then settle to the plain live state.
          if (reattachTimerRef.current) {
            clearTimeout(reattachTimerRef.current)
            reattachTimerRef.current = null
          }

          if (info.replayed) {
            setStatus('reattached')
            reattachTimerRef.current = setTimeout(() => {
              reattachTimerRef.current = null
              setStatus('open')
            }, REATTACHED_CHIP_MS)
          } else {
            setStatus('open')
          }

          const t = termRef.current

          if (t) {
            try {
              fitRef.current?.fit()
            } catch {
              /* ignore */
            }

            socketRef.current?.resize(t.cols, t.rows)
          }
        },
        onStatus: next => {
          if (!disposed && next === 'reconnecting') {
            setStatus('reconnecting')
          }
        }
      }
    )

    return () => {
      disposed = true

      if (reattachTimerRef.current) {
        clearTimeout(reattachTimerRef.current)
        reattachTimerRef.current = null
      }

      socketRef.current?.close()
      socketRef.current = null
    }
    // `connection`/`preference` are intentionally not deps — see the snapshot note
    // above; they are read from the atoms at spawn time. `id` is stable per mounted
    // pane (the map is keyed on it), so it never re-triggers a spawn.
  }, [attempt, fellBack, id])

  // Pinch to resize the type — the universal terminal gesture (Termius, Blink),
  // and the only practical answer to "80 columns don't fit on a phone": you zoom
  // out for a wide TUI and back in to read. Two pointers only, so it can never
  // interfere with scrolling or selection.
  useEffect(() => {
    const host = hostRef.current

    if (!IS_MOBILE || !host) {
      return
    }

    const points = new Map<number, { x: number; y: number }>()
    let startSpread = 0
    let startSize = 0

    const spread = () => {
      const [a, b] = [...points.values()]

      return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0
    }

    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === 'mouse') {
        return
      }

      points.set(event.pointerId, { x: event.clientX, y: event.clientY })

      if (points.size === 2) {
        startSpread = spread()
        startSize = termRef.current?.options.fontSize ?? MOBILE_FONT_SIZE
      }
    }

    const onPointerMove = (event: PointerEvent) => {
      if (!points.has(event.pointerId)) {
        return
      }

      points.set(event.pointerId, { x: event.clientX, y: event.clientY })

      const term = termRef.current

      if (points.size !== 2 || !term || startSpread <= 0) {
        return
      }

      const next = Math.round(Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, (startSize * spread()) / startSpread)))

      if (next !== term.options.fontSize) {
        term.options.fontSize = next

        try {
          fitRef.current?.fit()
        } catch {
          /* mid-transition */
        }
      }
    }

    const onPointerUp = (event: PointerEvent) => {
      points.delete(event.pointerId)
      startSpread = 0
    }

    host.addEventListener('pointerdown', onPointerDown)
    host.addEventListener('pointermove', onPointerMove)
    host.addEventListener('pointerup', onPointerUp)
    host.addEventListener('pointercancel', onPointerUp)

    return () => {
      host.removeEventListener('pointerdown', onPointerDown)
      host.removeEventListener('pointermove', onPointerMove)
      host.removeEventListener('pointerup', onPointerUp)
      host.removeEventListener('pointercancel', onPointerUp)
    }
  }, [])

  // Re-apply the WHOLE profile (text, bg, cursor, selection, all 16 ANSI) when
  // the skin or painted mode changes — not just the background.
  useEffect(() => {
    if (!termRef.current) {
      return
    }

    // rAF so ThemeProvider's CSS-variable repaint (a sibling effect that runs
    // after this one) has landed before resolveSurfaceColor probes the surface.
    const raf = requestAnimationFrame(() => {
      const term = termRef.current

      if (!term) {
        return
      }

      term.options.theme = buildTerminalTheme(appTheme, renderedMode)
      // WebGL caches glyph colors in a texture atlas, so a mode/skin switch
      // leaves already-drawn cells stale until the atlas is cleared (no-op on the
      // DOM fallback).
      webglRef.current?.clearTextureAtlas()
    })

    return () => cancelAnimationFrame(raf)
  }, [appTheme, renderedMode])

  // Display-only read of the live atoms: which host a NEW terminal would use, and
  // therefore which "no shell" sentence applies here. Mirrors the spawn effect's
  // override so a fallen-back pane is described as the local shell it actually is.
  const kind = fellBack ? 'local' : resolveTerminalTransportKind(terminalTransportInputs(connection, preference))
  const copy = end ? endCopy(t, end, kind) : null

  // Which machine you are typing into. A phone gives no ambient cue at all, and a
  // desktop on a remote gateway now shells somewhere other than itself — so the
  // chip shows for every remote shell, and the local one stays unlabelled (it's
  // the machine in front of you).
  const hostChip = status === 'open' && kind === 'remote' && shellHost ? shellHost : null

  return (
    <div className="flex h-full min-h-0 flex-col bg-(--ui-editor-surface-background) text-foreground">
      <div className="relative min-h-0 flex-1 p-2">
        {/* The outer div paints the inset padding; the inner div is the xterm host so
          the canvas sizes to the content area (FitAddon) and the p-2 reads as
          terminal padding. Both the padding and the xterm screen/viewport are the
          same --ui-editor-surface-background var, so the inset stays seamless. */}
        <div
          className="h-full min-h-0 overflow-hidden bg-(--ui-editor-surface-background) [&_.xterm-screen]:bg-(--ui-editor-surface-background)! [&_.xterm-viewport]:bg-(--ui-editor-surface-background)!"
          ref={hostRef}
        />

        {status === 'connecting' && (
          <div className="pointer-events-none absolute right-2 top-1 rounded bg-black/30 px-1.5 py-0.5 text-[0.65rem] text-white/80">
            {t.rightSidebar.terminalConnecting}
          </div>
        )}

        {/* An abnormal drop is being retried with backoff — the shell is kept alive
            server-side, so this is a wait, not a failure. */}
        {status === 'reconnecting' && (
          <div className="pointer-events-none absolute right-2 top-1 rounded bg-black/30 px-1.5 py-0.5 text-[0.65rem] text-white/80">
            {t.rightSidebar.terminalReconnecting}
          </div>
        )}

        {/* One-shot after a reattach: the burst of replayed scrollback is expected. */}
        {status === 'reattached' && (
          <div className="pointer-events-none absolute right-2 top-1 rounded bg-black/30 px-1.5 py-0.5 text-[0.65rem] text-white/80">
            {t.rightSidebar.terminalReattached}
          </div>
        )}

        {hostChip && (
          <div
            className="pointer-events-none absolute right-2 top-1 max-w-[60%] truncate rounded bg-black/25 px-1.5 py-0.5 text-[0.65rem] text-white/70"
            title={t.rightSidebar.terminalHostChip(hostChip)}
          >
            {t.rightSidebar.terminalHostChip(hostChip)}
          </div>
        )}

        {/* Stays for the session: the file tree is on the gateway and this shell is
            not, so the mismatch has to keep being visible, not fade out. */}
        {fellBack && status === 'open' && (
          <div
            className="pointer-events-none absolute right-2 top-1 max-w-[70%] truncate rounded bg-destructive/40 px-1.5 py-0.5 text-[0.65rem] text-white/90"
            title={t.rightSidebar.terminalLocalFallbackChip}
          >
            ⚠ {t.rightSidebar.terminalLocalFallbackChip}
          </div>
        )}

        {/* An ended shell gets a real explanation and a way out — never a blank
          rectangle the user has to guess about. */}
        {copy && (
          <div className="absolute inset-0 flex items-center justify-center bg-(--ui-editor-surface-background)/85 p-6">
            <div className="flex max-w-xs flex-col items-center gap-2 text-center">
              <div
                className={cn('text-sm font-medium', end?.kind === 'exited' ? 'text-foreground' : 'text-destructive')}
              >
                {copy.title}
              </div>
              <p className="text-xs text-muted-foreground">{copy.body}</p>
              {end?.detail && (
                <p className="max-h-16 overflow-y-auto font-code text-[0.65rem] break-words text-muted-foreground/80">
                  {end.detail}
                </p>
              )}
              <Button
                className="mt-1"
                onClick={() => {
                  // Re-probe: the gateway may have been upgraded since we asked, and a
                  // failed probe must not keep this pane on the device shell forever.
                  forgetGatewayFeatures($connection.get())
                  setFellBack(false)
                  setAttempt(value => value + 1)
                }}
                size="sm"
                variant="secondary"
              >
                {t.rightSidebar.terminalRestart}
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Esc, Tab, Ctrl and the arrows don't exist on a phone keyboard, and they
          are most of what a shell is driven by. No point showing the row once the
          shell is gone. */}
      {IS_MOBILE && status !== 'ended' && (
        <MobileTerminalKeys
          modifiers={modifiers}
          onCycleModifier={modifier =>
            setModifiers(current => ({ ...current, [modifier]: nextModifierState(current[modifier]) }))
          }
          onSend={data => {
            sendRef.current(data)
            // The row refuses focus, so the terminal still owns it — but a key
            // pressed before the user ever tapped the screen must still land.
            termRef.current?.focus()
          }}
        />
      )}
    </div>
  )
}
