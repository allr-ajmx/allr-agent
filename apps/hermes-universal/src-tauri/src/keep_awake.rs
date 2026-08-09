//! Keep-awake (desktop): hold one system-sleep inhibitor for as long as the
//! user's preference says to.
//!
//! Mirrors the desktop app's `powerSaveBlocker('prevent-app-suspension')`: the
//! machine stays up so a long or overnight run keeps going, while the display is
//! still free to dim and lock. The webview owns the preference and mirrors it
//! down here; this module owns the single native handle — the same authority
//! split as translucency. The handle releases on drop, so quitting can never
//! strand an inhibitor.

#[cfg(desktop)]
mod imp {
    use std::sync::Mutex;

    /// The live inhibitor, or `None` while the machine is free to sleep.
    #[derive(Default)]
    pub struct KeepAwakeState(Mutex<Option<keepawake::KeepAwake>>);

    pub fn set(state: &KeepAwakeState, on: bool) -> Result<(), String> {
        let mut held = state
            .0
            .lock()
            .map_err(|_| "keep_awake_state_poisoned".to_string())?;

        // Idempotent both ways: dropping releases, and re-arming an already-held
        // inhibitor would leak the first one.
        if !on {
            held.take();

            return Ok(());
        }

        if held.is_some() {
            return Ok(());
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

        Ok(())
    }
}

// Phones and tablets sleep on their own terms; there is no equivalent lever the
// webview should be reaching for. The TS caller gates on `IS_DESKTOP` and never
// arrives here.
#[cfg(mobile)]
mod imp {
    #[derive(Default)]
    pub struct KeepAwakeState;

    pub fn set(_state: &KeepAwakeState, _on: bool) -> Result<(), String> {
        Err("unsupported_platform".to_string())
    }
}

pub use imp::KeepAwakeState;

/// Hold or release the system-sleep inhibitor.
#[tauri::command]
pub fn set_keep_awake(state: tauri::State<'_, KeepAwakeState>, on: bool) -> Result<(), String> {
    imp::set(&state, on)
}
