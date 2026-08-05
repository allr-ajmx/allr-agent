/**
 * Floating tracer HUD — the span recorder's controls, deliberately outside the app.
 *
 * WHY THIS IS NOT A REACT COMPONENT
 *
 * The first version was, and it was a bad instrument: a `setState` four times a
 * second, on a component mounted inside the app shell. That is three separate
 * ways to perturb the thing being measured.
 *
 *   1. Its renders entered the app's React commits, so the tracer's own work
 *      landed in the same frames as the work under investigation — and in the
 *      spans recording them.
 *   2. Being inside the app tree, every parent re-render re-rendered it. During
 *      streaming, which is when it is most needed, that is constant.
 *   3. A `position: fixed` element with no containment, whose text changed at
 *      4Hz, invalidates style and layout beyond its own box.
 *
 * A profiler that shows up in its own profile is worse than no profiler, because
 * the numbers look real. So this owns raw DOM, updates by writing `textContent`
 * only when a value actually changed, and never touches React or the app's
 * stores. `installTraceHud()` appends it to `<body>` at boot, independent of
 * connection state, routing, or whether the app rendered at all — which also
 * means it still works when the thing you are debugging is a blank screen.
 *
 * Inline styles rather than Tailwind classes for the same reason: the panel must
 * render correctly before the app's stylesheet and theme variables exist.
 *
 * DEV/BENCH ONLY, installed from observability/install.ts behind the same gate as
 * the exporter it drives.
 */

import { invoke } from '@tauri-apps/api/core'

import { JAEGER_UI, tracer } from '@/observability/exporter'

const POSITION_KEY = 'hermes.trace-hud-position.v1'
const COLLAPSED_KEY = 'hermes.trace-hud-collapsed.v1'
const HIDDEN_KEY = 'hermes.trace-hud-hidden.v1'

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

interface Point {
  x: number
  y: number
}

function clampPoint(x: number, y: number): Point {
  return {
    x: Math.min(Math.max(0, x), Math.max(0, (window.innerWidth || 800) - PANEL_W)),
    y: Math.min(Math.max(0, y), Math.max(0, (window.innerHeight || 600) - 48))
  }
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)

    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // ignore (private mode / quota)
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  style: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)

  node.style.cssText = style

  if (text !== undefined) {
    node.textContent = text
  }

  return node
}

const BUTTON =
  'flex:0 0 auto;border:1px solid rgba(255,255,255,.16);background:transparent;color:inherit;font:inherit;border-radius:4px;padding:1px 6px;cursor:pointer'

// `user-select` is inherited from the panel, which turns it off so a drag never
// selects the readout. The text fields have to opt back in or they cannot be
// edited.
const FIELD =
  'min-width:0;border:1px solid rgba(255,255,255,.16);background:rgba(0,0,0,.25);color:inherit;font:inherit;border-radius:4px;padding:1px 4px;-webkit-user-select:text;user-select:text'

const ROW = 'display:flex;gap:4px;align-items:center'

export function installTraceHud(): () => void {
  if (typeof document === 'undefined' || !document.body) {
    return () => {}
  }

  const panel = el(
    'div',
    [
      'position:fixed;left:0;top:0;width:' + PANEL_W + 'px;z-index:2147483000',
      // Its own layer, and a hard boundary on what its repaints can invalidate.
      // Without this a text change reaches the document's style and layout —
      // the tracer showing up in its own measurements again.
      //
      // Declared twice on purpose: CSS drops a whole declaration if ANY keyword
      // in it is unrecognised, and this runs on WebKitGTK rather than Chromium.
      // The narrow form survives if `style` is not understood, so the fallback
      // is reduced containment rather than none.
      'contain:layout paint;contain:layout style paint',
      'will-change:transform;transform:translate3d(0,0,0)',
      'font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#e8e8ea',
      'background:rgba(18,18,22,.94);border:1px solid rgba(255,255,255,.16);border-radius:8px',
      'box-shadow:0 6px 24px rgba(0,0,0,.4)',
      '-webkit-user-select:none;user-select:none',
      // The webview treats the titlebar band as an OS drag region, which wins
      // hit-testing over the DOM regardless of z-index.
      '-webkit-app-region:no-drag'
    ].join(';')
  )

  // ── header ────────────────────────────────────────────────────────────────
  const header = el('div', `${ROW};padding:3px 6px;cursor:grab`)
  const dot = el('span', 'flex:0 0 auto;width:7px;height:7px;border-radius:50%;background:rgba(255,255,255,.3)')
  const title = el('span', 'flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.7', 'trace')
  const collapseButton = el('button', BUTTON, '–')
  const hideButton = el('button', BUTTON, '×')

  header.append(dot, title, collapseButton, hideButton)

  // ── body ──────────────────────────────────────────────────────────────────
  const body = el('div', 'display:flex;flex-direction:column;gap:5px;padding:5px 6px;border-top:1px solid rgba(255,255,255,.12)')

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
  body.append(transport, counters, autoLabel, runInput, markRow, readRow)
  panel.append(header, body)

  // ── position ──────────────────────────────────────────────────────────────
  //
  // `transform`, not `left`/`top`: a transform change is a compositor move, so
  // dragging the panel around does not lay out the page underneath it.
  const saved = read<Point>(POSITION_KEY, { x: (window.innerWidth || 800) - PANEL_W - 20, y: 52 })
  let position = clampPoint(saved.x ?? 0, saved.y ?? 0)

  const place = () => {
    panel.style.transform = `translate3d(${position.x}px,${position.y}px,0)`
  }

  place()

  // ── live state ────────────────────────────────────────────────────────────

  let collapsed = read(COLLAPSED_KEY, false)
  let hidden = read(HIDDEN_KEY, false)
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
      dot.style.background = status.recording ? '#ef4444' : 'rgba(255,255,255,.3)'
      recordButton.textContent = status.recording ? '■ stop' : '● record'
      title.textContent = status.recording ? `trace · capture ${status.capture}` : 'trace'
      markButton.disabled = !status.recording
      // The cadence follows the state, so stopping a capture also stops paying
      // for it.
      schedule()
    }

    if (collapsed) {
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
    if (collapsed || hidden || document.hidden) {
      return
    }

    timer = window.setInterval(tick, tracer.status().recording ? LIVE_MS : IDLE_MS)
  }

  function applyChrome(): void {
    panel.style.display = hidden ? 'none' : ''
    body.style.display = collapsed ? 'none' : ''
    collapseButton.textContent = collapsed ? '+' : '–'
    schedule()
    tick()
  }

  // ── wiring ────────────────────────────────────────────────────────────────

  const drag = { dx: 0, dy: 0, on: false }

  header.addEventListener('pointerdown', event => {
    if (event.target !== header && event.target !== dot && event.target !== title) {
      return
    }

    drag.on = true
    drag.dx = event.clientX - position.x
    drag.dy = event.clientY - position.y
    header.setPointerCapture(event.pointerId)
    header.style.cursor = 'grabbing'
  })

  header.addEventListener('pointermove', event => {
    if (!drag.on) {
      return
    }

    position = clampPoint(event.clientX - drag.dx, event.clientY - drag.dy)
    place()
  })

  const endDrag = (event: PointerEvent) => {
    if (!drag.on) {
      return
    }

    drag.on = false
    header.releasePointerCapture?.(event.pointerId)
    header.style.cursor = 'grab'
    write(POSITION_KEY, position)
  }

  header.addEventListener('pointerup', endDrag)
  header.addEventListener('pointercancel', endDrag)

  collapseButton.addEventListener('click', () => {
    collapsed = !collapsed
    write(COLLAPSED_KEY, collapsed)
    applyChrome()
  })

  hideButton.addEventListener('click', () => setHudVisible(false))

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

  const onResize = () => {
    position = clampPoint(position.x, position.y)
    place()
  }

  const onVisibility = () => schedule()

  window.addEventListener('resize', onResize)
  document.addEventListener('visibilitychange', onVisibility)

  // Control changes arrive by subscription rather than by polling for them, so
  // a console call and the panel can never show different things.
  const unsubscribe = tracer.subscribe(tick)

  function setHudVisible(next: boolean): void {
    hidden = !next
    write(HIDDEN_KEY, hidden)
    applyChrome()
  }

  document.body.appendChild(panel)
  applyChrome()

  // `__hermesTrace.hud()` is the way back from the × — deliberately not a global
  // hotkey, because this app has a rebindable keybind registry and a raw listener
  // here would be a second, invisible source of truth for shortcuts. Installed
  // after the console surface (see observability/install.ts), so the object it
  // attaches to already exists.
  const consoleApi = (window as unknown as { __hermesTrace?: Record<string, unknown> }).__hermesTrace

  if (consoleApi) {
    consoleApi.hud = (show = true) => {
      setHudVisible(show)

      return `hud ${show ? 'shown' : 'hidden'}`
    }
  }

  return () => {
    window.clearInterval(timer)
    unsubscribe()
    window.removeEventListener('resize', onResize)
    document.removeEventListener('visibilitychange', onVisibility)
    panel.remove()
  }
}
