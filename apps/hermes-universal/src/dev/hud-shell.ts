/**
 * The shared chrome behind the dev HUDs — panel, header, drag, collapse, hide,
 * position persistence.
 *
 * Extracted when the FPS HUD arrived rather than copied, because the parts worth
 * keeping identical are exactly the parts that are easy to get subtly wrong the
 * second time: the containment declaration, the transform-based positioning, and
 * the rule that a hidden HUD costs nothing.
 *
 * WHY THESE HUDS ARE NOT REACT COMPONENTS
 *
 * A dev instrument mounted inside the app shell perturbs what it measures. Its
 * renders enter the app's React commits, every parent re-render re-renders it,
 * and a `position: fixed` element whose text changes several times a second
 * invalidates style and layout past its own box. A profiler that shows up in its
 * own profile is worse than no profiler, because the numbers look real.
 *
 * So: raw DOM, inline styles (the panel must render before the app's stylesheet
 * and theme variables exist), appended to `<body>` at boot from
 * `observability/install.ts`. That also means a HUD is up before the first app
 * render and survives a blank screen — which is exactly the state someone
 * reaches for one in.
 */

const KEY = (id: string, part: string) => `hermes.${id}-hud-${part}.v1`

export interface Point {
  x: number
  y: number
}

export function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)

    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

export function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // ignore (private mode / quota)
  }
}

export function el<K extends keyof HTMLElementTagNameMap>(
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

export const BUTTON =
  'flex:0 0 auto;border:1px solid rgba(255,255,255,.16);background:transparent;color:inherit;font:inherit;border-radius:4px;padding:1px 6px;cursor:pointer'

// `user-select` is inherited from the panel, which turns it off so a drag never
// selects the readout. The text fields have to opt back in or they cannot be
// edited.
export const FIELD =
  'min-width:0;border:1px solid rgba(255,255,255,.16);background:rgba(0,0,0,.25);color:inherit;font:inherit;border-radius:4px;padding:1px 4px;-webkit-user-select:text;user-select:text'

export const ROW = 'display:flex;gap:4px;align-items:center'

export const DIM = 'rgba(255,255,255,.3)'

export interface HudShell {
  panel: HTMLElement
  header: HTMLElement
  body: HTMLElement
  /** Status dot in the header — colour is the HUD's to set. */
  dot: HTMLElement
  /** Header label. HUDs overwrite it to carry state while collapsed. */
  title: HTMLElement
  isCollapsed: () => boolean
  isHidden: () => boolean
  setHidden: (next: boolean) => void
  destroy: () => void
}

export interface HudShellOptions {
  /** Storage namespace and console-name stem, e.g. `'trace'` / `'fps'`. */
  id: string
  title: string
  width: number
  /** Default top-left, given the viewport. Stacked so two HUDs don't overlap. */
  defaultPosition: (viewport: { width: number; height: number }) => Point
  /** Called after collapsed/hidden changes, so the owner can start or stop its
   *  own work. A hidden HUD must cost nothing. */
  onChrome: (state: { collapsed: boolean; hidden: boolean }) => void
}

export function createHudShell(options: HudShellOptions): HudShell {
  const positionKey = KEY(options.id, 'position')
  const collapsedKey = KEY(options.id, 'collapsed')
  const hiddenKey = KEY(options.id, 'hidden')

  const clampPoint = (x: number, y: number): Point => ({
    x: Math.min(Math.max(0, x), Math.max(0, (window.innerWidth || 800) - options.width)),
    y: Math.min(Math.max(0, y), Math.max(0, (window.innerHeight || 600) - 48))
  })

  const panel = el(
    'div',
    [
      `position:fixed;left:0;top:0;width:${options.width}px;z-index:2147483000`,
      // Its own layer, and a hard boundary on what its repaints can invalidate.
      // Without this a text change reaches the document's style and layout —
      // the instrument showing up in its own measurements again.
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

  const header = el('div', `${ROW};padding:3px 6px;cursor:grab`)
  const dot = el('span', `flex:0 0 auto;width:7px;height:7px;border-radius:50%;background:${DIM}`)
  const title = el('span', 'flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.7', options.title)
  const collapseButton = el('button', BUTTON, '–')
  const hideButton = el('button', BUTTON, '×')

  header.append(dot, title, collapseButton, hideButton)

  const body = el(
    'div',
    'display:flex;flex-direction:column;gap:5px;padding:5px 6px;border-top:1px solid rgba(255,255,255,.12)'
  )

  panel.append(header, body)

  // `transform`, not `left`/`top`: a transform change is a compositor move, so
  // dragging the panel around does not lay out the page underneath it.
  const fallback = options.defaultPosition({ height: window.innerHeight || 600, width: window.innerWidth || 800 })
  const saved = read<Point>(positionKey, fallback)
  let position = clampPoint(saved.x ?? fallback.x, saved.y ?? fallback.y)

  const place = () => {
    panel.style.transform = `translate3d(${position.x}px,${position.y}px,0)`
  }

  place()

  let collapsed = read(collapsedKey, false)
  let hidden = read(hiddenKey, false)

  /**
   * Display only — safe to call before the owner has built its body.
   *
   * Split from the `onChrome` notification deliberately. When they were one
   * function, constructing the shell called back into the owner, which reaches
   * for `const` bindings declared BELOW the `createHudShell(...)` call — the
   * temporal dead zone. That throws a `ReferenceError` mid-install, and what you
   * get is a HUD with its header and an empty body: visibly broken, silently.
   */
  function applyDisplay(): void {
    panel.style.display = hidden ? 'none' : ''
    body.style.display = collapsed ? 'none' : ''
    collapseButton.textContent = collapsed ? '+' : '–'
  }

  /** A user toggle: safe to notify, because the owner is fully constructed by
   *  the time anyone can click. */
  function applyChrome(): void {
    applyDisplay()
    options.onChrome({ collapsed, hidden })
  }

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
    write(positionKey, position)
  }

  header.addEventListener('pointerup', endDrag)
  header.addEventListener('pointercancel', endDrag)

  collapseButton.addEventListener('click', () => {
    collapsed = !collapsed
    write(collapsedKey, collapsed)
    applyChrome()
  })

  const setHidden = (next: boolean) => {
    hidden = next
    write(hiddenKey, hidden)
    applyChrome()
  }

  hideButton.addEventListener('click', () => setHidden(true))

  const onResize = () => {
    position = clampPoint(position.x, position.y)
    place()
  }

  window.addEventListener('resize', onResize)
  document.body.appendChild(panel)
  // NOT applyChrome: see above. The owner runs its own first sync once its body
  // exists.
  applyDisplay()

  return {
    body,
    destroy: () => {
      window.removeEventListener('resize', onResize)
      panel.remove()
    },
    dot,
    header,
    isCollapsed: () => collapsed,
    isHidden: () => hidden,
    panel,
    setHidden,
    title
  }
}
