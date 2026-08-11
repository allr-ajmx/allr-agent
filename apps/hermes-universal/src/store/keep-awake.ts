import { translateNow } from '@/i18n'
import { Codecs, persistentAtom } from '@/lib/persisted'
import { IS_DESKTOP } from '@/lib/platform'
import { notifyError } from '@/store/notifications'

// Keep-awake — stop the machine sleeping through a long, unattended run.
//
// A device-local preference (each computer keeps its own), off by default. The
// webview owns the value and persists it; Rust holds the one native inhibitor
// (`set_keep_awake`, keep_awake.rs) and re-arms it from `initKeepAwake()` at
// boot. Desktop-only: phones sleep on their own terms, so this is a no-op there
// and the UI hides the controls.
//
// The atom tracks what is ACTUALLY held, not what was asked for. Taking an
// inhibitor is a request the OS can refuse — there is no logind under WSL or on
// a non-systemd distro, and a sandboxed build may not reach the system bus at
// all — and this switch's whole job is to promise a run survives the night. A
// promise that quietly failed is worse than no switch, so a refusal flips the
// preference back off and says so.
export const $keepAwake = persistentAtom<boolean>('hermes.keepAwake', false, Codecs.bool)

/**
 * Mirror the preference down to Rust; resolves with what is held afterwards.
 *
 * Off desktop there is no lever and no controls, so the ask is reported back
 * verbatim rather than being treated as a failure. Everything else — a missing
 * Tauri runtime, a command that rejects, an OS that refuses — throws, because
 * the caller has to be able to tell "held" from "quietly not held".
 */
export async function applyKeepAwake(on: boolean): Promise<boolean> {
  if (!IS_DESKTOP) {
    return on
  }

  const { invoke } = await import('@tauri-apps/api/core')

  return await invoke<boolean>('set_keep_awake', { on })
}

// Only the newest ask may correct the atom. Without this a slow reply to an
// earlier toggle would land after a later one and undo it.
let generation = 0

function reconcile(on: boolean): void {
  const mine = ++generation

  void applyKeepAwake(on)
    .then(held => {
      if (generation === mine && held !== on) {
        $keepAwake.set(held)
      }
    })
    .catch((error: unknown) => {
      // Superseded: the newer ask reports its own outcome, and two toasts for one
      // switch would only confuse.
      if (generation !== mine) {
        return
      }

      // The ask did not take, so we are where we were: a refused arm holds
      // nothing, and a refused release leaves the machine still held. Either way
      // the switch — and the lit statusbar sun — must stop claiming otherwise.
      $keepAwake.set(!on)

      notifyError(error, translateNow('settings.config.keepAwakeFailed'))
    })
}

export function setKeepAwake(on: boolean): void {
  $keepAwake.set(on)
  reconcile(on)
}

export function toggleKeepAwake(): void {
  setKeepAwake(!$keepAwake.get())
}

/**
 * Re-assert the persisted preference once at startup.
 *
 * The inhibitor dies with the process, so a relaunch has to take it again or the
 * toggle reads "on" over a machine that is free to sleep. Nothing to do when the
 * preference is off — a fresh process holds nothing — and skipping that case
 * keeps a boot on a machine with no inhibitor to give from opening with a toast
 * about a lever the user never pulled.
 */
export function initKeepAwake(): void {
  if (!$keepAwake.get()) {
    return
  }

  reconcile(true)
}
