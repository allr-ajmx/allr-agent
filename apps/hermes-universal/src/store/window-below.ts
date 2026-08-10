/**
 * Answer the agent's `window.read.request` with what is actually underneath the
 * app (MJXHRM-213).
 *
 * The routing for this already existed — `store/agent-read-requests.ts` listens
 * for the frame, parks it, and answers whatever a registered reader returns.
 * What did not exist was a reader, so every request got the empty answer that
 * both the tool and the model read as "nothing on screen". This registers one.
 *
 * The reader returns the capability layer's answer VERBATIM, including its
 * refusals. That is deliberate: `{ error: … }` tells the model that the window
 * underneath could not be read and why, while an empty answer tells it the
 * screen is empty. Only one of those is true on macOS, and it is not the second.
 */

import { IS_DESKTOP } from '@/lib/platform'
import { readWindowBelow } from '@/lib/surface'
import { registerWindowBelowReader } from '@/store/agent-read-requests'
import { isSatelliteWindow } from '@/store/windows'

/**
 * Install the reader. Idempotent per window; returns the unregister.
 *
 * Registered only by the PRIMARY window even though every window shares this
 * module: the registry holds exactly one reader, and two windows racing to own
 * it would make the answer depend on which one booted last. The answer is
 * process-scoped anyway — Hyprland reports a pid, not a window — so the primary
 * window's reading is the same reading any of them would get.
 */
export function installWindowBelowReader(): () => void {
  if (!IS_DESKTOP || isSatelliteWindow()) {
    return () => {}
  }

  return registerWindowBelowReader(() => readWindowBelow())
}
