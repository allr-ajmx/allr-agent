//! Background mode (desktop): let the process outlive its last visible window.
//!
//! Without this the app has no resident concept at all — `tauri.conf.json`
//! declares one window (`main`), and tao exits the loop the moment the window
//! map empties (`tauri-runtime-wry`: `TaoWindowEvent::Destroyed` fires
//! `RunEvent::ExitRequested` and sets `ControlFlow::Exit` unless something
//! prevents it). So closing the last window took the gateway socket, every
//! in-flight turn and every summonable surface down with it.
//!
//! The split is the same one `keep_awake` uses: the webview owns the preference
//! and persists it (`src/store/background-mode.ts`), and this module owns the
//! single native lever. Two levers, in fact, and they answer different questions:
//!
//!  * `enabled` — the user's preference, mirrored down. Read by
//!    [`should_prevent_exit`] on `RunEvent::ExitRequested`.
//!  * `quit_requested` — set by [`quit_app`] and never cleared. `AppHandle::exit`
//!    routes through the *same* `ExitRequested` event as a user-initiated quit,
//!    so without this flag "keep running in the background" would also prevent
//!    the one deliberate way out and leave a process nothing can kill from the
//!    UI.
//!
//! A third — `tray_ready` — is what stops the feature stranding the user. The
//! tray is the only affordance that reaches a hidden Hermes, so a machine that
//! could not give us one (a bare wlroots session with no `xdg-desktop-portal`
//! StatusNotifier host, no waybar, no xembed tray) must not be allowed to arm
//! background mode: hiding there would leave a live process with no window, no
//! icon and no menu. `set_background_mode` refuses, the store flips the switch
//! back, and close goes back to meaning quit.

use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};

pub const PREFERENCE_UNSET: u8 = 0;
pub const PREFERENCE_KEEP_RUNNING: u8 = 1;
pub const PREFERENCE_CLOSE: u8 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackgroundPreference {
    Unset,
    KeepRunning,
    Close,
}

impl BackgroundPreference {
    pub fn from_u8(v: u8) -> Self {
        match v {
            PREFERENCE_KEEP_RUNNING => Self::KeepRunning,
            PREFERENCE_CLOSE => Self::Close,
            _ => Self::Unset,
        }
    }

    pub fn to_u8(self) -> u8 {
        match self {
            Self::Unset => PREFERENCE_UNSET,
            Self::KeepRunning => PREFERENCE_KEEP_RUNNING,
            Self::Close => PREFERENCE_CLOSE,
        }
    }

    pub fn as_bool(self) -> Option<bool> {
        match self {
            Self::KeepRunning => Some(true),
            Self::Close => Some(false),
            Self::Unset => None,
        }
    }
}

/// Whether `RunEvent::ExitRequested` should be prevented.
///
/// The whole decision, as a free function, so it can be asserted without an
/// `AppHandle` — and so the precedence is stated once rather than inlined into
/// an event arm where a later edit can quietly drop the `!`.
///
/// An explicit Quit outranks the preference. It has to: `AppHandle::exit` raises
/// the same event, so a rule that only read `background_on` would make Quit a
/// no-op and the process unkillable from its own tray.
pub fn should_prevent_exit(background_on: bool, quit_requested: bool) -> bool {
    background_on && !quit_requested
}

/// The flags above, shared across the event loop, the commands and the
/// tray's menu handlers.
///
/// Atomics rather than a `Mutex`: every access is a single bool/u8, the exit arm
/// runs on the event-loop thread while the commands run on the IPC thread, and a
/// poisoned lock in the exit path would be the difference between quitting and
/// hanging.
#[derive(Default)]
pub struct BackgroundState {
    enabled: AtomicBool,
    preference: AtomicU8,
    quit_requested: AtomicBool,
    tray_ready: AtomicBool,
}

impl BackgroundState {
    pub fn enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }

    pub fn set_enabled(&self, on: bool) {
        self.enabled.store(on, Ordering::SeqCst);
    }

    pub fn preference(&self) -> BackgroundPreference {
        BackgroundPreference::from_u8(self.preference.load(Ordering::SeqCst))
    }

    pub fn set_preference(&self, pref: BackgroundPreference) {
        self.preference.store(pref.to_u8(), Ordering::SeqCst);
    }

    pub fn quit_requested(&self) -> bool {
        self.quit_requested.load(Ordering::SeqCst)
    }

    /// Mark the quit explicit. One-way: nothing may put the app back into
    /// "prevent the exit" once the user has asked for it.
    pub fn request_quit(&self) {
        self.quit_requested.store(true, Ordering::SeqCst);
    }

    pub fn tray_ready(&self) -> bool {
        self.tray_ready.load(Ordering::SeqCst)
    }

    pub fn set_tray_ready(&self, ready: bool) {
        self.tray_ready.store(ready, Ordering::SeqCst);
    }

    /// The exit decision for this state. Kept beside [`should_prevent_exit`] so
    /// the event arm reads one call rather than two loads and an operator.
    pub fn should_prevent_exit(&self) -> bool {
        should_prevent_exit(self.enabled(), self.quit_requested())
    }
}

/// Mirror the preference down; answers with what is ACTUALLY in force.
///
/// Same contract as `set_keep_awake`: a caller that only sees `Ok(())` cannot
/// tell "resident" from "quietly not resident", and this switch's promise is
/// that a stream survives the window being put away. Arming without a tray is
/// refused rather than degraded silently — see the module note.
#[cfg(desktop)]
#[tauri::command]
pub fn set_background_mode(
    app: tauri::AppHandle,
    state: tauri::State<'_, BackgroundState>,
    on: bool,
) -> Result<bool, String> {
    if on && !state.tray_ready() {
        // Turning it off must always succeed, so this is guarded on `on`: a user
        // who armed it on a machine that later lost its tray still needs a way
        // back to "close quits".
        return Err("no_tray".to_string());
    }

    state.set_enabled(on);
    state.set_preference(if on {
        BackgroundPreference::KeepRunning
    } else {
        BackgroundPreference::Close
    });

    let _ = crate::tray::set_keep_running(&app, on);

    Ok(on)
}

/// Query current background mode preference.
#[cfg(desktop)]
#[tauri::command]
pub fn get_background_mode(
    state: tauri::State<'_, BackgroundState>,
) -> Result<Option<bool>, String> {
    Ok(state.preference().as_bool())
}

/// The one deliberate way out while background mode is on.
///
/// Satellites go first. They are always-on-top and, on wlroots, layer-shell
/// surfaces — an orphan left over a bare desktop is the worst failure this can
/// have — and closing them gives their webviews a chance to run their own
/// teardown before the loop stops.
///
/// The machine-wide chords go back too. `shortcuts.rs` deliberately does NOT
/// release on a window teardown — the claim outliving every window is the whole
/// point — so the explicit quit is the one place that hands them back, and it
/// does so before the loop stops rather than leaving it to process teardown.
#[cfg(desktop)]
#[tauri::command]
pub fn quit_app(
    app: tauri::AppHandle,
    state: tauri::State<'_, BackgroundState>,
) -> Result<(), String> {
    state.request_quit();
    crate::shortcuts::release_all(&app);
    crate::window::close_satellite_windows(&app);
    app.exit(0);

    Ok(())
}

// Mobile: no tray, no resident process the user could summon, and no window to
// hide behind. The store gates on `IS_DESKTOP` and never arrives here; these keep
// the command names registered so a stray call is a clear refusal rather than an
// "unknown command" that reads like a broken build (the same idiom as
// `appearance.rs` / `window.rs`).
#[cfg(mobile)]
#[tauri::command]
pub async fn set_background_mode(_on: bool) -> Result<bool, String> {
    Err("unsupported_platform".to_string())
}

#[cfg(mobile)]
#[tauri::command]
pub async fn get_background_mode() -> Result<Option<bool>, String> {
    Err("unsupported_platform".to_string())
}

#[cfg(mobile)]
#[tauri::command]
pub async fn quit_app() -> Result<(), String> {
    Err("unsupported_platform".to_string())
}

#[cfg(test)]
mod tests {
    use super::{should_prevent_exit, BackgroundState};

    /// `AppHandle::exit` raises the SAME `ExitRequested` event a user-initiated
    /// quit does. If the rule ever collapses to `background_on`, Tray → Quit
    /// prevents its own exit and the process cannot be stopped from anything the
    /// app itself offers.
    #[test]
    fn an_explicit_quit_outranks_background_mode() {
        assert!(
            !should_prevent_exit(true, true),
            "quit wins over background"
        );
        assert!(
            should_prevent_exit(true, false),
            "resident with no quit asked"
        );
        assert!(!should_prevent_exit(false, false), "off means close quits");
        assert!(!should_prevent_exit(false, true));
    }

    /// The flag is one-way. A second `ExitRequested` (tao raises one per
    /// last-window-destroyed, and `app.exit` raises another) must not find the
    /// app back in "stay resident".
    #[test]
    fn a_requested_quit_is_never_taken_back() {
        let state = BackgroundState::default();

        state.set_enabled(true);
        assert!(state.should_prevent_exit());

        state.request_quit();
        assert!(!state.should_prevent_exit());

        // Nothing the preference does may resurrect the prevention.
        state.set_enabled(true);
        assert!(!state.should_prevent_exit());
    }

    #[test]
    fn background_preference_transitions() {
        use super::BackgroundPreference;

        let state = BackgroundState::default();
        assert_eq!(state.preference(), BackgroundPreference::Unset);
        assert_eq!(state.preference().as_bool(), None);

        state.set_preference(BackgroundPreference::KeepRunning);
        assert_eq!(state.preference(), BackgroundPreference::KeepRunning);
        assert_eq!(state.preference().as_bool(), Some(true));

        state.set_preference(BackgroundPreference::Close);
        assert_eq!(state.preference(), BackgroundPreference::Close);
        assert_eq!(state.preference().as_bool(), Some(false));
    }
}
