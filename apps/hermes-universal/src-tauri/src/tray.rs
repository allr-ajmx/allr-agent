//! The system tray (desktop): the only affordance that reaches a hidden Hermes.
//!
//! Background mode is what makes this load-bearing rather than decorative. Once
//! the window can be put away without the process ending, something has to be
//! able to bring it back and something has to be able to end it — so the tray is
//! a hard dependency of `background::set_background_mode`, not a nicety beside
//! it. `install` therefore reports whether it actually got an icon, and a `false`
//! is what makes the Settings switch refuse to arm.
//!
//! **The labels are pushed, not read.** Every string the user sees lives in the
//! JS catalog (`src/i18n/*.ts`, five locales), and a native menu cannot reach it
//! — there is no bundle on this side and no React to re-render when the locale
//! changes. So this follows the split the app already uses everywhere the
//! webview owns copy and Rust owns a native lever: the menu is BUILT with
//! English literals, so the first paint is never blank or keyed, and the shell
//! pushes the translated set over `tray_set_labels` at boot and again whenever
//! `display.language` changes. `tray_set_status` does the same for the
//! connection readout, which is a disabled row — a readout, not a button.

// Desktop implementation. The whole tray, its menu handles and its two setters.
#[cfg(desktop)]
mod imp {
    use std::sync::Mutex;

    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    use tauri::{AppHandle, Manager, Wry};

    /// The tray icon's id. `install` is idempotent through it: a second call
    /// finds the icon already registered and leaves it alone.
    const TRAY_ID: &str = "hermes";

    /// Menu ids. `MenuEvent` carries the id as a string, so these are the wire
    /// format between the builder and the handler and must not drift.
    const ID_SHOW: &str = "show";
    const ID_HUD: &str = "hud";
    const ID_STATUS: &str = "status";
    const ID_QUIT: &str = "quit";

    /// English fallbacks. The menu is built with these so a tray that appears
    /// before the webview has booted (or in a run where the push fails) still
    /// reads as words rather than as keys or as nothing at all.
    const DEFAULT_SHOW: &str = "Show Hermes";
    const DEFAULT_HUD: &str = "Open HUD";
    const DEFAULT_QUIT: &str = "Quit Hermes";
    const DEFAULT_STATUS: &str = "Not connected";
    const DEFAULT_TOOLTIP: &str = "Hermes (MJX)";

    /// The live menu rows, kept so their text can be replaced in place.
    ///
    /// Rebuilding the menu on every label push would work today and break the
    /// moment a row is added from outside this module: a rebuild owned here would
    /// drop anything another module had appended. `MenuItem<Wry>` is an `Arc`
    /// over a main-thread-hopping inner and is `Send + Sync`, so holding clones
    /// here is exactly what it is shaped for.
    struct TrayItems {
        show: MenuItem<Wry>,
        hud: MenuItem<Wry>,
        status: MenuItem<Wry>,
        quit: MenuItem<Wry>,
    }

    #[derive(Default)]
    pub struct TrayState(Mutex<Option<TrayItems>>);

    /// Translated menu copy, pushed from the webview.
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct TrayLabels {
        pub show: String,
        pub hud: String,
        pub quit: String,
        pub tooltip: String,
    }

    /// The connection readout. One field today; a struct rather than a bare
    /// `String` because the row is the app's only always-visible status surface
    /// and anything else that has to be READ rather than clicked belongs in the
    /// same push.
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct TrayStatus {
        pub text: String,
    }

    /// Build the tray. Returns whether one is actually on screen.
    ///
    /// `Ok(false)` rather than `Err` for a refused icon: a machine with no
    /// StatusNotifier host is a perfectly good machine to run Hermes on, it just
    /// cannot run it hidden. Failing `setup` here would refuse to start the app
    /// at all over a feature the user may never turn on.
    pub fn install(app: &AppHandle) -> bool {
        if app.tray_by_id(TRAY_ID).is_some() {
            return true;
        }

        let items = match build_items(app) {
            Ok(items) => items,
            Err(err) => {
                log::warn!("tray menu could not be built: {err}");

                return false;
            }
        };

        let separator = match PredefinedMenuItem::separator(app) {
            Ok(separator) => separator,
            Err(err) => {
                log::warn!("tray separator could not be built: {err}");

                return false;
            }
        };

        let menu = match Menu::with_items(
            app,
            &[
                &items.show,
                &items.hud,
                &items.status,
                &separator,
                &items.quit,
            ],
        ) {
            Ok(menu) => menu,
            Err(err) => {
                log::warn!("tray menu could not be assembled: {err}");

                return false;
            }
        };

        // `app.default_window_icon()` is `None` on macOS — the bundle carries an
        // .icns the runtime does not hand back as an `Image` — so a tray built
        // from it is invisible there. The PNG is embedded instead, which is the
        // same bytes on every platform. Not marked as a template image: the app
        // icon is full-colour, and macOS renders a template as a flat mask.
        let icon = match tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png")) {
            Ok(icon) => icon,
            Err(err) => {
                log::warn!("tray icon could not be decoded: {err}");

                return false;
            }
        };

        let built = TrayIconBuilder::with_id(TRAY_ID)
            .icon(icon)
            .tooltip(DEFAULT_TOOLTIP)
            .menu(&menu)
            // Windows and most Linux trays put the menu on RIGHT click and treat
            // left click as "show the app". macOS is the opposite: a menu-bar
            // item opens its menu on a plain click, and an item that instead
            // yanked a window forward would be the odd one out on the bar.
            .show_menu_on_left_click(cfg!(target_os = "macos"))
            .on_menu_event(|app, event| on_menu(app, event.id().as_ref()))
            .on_tray_icon_event(|tray, event| {
                if cfg!(target_os = "macos") {
                    return;
                }

                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = event
                {
                    reveal(tray.app_handle());
                }
            })
            .build(app);

        match built {
            Ok(_) => {
                if let Some(state) = app.try_state::<TrayState>() {
                    *state.0.lock().unwrap_or_else(|err| err.into_inner()) = Some(items);
                }

                true
            }
            Err(err) => {
                // The expected failure on a bare wlroots/sway session with no
                // StatusNotifier host and no xembed tray. Logged rather than
                // fatal — see the doc comment.
                log::warn!("no system tray available: {err}");

                false
            }
        }
    }

    fn build_items(app: &AppHandle) -> tauri::Result<TrayItems> {
        Ok(TrayItems {
            show: MenuItem::with_id(app, ID_SHOW, DEFAULT_SHOW, true, None::<&str>)?,
            // Summon the HUD without a keyboard. The row is the ONLY way to the
            // HUD on a machine where another application already owns the chord
            // — `global_shortcuts_sync` reports that as `refused` and the in-app
            // binding needs Hermes focused, which a hidden Hermes is not.
            hud: MenuItem::with_id(app, ID_HUD, DEFAULT_HUD, true, None::<&str>)?,
            // Disabled on purpose: this row is a readout. Clicking a connection
            // state has no meaning, and an enabled row that does nothing is a
            // worse lie than a greyed one.
            status: MenuItem::with_id(app, ID_STATUS, DEFAULT_STATUS, false, None::<&str>)?,
            quit: MenuItem::with_id(app, ID_QUIT, DEFAULT_QUIT, true, None::<&str>)?,
        })
    }

    fn on_menu(app: &AppHandle, id: &str) {
        match id {
            ID_SHOW => reveal(app),
            // Through the SAME bus the chord uses (`shortcuts::fire`), not a
            // bespoke path: the action resolves to a window, and with everything
            // hidden it builds one. A tray row that opened the HUD its own way
            // would be a second answer to "which window is the app".
            ID_HUD => crate::shortcuts::fire(app, crate::shortcuts::HUD_ACTION_ID),
            ID_QUIT => {
                if let Some(state) = app.try_state::<crate::background::BackgroundState>() {
                    state.request_quit();
                }

                // Give the machine its chords back at the moment of the quit
                // rather than whenever the process happens to unwind.
                crate::shortcuts::release_all(app);
                crate::window::close_satellite_windows(app);
                app.exit(0);
            }
            // `status` is disabled: it is a readout, not a button.
            _ => {}
        }
    }

    fn reveal(app: &AppHandle) {
        let app = app.clone();

        tauri::async_runtime::spawn(async move {
            if let Err(err) = crate::window::reveal_app_window(app).await {
                log::warn!("could not reveal a window from the tray: {err}");
            }
        });
    }

    pub fn set_labels(app: &AppHandle, labels: TrayLabels) -> Result<(), String> {
        let state = app
            .try_state::<TrayState>()
            .ok_or_else(|| "no_tray".to_string())?;
        let held = state.0.lock().unwrap_or_else(|err| err.into_inner());
        let items = held.as_ref().ok_or_else(|| "no_tray".to_string())?;

        items.show.set_text(&labels.show).map_err(err_text)?;
        items.hud.set_text(&labels.hud).map_err(err_text)?;
        items.quit.set_text(&labels.quit).map_err(err_text)?;

        if let Some(tray) = app.tray_by_id(TRAY_ID) {
            tray.set_tooltip(Some(&labels.tooltip)).map_err(err_text)?;
        }

        Ok(())
    }

    pub fn set_status(app: &AppHandle, status: TrayStatus) -> Result<(), String> {
        let state = app
            .try_state::<TrayState>()
            .ok_or_else(|| "no_tray".to_string())?;
        let held = state.0.lock().unwrap_or_else(|err| err.into_inner());
        let items = held.as_ref().ok_or_else(|| "no_tray".to_string())?;

        items.status.set_text(&status.text).map_err(err_text)
    }

    fn err_text(err: tauri::Error) -> String {
        err.to_string()
    }
}

// Mobile: no tray anywhere on a phone. `TrayState` still exists so the builder's
// `.manage()` is one line on both targets, and the two commands stay registered
// so a stray push is a clear refusal rather than an "unknown command".
#[cfg(mobile)]
mod imp {
    #[derive(Default)]
    pub struct TrayState;

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct TrayLabels {
        pub show: String,
        pub hud: String,
        pub quit: String,
        pub tooltip: String,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct TrayStatus {
        pub text: String,
    }
}

pub use imp::{TrayLabels, TrayState, TrayStatus};

#[cfg(desktop)]
pub use imp::install;

/// Push the translated menu copy. See the module note on why this is a push.
#[cfg(desktop)]
#[tauri::command]
pub fn tray_set_labels(app: tauri::AppHandle, labels: TrayLabels) -> Result<(), String> {
    imp::set_labels(&app, labels)
}

/// Push the connection readout into the disabled status row.
#[cfg(desktop)]
#[tauri::command]
pub fn tray_set_status(app: tauri::AppHandle, status: TrayStatus) -> Result<(), String> {
    imp::set_status(&app, status)
}

#[cfg(mobile)]
#[tauri::command]
pub async fn tray_set_labels(_labels: TrayLabels) -> Result<(), String> {
    Err("unsupported_platform".to_string())
}

#[cfg(mobile)]
#[tauri::command]
pub async fn tray_set_status(_status: TrayStatus) -> Result<(), String> {
    Err("unsupported_platform".to_string())
}
