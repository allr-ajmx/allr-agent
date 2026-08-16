/**
 * The wake indicator's NATIVE surface — a light over whatever the user is
 * actually looking at (MJXHRM-228).
 *
 * # What this is not
 *
 * It is not a second state machine. `store/wake-indicator.ts` decides when the
 * indicator is live and which of its three states it is in; this subscribes to
 * that atom and mirrors it into a window. Nothing here calls
 * `activateWakeIndicator` / `syncWakeIndicatorWithVoice` / `clearWakeIndicator`,
 * and nothing here re-derives a state from the voice conversation — two sinks
 * that each worked out the answer for themselves would eventually disagree, and
 * the one the user is looking at would be the wrong one.
 *
 * # Why a window at all
 *
 * A wake phrase is the one interaction with no on-screen cause. The app may not
 * be focused; it may not be visible. The in-window pill is only an
 * acknowledgement for someone already looking at Hermes — which, hands-free, is
 * exactly the case that does not apply. Desktop reached the same conclusion and
 * spends an always-on-top Electron panel on it (`electron/wake-indicator.ts`),
 * pinned to the top of the internal display, macOS only.
 *
 * # Where it degrades, and how honestly
 *
 * The capability is derived from the MECHANISM (`lib/surface.ts`), never from a
 * call that did not throw — `set_always_on_top` returns `Ok` on Wayland while
 * doing nothing at all. Three things have to be true, and each refusal leaves
 * the in-window pill as the presentation rather than nothing:
 *
 *  * a floating surface exists here (false on Android/iOS, and on any platform
 *    the backend cannot answer for);
 *  * it can actually stay above other windows — an indicator that appears
 *    *behind* the window the user is typing in is worse than one drawn inside
 *    Hermes, because it is invisible AND it is a window;
 *  * clicks pass through it. On the layer-shell backend the surface is
 *    output-sized, so a light that takes input is a light that eats every click
 *    on the desktop.
 *
 * So this is better than desktop's on Wayland+layer-shell (a real compositor
 * overlay), the same on X11/Windows/macOS (an always-on-top toplevel), and
 * absent where nothing can carry it — which is where the pill still is.
 */

import { IS_DESKTOP } from '@/lib/platform'
import { surfaceCapabilities } from '@/lib/surface'
import { atom } from '@/store/atom'
import { $wakeIndicator, type WakeIndicatorState } from '@/store/wake-indicator'
import {
  canOpenSatelliteWindow,
  closeSatelliteWindow,
  isSatelliteWindow,
  openSatelliteWindow,
  WAKE_INDICATOR_SURFACE
} from '@/store/windows'

import { emitWakeIndicatorState, onWakeIndicatorHello } from './channel'

/**
 * Whether the native light is on screen RIGHT NOW.
 *
 * Read by the in-window pill, which stands down while it is true. False while
 * the window is still opening on purpose: two lights for a moment is a cosmetic
 * fault, no light at all is the feature not working.
 */
export const $nativeWakeIndicator = atom(false)

/** Why the native surface is unavailable here, or null. Diagnostics only. */
let unavailableReason: null | string = null

/**
 * Can this platform carry a wake light over other applications?
 *
 * Deliberately not "did opening one throw". Every trait below is asked of the
 * capability layer before a window exists, because the two that matter most
 * fail SILENTLY: always-on-top is ignored by Wayland while reporting success,
 * and a click-through request that is quietly dropped leaves an output-sized
 * surface swallowing the desktop.
 *
 * Not cached here — `surfaceCapabilities()` already caches the round trip for
 * the process, and the rest of this is three comparisons. A second cache would
 * only be a second thing to reset.
 */
export async function canShowNativeWakeIndicator(): Promise<boolean> {
  if (!IS_DESKTOP || isSatelliteWindow() || !canOpenSatelliteWindow()) {
    unavailableReason = 'This platform has no second window to put the light in.'

    return false
  }

  const caps = await surfaceCapabilities()

  if (!caps.floatingSurface) {
    unavailableReason = caps.notes[0] ?? `${caps.platform} has no floating surface.`

    return false
  }

  if (caps.alwaysOnTop === 'unsupported') {
    unavailableReason =
      'A floating surface here cannot stay above other windows, so the light would appear behind them.'

    return false
  }

  if (caps.clickThrough !== 'supported') {
    unavailableReason = 'A floating surface here cannot pass clicks through, and the light must never take any.'

    return false
  }

  unavailableReason = null

  return true
}

/** The reason there is no native light, for a diagnostic surface to show. Null
 *  while one is possible, and before anything has asked. */
export function nativeWakeIndicatorUnavailableReason(): null | string {
  return unavailableReason
}

/**
 * Drive the native light from `$wakeIndicator`.
 *
 * Returns the uninstall, which closes the window: the light belongs to this
 * window's conversation and must never outlive the surface that armed it — the
 * satellite registry enforces that for a hard quit, and this covers the ordinary
 * unmount.
 */
export function installNativeWakeIndicator(): () => void {
  let stopped = false
  let open = false
  let stopHello: (() => void) | null = null
  // One at a time, in order. Opening a window and closing it are both async and
  // a wake conversation is short — an unserialized "hidden" arriving mid-open
  // would close nothing and leave the light on for the rest of the session.
  let queue: Promise<void> = Promise.resolve()

  const run = (step: () => Promise<void>): void => {
    queue = queue.then(step).catch(() => undefined)
  }

  const show = async (state: WakeIndicatorState): Promise<void> => {
    if (stopped || state === 'hidden') {
      return
    }

    if (!open) {
      if (!(await canShowNativeWakeIndicator())) {
        return
      }

      // The window's document loads after this resolves, so it may miss this
      // push entirely — hence the hello it sends back when it is ready.
      if (stopped || (await openSatelliteWindow(WAKE_INDICATOR_SURFACE)) === null) {
        return
      }

      open = true
      stopHello = subscribeHello()
      $nativeWakeIndicator.set(true)
    }

    await emitWakeIndicatorState(state)
  }

  const hide = async (): Promise<void> => {
    if (!open) {
      return
    }

    open = false
    stopHello?.()
    stopHello = null
    $nativeWakeIndicator.set(false)
    await closeSatelliteWindow(WAKE_INDICATOR_SURFACE)
  }

  const subscribeHello = (): (() => void) => {
    let off: (() => void) | undefined
    let gone = false

    void onWakeIndicatorHello(() => {
      // Answer with the LIVE state, not the one that opened the window: the
      // conversation can reach `capturing` while the window is still loading.
      void emitWakeIndicatorState($wakeIndicator.get())
    })
      .then(stop => {
        off = stop

        if (gone) {
          stop()
        }
      })
      .catch(() => undefined)

    return () => {
      gone = true
      off?.()
    }
  }

  const off = $wakeIndicator.listen(state => {
    run(() => (state === 'hidden' ? hide() : show(state)))
  })

  // A light already lit when this installs is one to show, not one to wait for.
  // `listen` (not `subscribe`) plus this, rather than `subscribe` alone, so the
  // ordinary case — installed at boot with the indicator hidden — does not run a
  // no-op through the queue before anything has happened.
  const initial = $wakeIndicator.get()

  if (initial !== 'hidden') {
    run(() => show(initial))
  }

  return () => {
    stopped = true
    off()
    run(hide)
  }
}
