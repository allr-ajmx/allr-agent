//! Keep-awake (desktop): hold one system-sleep inhibitor for as long as the
//! user's preference says to.
//!
//! Mirrors the desktop app's `powerSaveBlocker('prevent-app-suspension')`: the
//! machine stays up so a long or overnight run keeps going, while the display is
//! still free to dim and lock. The webview owns the preference and mirrors it
//! down here; this module owns the single native handle — the same authority
//! split as translucency. The handle releases on drop, so quitting can never
//! strand an inhibitor.
//!
//! `set` answers with the state that ACTUALLY resulted, not just "no error" —
//! the same contract as desktop's `createKeepAwake.set(on): boolean`. Asking for
//! an inhibitor is a request the OS is free to refuse: there is no logind on a
//! musl/WSL/Devuan box, no system bus inside a sandboxed Flatpak, and
//! `SetThreadExecutionState` can fail on Windows. A caller that only sees
//! `Ok(())` cannot tell "held" from "quietly not held", and the switch upstairs
//! would keep promising an overnight run that the machine sleeps through.

#[cfg(desktop)]
mod imp {
    use std::sync::Mutex;

    /// The live inhibitor, or `None` while the machine is free to sleep.
    #[derive(Default)]
    pub struct KeepAwakeState(Mutex<Option<keepawake::KeepAwake>>);

    /// Hold or release the inhibitor; returns whether one is held afterwards.
    pub fn set(state: &KeepAwakeState, on: bool) -> Result<bool, String> {
        // Recover a poisoned lock instead of refusing it. Poisoning here means an
        // earlier call panicked, not that the `Option` is unsound — and refusing
        // to touch it would strand a HELD inhibitor with no path left to release
        // it, keeping the machine awake for the rest of the process's life.
        let mut held = state.0.lock().unwrap_or_else(|err| err.into_inner());

        // Idempotent both ways: dropping releases, and re-arming an already-held
        // inhibitor would leak the first one.
        if !on {
            held.take();

            return Ok(false);
        }

        if held.is_some() {
            return Ok(true);
        }

        let awake = keepawake::Builder::default()
            // System sleep only — the screen may still dim and lock, matching
            // `prevent-app-suspension` rather than `prevent-display-sleep`.
            .display(false)
            .idle(true)
            .sleep(true)
            .reason("Hermes is running a long task")
            .app_name("Hermes")
            .app_reverse_domain("com.jaxmatrix.mjx-unofficial-hermes")
            .create()
            .map_err(|err| err.to_string())?;

        *held = Some(awake);

        Ok(true)
    }

    /// Test-only: poison the lock exactly the way a panic inside `set` would.
    #[cfg(test)]
    pub fn poison_for_test(state: &KeepAwakeState) {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));

        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = state.0.lock().unwrap();

            panic!("poisoning the keep-awake lock");
        }));

        std::panic::set_hook(previous);
    }
}

// Phones and tablets sleep on their own terms; there is no equivalent lever the
// webview should be reaching for. The TS caller gates on `IS_DESKTOP` and never
// arrives here.
#[cfg(mobile)]
mod imp {
    #[derive(Default)]
    pub struct KeepAwakeState;

    pub fn set(_state: &KeepAwakeState, _on: bool) -> Result<bool, String> {
        Err("unsupported_platform".to_string())
    }
}

pub use imp::KeepAwakeState;

/// Hold or release the system-sleep inhibitor. Answers with what is held now.
#[tauri::command]
pub fn set_keep_awake(state: tauri::State<'_, KeepAwakeState>, on: bool) -> Result<bool, String> {
    imp::set(&state, on)
}

#[cfg(all(test, desktop))]
mod tests {
    use super::imp::{poison_for_test, set, KeepAwakeState};

    // The environments this ships into do not all have a logind to inhibit
    // (CI containers, WSL, musl distros), so arming is allowed to fail here —
    // what must hold is that the answer describes reality either way, and that
    // releasing always succeeds.
    #[test]
    fn reports_what_is_actually_held() {
        let state = KeepAwakeState::default();

        assert_eq!(set(&state, false), Ok(false), "nothing held to begin with");

        match set(&state, true) {
            // Arming twice must not mint a second inhibitor, and must keep
            // answering `true`.
            Ok(held) => {
                assert!(held);
                assert_eq!(set(&state, true), Ok(true), "re-arm is idempotent");
            }
            // A refusal must be an Err — never a cheerful `Ok(true)` for an
            // inhibitor that was never taken.
            Err(err) => assert!(!err.is_empty(), "a refusal must say why"),
        }

        assert_eq!(set(&state, false), Ok(false), "release always succeeds");
    }

    // A panic under the lock used to turn every later call into
    // `keep_awake_state_poisoned` — including the one that releases. That left a
    // held inhibitor with no way off: the machine stays awake for the rest of the
    // process's life and the switch upstairs can do nothing about it.
    #[test]
    fn a_poisoned_lock_can_still_release() {
        let state = KeepAwakeState::default();

        poison_for_test(&state);

        assert_eq!(set(&state, false), Ok(false));
    }
}
