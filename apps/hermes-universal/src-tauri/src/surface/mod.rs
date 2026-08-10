//! Cross-OS **floating surface** capability layer (MJXHRM-213).
//!
//! A floating surface is a second window of the app that lives *over other
//! applications*: summoned by a global hotkey, frameless, transparent, and — the
//! part every OS disagrees about — stacked above windows it does not own. The HUD
//! is its first consumer. The mobile floating chat bubble (MJXHRM-351) is meant to
//! be its second, on a platform where the OS, not the app, decides whether an
//! overlay may exist at all.
//!
//! # Why a descriptor instead of a set of setters
//!
//! Every trait here is supported on some platforms, unsupported on others, and —
//! worst of the three — **silently ignored** on at least one. Tauri's
//! `set_always_on_top` returns `Ok(())` on Wayland and does nothing (tauri#3117,
//! tao#1134); tao implements it as GTK3 `set_keep_above`, which is an X11 hint the
//! Wayland protocol has no equivalent for, because stacking is compositor policy.
//! A caller that just calls setters therefore cannot tell a working HUD from a
//! broken one.
//!
//! So callers **ask first** ([`surface_capabilities`]) and **are told what they
//! actually got** ([`SurfaceGrant`] from [`surface_attach`]). Nothing here reports
//! a capability because a call did not error; the Linux probe asks the compositor
//! whether it speaks the protocol.
//!
//! # The Linux backend
//!
//! On wlroots compositors the answer is `wlr-layer-shell`, reached through
//! `libgtk-layer-shell` — see [`layer_shell`] for why it is `dlopen`ed rather than
//! linked, and for the realization-ordering constraint that makes it work on a
//! window Tauri created.
//!
//! Two design rules are copied verbatim from a working layer-shell overlay on the
//! target machine (DankMaterialShell's spotlight), because both are the kind of
//! thing you only learn by shipping:
//!
//! 1. **Never move or resize the layer surface.** It is anchored to all four
//!    screen edges — so it is exactly output-sized and stays that way — and the
//!    content is positioned *inside* it with margins and an input region. A HUD
//!    built as a small window that moves is the version that misbehaves on some
//!    compositors.
//! 2. **Give it a namespace** (`hermes:hud`) so compositor rules can target it.
//!
//! The consequence for the frontend is that a layer-shell surface's webview covers
//! the whole output and must draw its own transparent background, then report the
//! rect it actually wants clicks in via [`surface_set_interactive_rect`]. That is
//! why the backend is part of the grant: the surface renders differently depending
//! on which one it got.

pub mod below;
#[cfg(target_os = "linux")]
mod layer_shell;

use serde::{Deserialize, Serialize};

#[cfg(desktop)]
use tauri::Manager;
#[cfg(desktop)]
use tokio::sync::oneshot;

// ---------------------------------------------------------------------------
// The descriptor
// ---------------------------------------------------------------------------

/// How well a single trait is supported. `Degraded` is the interesting one: the
/// trait exists but not in the form the caller asked for, and the reason is in
/// [`SurfaceCapabilities::notes`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Support {
    Supported,
    Degraded,
    Unsupported,
}

/// Which windowing mechanism a floating surface is built on. The frontend needs
/// this, not just a boolean: a `LayerShell` surface is output-sized and positions
/// its own content, a `Toplevel` one is window-sized and fills it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SurfaceBackend {
    /// `wlr-layer-shell` via gtk-layer-shell. Output-sized, compositor-stacked.
    LayerShell,
    /// An ordinary always-on-top toplevel (X11 `_NET_WM_STATE_ABOVE`, Win32
    /// `HWND_TOPMOST`, AppKit floating panel level).
    Toplevel,
    /// The platform has no floating surface at all.
    None,
}

/// How a surface comes to be above other windows. Deliberately not a boolean:
/// "the compositor puts it on the overlay layer" and "we asked the window manager
/// nicely" fail in completely different ways, and only one of them fails
/// silently.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AlwaysOnTop {
    /// The compositor places the surface on a named layer above normal windows.
    /// Reliable — it is the compositor's own mechanism, not a request.
    LayerShell,
    /// The app asserts it and the window manager honours it. True on X11,
    /// Windows and macOS.
    AppAsserted,
    /// The OS owns the decision and may revoke it (Android's overlay permission).
    /// Reserved for MJXHRM-351; nothing returns it yet.
    SystemManaged,
    /// Asked for and not delivered. On Wayland-without-layer-shell this is the
    /// honest answer where `set_always_on_top` would have returned `Ok`.
    Unsupported,
}

/// Whether a floating surface can take keyboard input, and on whose terms. This
/// is the axis that decides whether the surface can host a real composer:
/// `Exclusive` means it receives keys without the compositor moving focus away
/// from the app underneath, which xdg-shell cannot express at all.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum KeyboardFocus {
    None,
    OnDemand,
    Exclusive,
}

/// What this platform can do for a floating surface. Queried before anything is
/// built, so a caller can decide not to offer the affordance rather than open a
/// window that does not behave.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceCapabilities {
    pub platform: String,
    /// The gate. `false` means: do not offer this UI here at all.
    pub floating_surface: bool,
    pub backend: SurfaceBackend,
    pub transparency: Support,
    pub always_on_top: AlwaysOnTop,
    /// Whole-surface click-through (the cursor passes to whatever is behind).
    pub click_through: Support,
    /// Click-through with a *hole*: only part of the surface takes input. Needs a
    /// real input region, which is not the same mechanism as the above.
    pub interactive_region: Support,
    /// Every focus mode this platform can actually deliver, best last.
    pub keyboard_focus: Vec<KeyboardFocus>,
    /// Whether the surface's position/size survives a restart. Meaningless for a
    /// layer-shell surface, which does not have a position to remember.
    pub remembered_geometry: Support,
    pub multi_monitor_placement: Support,
    pub read_window_below: Support,
    /// Where `read_window_below` gets its answer, when it has one.
    pub read_window_below_source: Option<String>,
    /// One human-readable line per limitation. Shown in diagnostics; never
    /// parsed.
    pub notes: Vec<String>,
}

impl SurfaceCapabilities {
    /// The honest answer for a platform with no floating-surface concept. Mobile
    /// returns this today; MJXHRM-351 replaces the Android arm with a real
    /// descriptor once the overlay permission is wired.
    ///
    /// Compiled unconditionally, and dead on desktop, on purpose: the mobile
    /// contract then stays type-checked and unit-tested by the desktop CI job
    /// rather than only by a build nobody runs on a pull request.
    #[cfg_attr(desktop, allow(dead_code))]
    fn none(platform: &str, note: &str) -> Self {
        Self {
            platform: platform.to_string(),
            floating_surface: false,
            backend: SurfaceBackend::None,
            transparency: Support::Unsupported,
            always_on_top: AlwaysOnTop::Unsupported,
            click_through: Support::Unsupported,
            interactive_region: Support::Unsupported,
            keyboard_focus: vec![],
            remembered_geometry: Support::Unsupported,
            multi_monitor_placement: Support::Unsupported,
            read_window_below: Support::Unsupported,
            read_window_below_source: None,
            notes: vec![note.to_string()],
        }
    }

    /// Whether the surface can host a composer that receives keystrokes. The
    /// frontend asks the same question of the serialized descriptor; this exists
    /// so the rule is written down once, next to the enum it reads.
    #[allow(dead_code)]
    pub fn can_host_input(&self) -> bool {
        self.keyboard_focus
            .iter()
            .any(|m| matches!(m, KeyboardFocus::Exclusive | KeyboardFocus::OnDemand))
    }
}

// ---------------------------------------------------------------------------
// The request / grant pair
// ---------------------------------------------------------------------------

/// Which layer a surface asks for. Only meaningful to the layer-shell backend;
/// other backends collapse it to "on top" or nothing.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SurfaceLayer {
    /// Above normal windows but below the shell's own panels/lock screen.
    Top,
    /// Above everything, including a status bar. What a summoned HUD wants.
    #[default]
    Overlay,
}

/// A rectangle in the surface's own logical coordinates.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// What the caller wants. Every field is a *request*; the [`SurfaceGrant`] says
/// what was actually applied.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceRequest {
    /// Compositor-visible name, so window rules can target this surface.
    pub namespace: String,
    #[serde(default)]
    pub layer: SurfaceLayer,
    /// The strongest focus mode the caller would like. Downgraded silently-but-
    /// reported if the platform cannot deliver it.
    #[serde(default = "default_keyboard")]
    pub keyboard_focus: KeyboardFocus,
    /// Distance from each screen edge for the *content*, in logical pixels, as
    /// `[left, right, top, bottom]`. Layer-shell only — this is how a surface is
    /// positioned without ever being moved.
    #[serde(default)]
    pub margins: [i32; 4],
}

fn default_keyboard() -> KeyboardFocus {
    KeyboardFocus::Exclusive
}

/// What the surface actually is, now that it exists. The caller renders against
/// this, not against what it asked for.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceGrant {
    pub label: String,
    pub backend: SurfaceBackend,
    pub always_on_top: AlwaysOnTop,
    pub keyboard_focus: KeyboardFocus,
    /// True when the surface covers the whole output and must position its own
    /// content — the layer-shell shape. False when it is a plain sized window.
    pub output_sized: bool,
    pub interactive_region: Support,
    /// One line per thing the caller asked for and did not get. Empty means the
    /// request was met in full.
    pub degraded: Vec<String>,
}

// ---------------------------------------------------------------------------
// Capability probing
// ---------------------------------------------------------------------------

/// What the Linux probe learned about the running session. Split out from
/// [`capabilities_for_linux`] so the mapping from session facts to a descriptor
/// is a pure function with tests, rather than something only observable on a
/// particular desktop.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LinuxSession {
    /// The GDK backend is Wayland (rather than X11/XWayland).
    pub wayland: bool,
    /// `libgtk-layer-shell` loaded.
    pub layer_shell_library: bool,
    /// The compositor advertises `zwlr_layer_shell_v1`. Behavioural, not
    /// inferred from the library being present.
    pub layer_shell_supported: bool,
    /// The `zwlr_layer_shell_v1` version the compositor speaks, for diagnostics.
    pub layer_shell_protocol: Option<u32>,
    /// A Hyprland instance signature is in the environment, so its IPC socket
    /// can answer `read_window_below`.
    pub hyprland: bool,
}

/// Map a probed Linux session onto the descriptor. Pure.
pub fn capabilities_for_linux(session: LinuxSession) -> SurfaceCapabilities {
    let mut notes = Vec::new();
    let layer_shell =
        session.wayland && session.layer_shell_library && session.layer_shell_supported;

    if layer_shell {
        notes.push(match session.layer_shell_protocol {
            Some(v) => format!(
                "Stacking, click-through and keyboard focus come from wlr-layer-shell                  (zwlr_layer_shell_v1 v{v}), not from the app asking the window manager."
            ),
            None => "Stacking, click-through and keyboard focus come from wlr-layer-shell, not                      from the app asking the window manager."
                .to_string(),
        });
    }

    if session.wayland && !session.layer_shell_library {
        notes.push(
            "libgtk-layer-shell.so.0 is not installed, so the surface falls back to an ordinary \
             toplevel. On Wayland that means it cannot raise itself above other applications."
                .to_string(),
        );
    } else if session.wayland && !session.layer_shell_supported {
        notes.push(
            "This compositor does not advertise zwlr_layer_shell_v1 (GNOME's Mutter, for one). \
             The surface falls back to an ordinary toplevel and cannot raise itself above other \
             applications."
                .to_string(),
        );
    }

    let always_on_top = if layer_shell {
        AlwaysOnTop::LayerShell
    } else if session.wayland {
        // The silent-failure case the whole descriptor exists for: tao would
        // happily call set_keep_above and return Ok.
        notes.push(
            "Wayland has no protocol letting a client raise itself above other applications; \
             stacking is compositor policy. A compositor window rule is the only way to pin this \
             surface here."
                .to_string(),
        );
        AlwaysOnTop::Unsupported
    } else {
        AlwaysOnTop::AppAsserted
    };

    let keyboard_focus = if layer_shell {
        vec![
            KeyboardFocus::None,
            KeyboardFocus::OnDemand,
            KeyboardFocus::Exclusive,
        ]
    } else {
        // A plain toplevel takes focus when focused and not otherwise; there is
        // no way to say "give me keys without moving focus".
        notes.push(
            "Without layer-shell the surface takes keyboard focus the way any window does; it \
             cannot receive keys while another application stays focused."
                .to_string(),
        );
        vec![KeyboardFocus::None, KeyboardFocus::OnDemand]
    };

    let (read_below, read_below_source) = if session.hyprland {
        (Support::Supported, Some("hyprland-ipc".to_string()))
    } else {
        notes.push(if session.wayland {
            "Reading the window underneath needs a compositor that will tell us about other \
             applications' windows. Only Hyprland's IPC socket is implemented; Wayland itself \
             refuses."
                .to_string()
        } else {
            "Reading the window underneath is not implemented for X11 in this build.".to_string()
        });
        (Support::Unsupported, None)
    };

    SurfaceCapabilities {
        platform: "linux".to_string(),
        floating_surface: true,
        backend: if layer_shell {
            SurfaceBackend::LayerShell
        } else {
            SurfaceBackend::Toplevel
        },
        transparency: Support::Supported,
        always_on_top,
        click_through: Support::Supported,
        interactive_region: if layer_shell {
            Support::Supported
        } else {
            // gdk_window_input_shape_combine_region works on a plain toplevel
            // too, but only the layer-shell shape has a surface big enough for a
            // hole to be meaningful.
            Support::Degraded
        },
        keyboard_focus,
        remembered_geometry: if layer_shell {
            // Anchored to every edge; there is no position to remember, and
            // margins are the caller's to persist.
            Support::Unsupported
        } else {
            Support::Supported
        },
        multi_monitor_placement: Support::Degraded,
        read_window_below: read_below,
        read_window_below_source: read_below_source,
        notes,
    }
}

/// macOS and Windows. Both give an ordinary toplevel everything except an input
/// region with a hole, and neither has a `read_window_below` implementation in
/// this build — which is reported, not papered over.
#[cfg(all(desktop, not(target_os = "linux")))]
fn capabilities_for_other_desktop() -> SurfaceCapabilities {
    let platform = if cfg!(target_os = "macos") {
        "macos"
    } else {
        "windows"
    };
    SurfaceCapabilities {
        platform: platform.to_string(),
        floating_surface: true,
        backend: SurfaceBackend::Toplevel,
        transparency: Support::Supported,
        always_on_top: AlwaysOnTop::AppAsserted,
        click_through: Support::Supported,
        interactive_region: Support::Unsupported,
        keyboard_focus: vec![KeyboardFocus::None, KeyboardFocus::OnDemand],
        remembered_geometry: Support::Supported,
        multi_monitor_placement: Support::Supported,
        read_window_below: Support::Unsupported,
        read_window_below_source: None,
        notes: vec![
            "Reading the window underneath is Linux/Hyprland-only in this build; a win32 \
             EnumWindows binding and a macOS CGWindowList binding are not written yet \
             (MJXHRM-213)."
                .to_string(),
            "Only whole-surface click-through is available; there is no partial input region, so \
             the surface is either interactive everywhere or nowhere."
                .to_string(),
        ],
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Marshal `f` onto the GTK/AppKit main thread and wait for its answer. Every
/// window and GDK call below needs the main thread; this mirrors `window.rs`.
#[cfg(desktop)]
fn on_main_thread<T, F>(app: &tauri::AppHandle, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(tauri::AppHandle) -> T + Send + 'static,
{
    let (tx, rx) = oneshot::channel::<T>();
    let app_main = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(f(app_main));
    })
    .map_err(|e| format!("failed to schedule on the main thread: {e}"))?;
    rx.blocking_recv()
        .map_err(|_| "the main thread did not answer".to_string())
}

/// What this platform can do for a floating surface.
#[cfg(desktop)]
#[tauri::command]
pub async fn surface_capabilities(app: tauri::AppHandle) -> Result<SurfaceCapabilities, String> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "linux")]
        {
            on_main_thread(&app, |_| {
                let shell = layer_shell::get();
                let wayland = gtk::gdk::Display::default()
                    .map(|d| {
                        use gtk::gdk::prelude::DisplayExtManual;
                        d.backend().is_wayland()
                    })
                    .unwrap_or(false);
                capabilities_for_linux(LinuxSession {
                    wayland,
                    layer_shell_library: shell.is_some(),
                    // Behavioural: asks the compositor, not the library's presence.
                    layer_shell_supported: shell.map(|s| s.is_supported()).unwrap_or(false),
                    layer_shell_protocol: shell
                        .filter(|s| s.is_supported())
                        .map(|s| s.protocol_version()),
                    hyprland: below::hyprland_available(),
                })
            })
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = &app;
            Ok(capabilities_for_other_desktop())
        }
    })
    .await
    .map_err(|e| format!("capability probe failed: {e}"))?
}

/// Mobile has no floating surface today. This is a *stub with a contract*, not an
/// omission: MJXHRM-351 replaces the Android arm with a descriptor backed by the
/// `SYSTEM_ALERT_WINDOW` permission, at which point `alwaysOnTop` becomes
/// [`AlwaysOnTop::SystemManaged`] — a value this enum already carries precisely so
/// the frontend does not need changing when it lands.
#[cfg(mobile)]
#[tauri::command]
pub async fn surface_capabilities() -> Result<SurfaceCapabilities, String> {
    let platform = if cfg!(target_os = "android") {
        "android"
    } else {
        "ios"
    };
    Ok(SurfaceCapabilities::none(
        platform,
        if cfg!(target_os = "android") {
            "Android has no floating surface in this build. A chat bubble over other apps needs \
             the SYSTEM_ALERT_WINDOW permission and a foreground service (MJXHRM-351)."
        } else {
            "iOS does not allow an application to draw over other applications. There is no \
             floating surface on this platform and there will not be one."
        },
    ))
}

/// Turn an already-built, still-hidden window into a floating surface.
///
/// **Ordering is a hard precondition, not a preference.** The window must have
/// been created with `visible: false` and must not have been shown: a layer
/// surface has to be configured before its GtkWindow is realized. The caller
/// shows it afterwards.
#[cfg(desktop)]
#[tauri::command]
pub async fn surface_attach(
    app: tauri::AppHandle,
    label: String,
    request: SurfaceRequest,
) -> Result<SurfaceGrant, String> {
    tauri::async_runtime::spawn_blocking(move || {
        on_main_thread(&app, move |app| attach_on_main(&app, &label, &request))
    })
    .await
    .map_err(|e| format!("attach failed: {e}"))??
}

#[cfg(desktop)]
fn attach_on_main(
    app: &tauri::AppHandle,
    label: &str,
    request: &SurfaceRequest,
) -> Result<SurfaceGrant, String> {
    let window = app
        .get_webview_window(label)
        .ok_or_else(|| format!("no window labelled {label}"))?;
    let mut degraded = Vec::new();

    #[cfg(target_os = "linux")]
    {
        let gtk_win = window.gtk_window().map_err(|e| e.to_string())?;
        let wayland = {
            use gtk::gdk::prelude::DisplayExtManual;
            use gtk::prelude::WidgetExt;
            gtk_win.display().backend().is_wayland()
        };

        let shell = layer_shell::get().filter(|s| s.is_supported());
        if let Some(shell) = shell {
            shell.init_for_window(&gtk_win)?;
            let keyboard = match request.keyboard_focus {
                KeyboardFocus::None => layer_shell::KeyboardMode::None,
                KeyboardFocus::OnDemand => layer_shell::KeyboardMode::OnDemand,
                KeyboardFocus::Exclusive => layer_shell::KeyboardMode::Exclusive,
            };
            let layer = match request.layer {
                SurfaceLayer::Top => layer_shell::Layer::Top,
                SurfaceLayer::Overlay => layer_shell::Layer::Overlay,
            };
            shell.configure(
                &gtk_win,
                &request.namespace,
                layer,
                keyboard,
                request.margins,
            );
            if !shell.is_layer_window(&gtk_win) {
                return Err("gtk-layer-shell accepted the window but did not claim it".to_string());
            }
            return Ok(SurfaceGrant {
                label: label.to_string(),
                backend: SurfaceBackend::LayerShell,
                always_on_top: AlwaysOnTop::LayerShell,
                keyboard_focus: request.keyboard_focus,
                output_sized: true,
                interactive_region: Support::Supported,
                degraded,
            });
        }

        // Fallback: an ordinary toplevel. On X11 that genuinely floats; on
        // Wayland it does not, and saying so is the entire job of this branch.
        let _ = window.set_always_on_top(true);
        let always_on_top = if wayland {
            degraded.push(
                "This surface cannot stay above other windows: the session is Wayland and \
                 gtk-layer-shell is unavailable. Pin it with a compositor window rule if you need \
                 it on top."
                    .to_string(),
            );
            AlwaysOnTop::Unsupported
        } else {
            AlwaysOnTop::AppAsserted
        };
        if request.keyboard_focus == KeyboardFocus::Exclusive {
            degraded.push(
                "Exclusive keyboard focus needs layer-shell; this surface takes focus like an \
                 ordinary window instead."
                    .to_string(),
            );
        }
        return Ok(SurfaceGrant {
            label: label.to_string(),
            backend: SurfaceBackend::Toplevel,
            always_on_top,
            keyboard_focus: KeyboardFocus::OnDemand,
            output_sized: false,
            interactive_region: Support::Degraded,
            degraded,
        });
    }

    #[cfg(not(target_os = "linux"))]
    {
        window
            .set_always_on_top(true)
            .map_err(|e| format!("could not raise the surface: {e}"))?;
        if request.keyboard_focus == KeyboardFocus::Exclusive {
            degraded.push(
                "Exclusive keyboard focus is a layer-shell capability and does not exist on this \
                 platform; the surface takes focus like an ordinary window."
                    .to_string(),
            );
        }
        Ok(SurfaceGrant {
            label: label.to_string(),
            backend: SurfaceBackend::Toplevel,
            always_on_top: AlwaysOnTop::AppAsserted,
            keyboard_focus: KeyboardFocus::OnDemand,
            output_sized: false,
            interactive_region: Support::Unsupported,
            degraded,
        })
    }
}

/// Restrict the surface's input to `rect`; everything outside becomes
/// click-through. `None` makes the whole surface interactive again.
///
/// This is `wl_surface.set_input_region` on Wayland (via
/// `gdk_window_input_shape_combine_region`) — a real protocol request, not an X11
/// emulation. Where no input region exists, it degrades to Tauri's whole-window
/// `set_ignore_cursor_events`, which is why passing a rect there makes the surface
/// interactive everywhere rather than pretending to cut a hole.
#[cfg(desktop)]
#[tauri::command]
pub async fn surface_set_interactive_rect(
    app: tauri::AppHandle,
    label: String,
    rect: Option<Rect>,
) -> Result<Support, String> {
    tauri::async_runtime::spawn_blocking(move || {
        on_main_thread(&app, move |app| {
            let window = app
                .get_webview_window(&label)
                .ok_or_else(|| format!("no window labelled {label}"))?;

            #[cfg(target_os = "linux")]
            {
                use gtk::prelude::WidgetExt;
                let gtk_win = window.gtk_window().map_err(|e| e.to_string())?;
                let gdk_win = gtk_win
                    .window()
                    .ok_or_else(|| "the surface is not realized yet".to_string())?;
                match rect {
                    Some(r) => {
                        let region = gtk::cairo::Region::create_rectangle(
                            &gtk::cairo::RectangleInt::new(r.x, r.y, r.width, r.height),
                        );
                        gdk_win.input_shape_combine_region(&region, 0, 0);
                    }
                    None => {
                        // An empty region means "no input anywhere"; the way to
                        // say "input everywhere" is to drop the shape, which GDK
                        // spells as a region covering the surface.
                        let (w, h) = (gtk_win.allocated_width(), gtk_win.allocated_height());
                        let region = gtk::cairo::Region::create_rectangle(
                            &gtk::cairo::RectangleInt::new(0, 0, w.max(1), h.max(1)),
                        );
                        gdk_win.input_shape_combine_region(&region, 0, 0);
                    }
                }
                Ok(Support::Supported)
            }

            #[cfg(not(target_os = "linux"))]
            {
                // No partial region: the closest honest behaviour is "interactive
                // everywhere", reported as degraded so the caller knows its hole
                // was not cut.
                window
                    .set_ignore_cursor_events(false)
                    .map_err(|e| e.to_string())?;
                Ok(if rect.is_some() {
                    Support::Degraded
                } else {
                    Support::Supported
                })
            }
        })
    })
    .await
    .map_err(|e| format!("input region failed: {e}"))??
}

/// Mobile stubs. Registered so a stray call from shared frontend code gets a
/// clear refusal rather than "unknown command".
#[cfg(mobile)]
#[tauri::command]
pub async fn surface_attach(
    _label: String,
    _request: SurfaceRequest,
) -> Result<SurfaceGrant, String> {
    Err("unsupported_platform".to_string())
}

#[cfg(mobile)]
#[tauri::command]
pub async fn surface_set_interactive_rect(
    _label: String,
    _rect: Option<Rect>,
) -> Result<Support, String> {
    Err("unsupported_platform".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hyprland_session() -> LinuxSession {
        LinuxSession {
            wayland: true,
            layer_shell_library: true,
            layer_shell_supported: true,
            layer_shell_protocol: Some(4),
            hyprland: true,
        }
    }

    #[test]
    fn a_wlroots_session_gets_the_layer_shell_backend() {
        let caps = capabilities_for_linux(hyprland_session());
        assert_eq!(caps.backend, SurfaceBackend::LayerShell);
        assert_eq!(caps.always_on_top, AlwaysOnTop::LayerShell);
        assert_eq!(caps.interactive_region, Support::Supported);
        assert!(caps.keyboard_focus.contains(&KeyboardFocus::Exclusive));
        assert!(caps.can_host_input());
        assert_eq!(caps.read_window_below, Support::Supported);
        assert_eq!(
            caps.read_window_below_source.as_deref(),
            Some("hyprland-ipc")
        );
    }

    /// The whole reason this layer exists: on Wayland without layer-shell,
    /// always-on-top must report Unsupported even though the setter would return
    /// Ok.
    #[test]
    fn wayland_without_layer_shell_admits_it_cannot_stay_on_top() {
        let caps = capabilities_for_linux(LinuxSession {
            layer_shell_supported: false,
            ..hyprland_session()
        });
        assert_eq!(caps.always_on_top, AlwaysOnTop::Unsupported);
        assert_eq!(caps.backend, SurfaceBackend::Toplevel);
        // Still a floating surface — it just cannot raise itself.
        assert!(caps.floating_surface);
        assert!(caps
            .notes
            .iter()
            .any(|n| n.contains("does not advertise zwlr_layer_shell_v1")));
        assert!(caps.notes.iter().any(|n| n.contains("compositor policy")));
    }

    #[test]
    fn a_missing_library_is_reported_separately_from_a_refusing_compositor() {
        let caps = capabilities_for_linux(LinuxSession {
            layer_shell_library: false,
            layer_shell_supported: false,
            ..hyprland_session()
        });
        assert!(caps
            .notes
            .iter()
            .any(|n| n.contains("libgtk-layer-shell.so.0 is not installed")));
        assert!(!caps
            .notes
            .iter()
            .any(|n| n.contains("does not advertise zwlr_layer_shell_v1")));
    }

    #[test]
    fn x11_asserts_always_on_top_itself() {
        let caps = capabilities_for_linux(LinuxSession {
            wayland: false,
            layer_shell_library: false,
            layer_shell_supported: false,
            layer_shell_protocol: None,
            hyprland: false,
        });
        assert_eq!(caps.always_on_top, AlwaysOnTop::AppAsserted);
        assert_eq!(caps.remembered_geometry, Support::Supported);
    }

    /// A layer surface is anchored to every edge, so it has no geometry to
    /// remember — reporting "supported" there would be a lie the caller acts on.
    #[test]
    fn a_layer_surface_has_no_geometry_to_remember() {
        assert_eq!(
            capabilities_for_linux(hyprland_session()).remembered_geometry,
            Support::Unsupported
        );
    }

    #[test]
    fn without_layer_shell_a_surface_cannot_host_a_background_composer() {
        let caps = capabilities_for_linux(LinuxSession {
            layer_shell_supported: false,
            ..hyprland_session()
        });
        assert!(!caps.keyboard_focus.contains(&KeyboardFocus::Exclusive));
        // It can still take input when focused — degraded, not dead.
        assert!(caps.can_host_input());
    }

    #[test]
    fn no_hyprland_means_read_window_below_says_no() {
        let caps = capabilities_for_linux(LinuxSession {
            hyprland: false,
            ..hyprland_session()
        });
        assert_eq!(caps.read_window_below, Support::Unsupported);
        assert!(caps.read_window_below_source.is_none());
    }

    #[test]
    fn mobile_reports_no_floating_surface_at_all() {
        let caps = SurfaceCapabilities::none("android", "needs SYSTEM_ALERT_WINDOW");
        assert!(!caps.floating_surface);
        assert_eq!(caps.backend, SurfaceBackend::None);
        assert!(!caps.can_host_input());
        assert_eq!(caps.notes.len(), 1);
    }

    /// The wire names are a contract with the TypeScript client; renaming a
    /// variant silently would leave the frontend matching on a string that never
    /// arrives.
    #[test]
    fn wire_names_are_kebab_case() {
        assert_eq!(
            serde_json::to_string(&AlwaysOnTop::LayerShell).unwrap(),
            "\"layer-shell\""
        );
        assert_eq!(
            serde_json::to_string(&AlwaysOnTop::AppAsserted).unwrap(),
            "\"app-asserted\""
        );
        assert_eq!(
            serde_json::to_string(&KeyboardFocus::OnDemand).unwrap(),
            "\"on-demand\""
        );
        assert_eq!(
            serde_json::to_string(&Support::Degraded).unwrap(),
            "\"degraded\""
        );
        assert_eq!(
            serde_json::to_string(&SurfaceBackend::LayerShell).unwrap(),
            "\"layer-shell\""
        );
    }

    #[test]
    fn a_request_defaults_to_an_overlay_that_can_take_keys() {
        let request: SurfaceRequest =
            serde_json::from_str(r#"{"namespace":"hermes:hud"}"#).expect("minimal request parses");
        assert_eq!(request.layer, SurfaceLayer::Overlay);
        assert_eq!(request.keyboard_focus, KeyboardFocus::Exclusive);
        assert_eq!(request.margins, [0, 0, 0, 0]);
    }
}
