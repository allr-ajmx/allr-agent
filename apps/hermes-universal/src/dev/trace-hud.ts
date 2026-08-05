/**
 * Floating tracer HUD — the span recorder's controls, deliberately outside the app.
 *
 * The panel chrome (drag, collapse, hide, position persistence) and the argument
 * for why these HUDs are raw DOM rather than React components both live in
 * `dev/hud-shell.ts`. The short version: a `setState` four times a second on a
 * component mounted inside the app shell perturbs exactly the frames it exists
 * to measure, and a profiler that shows up in its own profile is worse than no
 * profiler because the numbers look real.
 *
 * What is left here is the tracer-specific part: the transport controls, the
 * counters, and the cadence they are read at.
 *
 * DEV/BENCH ONLY, installed from observability/install.ts behind the same gate as
 * the exporter it drives.
 */

import { invoke } from '@tauri-apps/api/core'

import { JAEGER_UI, tracer } from '@/observability/exporter'

import { BUTTON, createHudShell, DIM, el, FIELD, ROW } from './hud-shell'

/**
 * Counter cadence, by what there is to see.
 *
 * A tick that finds nothing changed writes nothing and costs a handful of
 * property reads, so the fast rate is only paid while a capture is actually
 * running and visible. Collapsed means no timer at all: the pill shows recording
 * state, and that arrives by subscription the moment it changes.
 */
const LIVE_MS = 500
const IDLE_MS = 2_000

const PANEL_W = 250

export function installTraceHud(): () => void {
  if (typeof document === 'undefined' || !document.body) {
    return () => {}
  }

  const shell = createHudShell({
    defaultPosition: ({ width }) => ({ x: Math.max(0, width - PANEL_W - 20), y: 52 }),
    id: 'trace',
    onChrome: () => {
      schedule()
      tick()
    },
    title: 'trace',
    width: PANEL_W
  })

  // ── body ──────────────────────────────────────────────────────────────────
  const recordButton = el('button', `${BUTTON};flex:1 1 auto`, '● record')
  const flushButton = el('button', BUTTON, 'flush')
  const clearButton = el('button', BUTTON, 'clear')
  const transport = el('div', ROW)

  transport.append(recordButton, flushButton, clearButton)

  const counters = el('div', 'display:flex;justify-content:space-between;opacity:.65')
  const spansOut = el('span', '', '0 spans')
  const openOut = el('span', '', '0 open')
  const flushOut = el('span', '', 'no flush')

  counters.append(spansOut, openOut, flushOut)

  const autoLabel = el('label', `${ROW};opacity:.65;cursor:pointer`)
  const autoBox = el('input', 'margin:0')

  autoBox.type = 'checkbox'

  const autoText = el('span', '', 'auto-drain')

  autoLabel.append(autoBox, autoText)

  const runInput = el('input', `${FIELD};width:100%`)

  runInput.placeholder = 'run label'

  const markRow = el('div', ROW)
  const markInput = el('input', `${FIELD};flex:1 1 auto`)

  markInput.placeholder = 'mark…'

  const markButton = el('button', BUTTON, 'mark')

  markRow.append(markInput, markButton)

  const readRow = el('div', ROW)
  const timelineButton = el('button', `${BUTTON};flex:1 1 auto`, 'timeline')
  const copyButton = el('button', BUTTON, 'copy')
  const jaegerButton = el('button', BUTTON, 'jaeger ↗')

  readRow.append(timelineButton, copyButton, jaegerButton)
  shell.body.append(transport, counters, autoLabel, runInput, markRow, readRow)

  // ── live state ────────────────────────────────────────────────────────────

  let timer = 0
  // Last value WRITTEN to the DOM. Every update compares against these first,
  // so a tick during an idle capture touches nothing at all.
  const painted = { auto: null as boolean | null, flush: '', open: '', recording: null as boolean | null, spans: '' }

  const setText = (node: HTMLElement, key: 'flush' | 'open' | 'spans', next: string) => {
    if (painted[key] !== next) {
      painted[key] = next
      node.textContent = next
    }
  }

  function tick(): void {
    const status = tracer.status()

    if (painted.recording !== status.recording) {
      painted.recording = status.recording
      shell.dot.style.background = status.recording ? '#ef4444' : DIM
      recordButton.textContent = status.recording ? '■ stop' : '● record'
      shell.title.textContent = status.recording ? `trace · capture ${status.capture}` : 'trace'
      markButton.disabled = !status.recording
      // The cadence follows the state, so stopping a capture also stops paying
      // for it.
      schedule()
    }

    if (shell.isCollapsed()) {
      return
    }

    setText(spansOut, 'spans', `${status.spans} spans`)
    setText(openOut, 'open', `${status.openSpans} open`)
    setText(
      flushOut,
      'flush',
      status.sinceFlushMs === 0 ? 'no flush' : `${Math.round(status.sinceFlushMs / 1000)}s ago`
    )

    if (painted.auto !== status.autoFlush) {
      painted.auto = status.autoFlush
      autoBox.checked = status.autoFlush
      autoText.textContent = status.autoFlush ? 'auto-drain' : 'auto-drain off — spans stay local'
    }

    // Never while focused: the run label is editable, and overwriting the field
    // under a cursor is the classic way to make an input unusable.
    if (document.activeElement !== runInput && runInput.value !== status.run) {
      runInput.value = status.run
    }
  }

  function schedule(): void {
    window.clearInterval(timer)
    timer = 0

    // Nothing to read while collapsed or hidden, and nothing to read while the
    // window is in the background either.
    if (shell.isCollapsed() || shell.isHidden() || document.hidden) {
      return
    }

    timer = window.setInterval(tick, tracer.status().recording ? LIVE_MS : IDLE_MS)
  }

  // ── wiring ────────────────────────────────────────────────────────────────

  recordButton.addEventListener('click', () => {
    if (tracer.status().recording) {
      void tracer.off()
    } else {
      tracer.on()
    }
  })

  flushButton.addEventListener('click', () => void tracer.flush())
  clearButton.addEventListener('click', () => tracer.clear())
  autoBox.addEventListener('change', () => tracer.autoflush(autoBox.checked))
  runInput.addEventListener('input', () => tracer.run(runInput.value))

  const submitMark = () => {
    tracer.mark(markInput.value.trim())
    markInput.value = ''
  }

  markButton.addEventListener('click', submitMark)
  markInput.addEventListener('keydown', event => event.key === 'Enter' && submitMark())

  timelineButton.addEventListener('click', () => tracer.timeline())

  copyButton.addEventListener('click', () => {
    const json = JSON.stringify(tracer.otlp())

    // Console fallback rather than a silently dead button: WebKitGTK gates
    // `navigator.clipboard` on a secure context, and the dev server is plain
    // http on some of the setups this runs on.
    navigator.clipboard?.writeText(json).catch(() => console.log(json)) ?? console.log(json)
  })

  jaegerButton.addEventListener('click', () => {
    const tags = encodeURIComponent(JSON.stringify({ 'hermes.run': tracer.status().run }))
    const url = `${JAEGER_UI}/search?service=hermes-universal&tags=${tags}`

    // The system browser, via the same Rust command the app's external links
    // use — a webview `window.open` opens inside the app, or nowhere.
    void invoke('open_external', { url }).catch(() => window.open(url, '_blank', 'noopener'))
  })

  const onVisibility = () => schedule()

  document.addEventListener('visibilitychange', onVisibility)

  // First sync, now that every control above exists. The shell deliberately does
  // NOT call back into us during construction — see `applyDisplay` there.
  schedule()
  tick()

  // Control changes arrive by subscription rather than by polling for them, so
  // a console call and the panel can never show different things.
  const unsubscribe = tracer.subscribe(tick)

  // `__hermesTrace.hud()` is the way back from the × — deliberately not a global
  // hotkey, because this app has a rebindable keybind registry and a raw listener
  // here would be a second, invisible source of truth for shortcuts.
  //
  // CREATES the object if the console surface hasn't yet. It used to attach only
  // when `installTraceConsole()` had already run, which made the only escape from
  // the × contingent on load order — and a HUD you can close but not reopen is a
  // trap, not a control. The console surface merges into whatever it finds.
  const globals = window as unknown as { __hermesTrace?: Record<string, unknown> }
  const consoleApi = (globals.__hermesTrace ??= {})

  consoleApi.hud = (show = true) => {
    shell.setHidden(!show)

    return `hud ${show ? 'shown' : 'hidden'}`
  }

  return () => {
    window.clearInterval(timer)
    unsubscribe()
    document.removeEventListener('visibilitychange', onVisibility)
    shell.destroy()
  }
}
