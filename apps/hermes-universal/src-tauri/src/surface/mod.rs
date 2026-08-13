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
//! actually got** (the [`SurfaceGrant`] a satellite is opened with). Nothing here reports
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
#[cfg(all(desktop, target_os = "macos"))]
mod mac;
#[cfg(desktop)]
pub mod placement;
#[cfg(all(desktop, target_os = "windows"))]
mod win;
// Desktop-only: nothing on a mobile OS enumerates other applications' windows,
// so the picker, the mechanism enum and the enumerators all sit behind this.
#[cfg(desktop)]
pub mod window_stack;
#[cfg(all(desktop, target_os = "linux"))]
mod x11;

use serde::{Deserialize, Serialize};

#[cfg(desktop)]
use placement::{MonitorRect, PlacementSource};
#[cfg(desktop)]
use window_stack::WindowBelowSource;

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
    /// The monitor the surface was deliberately placed on, as the windowing
    /// system names it (MJXHRM-417). `None` means nobody chose — either the
    /// compositor picked the output, or this session cannot place a surface at
    /// all — and the reason is then in [`Self::degraded`].
    pub monitor: Option<String>,
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
///
/// Compiled for Linux, and under `cfg(test)` everywhere else so the mapping
/// stays covered wherever the suite runs. Mobile has no Linux session — Android
/// is `target_os = "android"` — and no [`placement`] module to map onto.
#[cfg(any(target_os = "linux", test))]
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

#[cfg(any(target_os = "linux", test))]
impl LinuxSession {
    /// Whether this session gets the layer-shell backend. One rule, read by the
    /// descriptor and by the placement decision alike.
    pub fn layer_shell(&self) -> bool {
        self.wayland && self.layer_shell_library && self.layer_shell_supported
    }
}

/// How this session can choose which monitor a floating surface opens on
/// (MJXHRM-417). Pure, and the *only* definition — [`capabilities_for_linux`]
/// derives the reported capability from it and the attach path derives its
/// behaviour from it, so the two cannot drift.
///
/// The Wayland arms are the point. A client on Wayland is told neither where the
/// pointer is (tao answers `Ok((0, 0))`, GDK answers `0,0`) nor allowed to move
/// its own toplevel, so:
///
/// * with layer-shell it can at least *name* an output — if something will say
///   which one has focus, which today means Hyprland's IPC socket;
/// * without layer-shell it can do neither, and `Unsupported` is the honest
///   answer rather than the `Degraded` that was reported before.
#[cfg(any(target_os = "linux", test))]
pub fn placement_source_for_linux(session: LinuxSession) -> PlacementSource {
    if !session.wayland {
        // X11: the pointer really is readable and windows really can be moved.
        return PlacementSource::Pointer;
    }
    if !session.layer_shell() {
        return PlacementSource::Nothing;
    }
    if session.hyprland {
        PlacementSource::FocusedOutput
    } else {
        PlacementSource::CompositorChoice
    }
}

/// Which mechanism answers `read_window_below` on this Linux session
/// (MJXHRM-392). Pure, and the *only* definition — the descriptor derives its
/// `readWindowBelow` from it and the command dispatches on it, so the report
/// cannot outlive the code.
///
/// Hyprland first and X11 second, never both: its IPC socket sees native
/// Wayland windows, which no X11 enumeration can, so on a Hyprland session that
/// is strictly the better answer even when `DISPLAY` is also set.
///
/// The Wayland arm is a refusal on purpose. XWayland *would* answer — and would
/// answer wrongly: it reports only X11 clients, in a stacking order the Wayland
/// compositor above it does not use, so under GNOME or KDE the "window below"
/// would confidently name an application that is not there. Nothing beats that.
///
/// Like [`LinuxSession::hyprland`], `X11Stacking` is a claim about the
/// *mechanism* being present, not a promise the round trip will succeed: a
/// window manager that does not publish `_NET_CLIENT_LIST_STACKING` fails at
/// call time with its own explanation, exactly as a Hyprland socket that does
/// not answer already does.
#[cfg(any(target_os = "linux", test))]
pub fn window_below_source_for_linux(session: LinuxSession) -> WindowBelowSource {
    if session.hyprland {
        WindowBelowSource::HyprlandIpc
    } else if session.wayland {
        WindowBelowSource::Nothing
    } else {
        WindowBelowSource::X11Stacking
    }
}

/// Map a probed Linux session onto the descriptor. Pure.
#[cfg(any(target_os = "linux", test))]
pub fn capabilities_for_linux(session: LinuxSession) -> SurfaceCapabilities {
    let mut notes = Vec::new();
    let layer_shell = session.layer_shell();
    let placement = placement_source_for_linux(session);
    let read_below = window_below_source_for_linux(session);

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

    if let Some(note) = read_below.note() {
        notes.push(note.to_string());
    }

    if let Some(note) = placement.note() {
        notes.push(note.to_string());
    }

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
        multi_monitor_placement: placement.support(),
        read_window_below: read_below.support(),
        read_window_below_source: read_below.label().map(str::to_string),
        notes,
    }
}

/// macOS and Windows. Both give an ordinary toplevel everything except an input
/// region with a hole.
#[cfg(all(desktop, not(target_os = "linux")))]
fn capabilities_for_other_desktop() -> SurfaceCapabilities {
    let platform = if cfg!(target_os = "macos") {
        "macos"
    } else {
        "windows"
    };

    capabilities_for_other_desktop_with(platform, window_below_source())
}

/// The mapping, split out from the probe so it is a pure function with tests.
///
/// Compiled under `cfg(test)` on Linux too, and that is the point: the CI job
/// this repo actually runs is a Linux one, so a `cfg`-gated macOS/Windows
/// descriptor is otherwise checked by nothing at all. That is precisely how the
/// `multiMonitorPlacement: Supported` claim survived here with no code behind
/// it (MJXHRM-417).
#[cfg(any(all(desktop, not(target_os = "linux")), test))]
fn capabilities_for_other_desktop_with(
    platform: &str,
    read_below: WindowBelowSource,
) -> SurfaceCapabilities {
    let mut notes = vec![
        "Only whole-surface click-through is available; there is no partial input region, so the \
         surface is either interactive everywhere or nowhere."
            .to_string(),
    ];
    if let Some(note) = read_below.note() {
        notes.push(note.to_string());
    }

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
        // The pointer is readable and a window can be moved to it — and, since
        // MJXHRM-417, actually is. This used to claim `Supported` while nothing
        // in the codebase positioned a satellite at all, which made it the
        // boldest of the descriptor's untrue entries rather than the safest.
        multi_monitor_placement: PlacementSource::Pointer.support(),
        read_window_below: read_below.support(),
        read_window_below_source: read_below.label().map(str::to_string),
        notes,
    }
}

// ---------------------------------------------------------------------------
// Who may reshape which window (MJXHRM-382)
// ---------------------------------------------------------------------------
//
// The webview these are reached from is *not* a trusted principal: plugins run
// in the app's own webview with the app's full authority (see
// `contrib/runtime-loader.ts`, which says so in as many words), so any plugin —
// or any injected content in a rendered message — reaches this IPC surface. A
// caller that could name `main` and hand it an overlay-layer wlr-layer-shell
// role with `keyboardFocus: exclusive` would turn the user's ordinary window
// into a screen-covering surface that takes every keystroke; one that could
// shape a window's input region could make it swallow or ignore every click.
//
// The rule is ownership, expressed in the label namespace this app already
// uses. Only satellites (`sat-*`, see `store/windows.ts`) are reshapeable at
// all — never `main`, `tile-*`, `instance-*`, `session-*` or `screen` — and a
// satellite may only be reshaped by the window that attached it, or by itself.
//
// **Attaching is no longer reachable from JS at all** (MJXHRM-382, second
// pass). An ownership check over a caller-supplied label was only ever as
// strong as the label space: the webview held
// `core:webview:allow-create-webview-window`, so the same caller could mint its
// own `sat-anything` — or squat `sat-hud` before the real HUD existed — and
// then attach *that*, with a namespace, layer and keyboard mode of its
// choosing. The window is now built by `window::open_satellite_window` out of a
// registry Rust owns, that permission is gone from `capabilities/default.json`,
// and the request is never a value from the webview. What remains below guards
// `surface_set_interactive_rect`, which a satellite legitimately calls about
// itself, and records the ownership that check reads.

/// Label prefix for satellite windows. Must stay in step with
/// `SATELLITE_LABEL_PREFIX` in `store/windows.ts` and with the `sat-*` glob in
/// `capabilities/default.json`.
#[cfg(desktop)]
const SATELLITE_PREFIX: &str = "sat-";

/// Which satellite label was attached by which window. Keyed by the satellite,
/// valued by its owner — the window whose `open_satellite_window` built it.
#[cfg(desktop)]
static SURFACE_OWNERS: std::sync::Mutex<std::collections::BTreeMap<String, String>> =
    std::sync::Mutex::new(std::collections::BTreeMap::new());

/// True for a well-formed satellite label — the same shape `satelliteLabel()`
/// builds in `store/windows.ts`: `sat-` plus a lowercase surface id.
///
/// Deliberately stricter than "starts with `sat-`": the suffix also lands in a
/// URL query and in compositor rules, and refusing anything else here means a
/// label that looks like a satellite but is not can never reach the GTK calls.
#[cfg(desktop)]
fn is_satellite_label(label: &str) -> bool {
    let Some(surface) = label.strip_prefix(SATELLITE_PREFIX) else {
        return false;
    };

    let mut chars = surface.chars();

    matches!(chars.next(), Some(c) if c.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// May `caller` turn `target` into a floating surface?
///
/// Pure so the policy is testable without a window system. `owner` is the
/// currently recorded owner of `target`, if any.
///
/// A satellite is refused as a *caller*: `canOpenSatelliteWindow()` holds the
/// same rule in the frontend, and a HUD that lives over other applications is
/// the most exposed webview in the app — it must not be able to mint further
/// overlay surfaces if it is compromised. Enforcing it here rather than only
/// there is the difference between a rule and a convention.
#[cfg(desktop)]
fn may_attach(caller: &str, target: &str, owner: Option<&str>) -> Result<(), String> {
    if !is_satellite_label(target) {
        return Err(format!(
            "refusing to attach a floating surface to {target}: only satellite windows \
             ({SATELLITE_PREFIX}*) may be reshaped"
        ));
    }
    if is_satellite_label(caller) {
        return Err(format!(
            "refusing to attach a floating surface from {caller}: a satellite may not attach \
             another"
        ));
    }
    match owner {
        Some(owner) if owner != caller => Err(format!(
            "refusing to attach {target}: it belongs to {owner}, not {caller}"
        )),
        _ => Ok(()),
    }
}

/// May `caller` reshape `target`'s input region?
///
/// Unlike attaching, this one is called *by the HUD about itself* — see
/// `app/hud/use-hud-surface.ts`, which reports the rect it wants clicks in — so
/// a satellite acting on itself is allowed. Everyone else must be its owner.
#[cfg(desktop)]
fn may_reshape(caller: &str, target: &str, owner: Option<&str>) -> Result<(), String> {
    if !is_satellite_label(target) {
        return Err(format!(
            "refusing to set an input region on {target}: only satellite windows \
             ({SATELLITE_PREFIX}*) may be reshaped"
        ));
    }
    if caller == target || owner == Some(caller) {
        return Ok(());
    }

    Err(format!(
        "refusing to set an input region on {target}: {caller} neither owns nor is it"
    ))
}

/// Authorize `caller` to attach `target`, and record the ownership on success.
///
/// A record whose owner window is gone is dropped first: satellites are torn
/// down with the window that summoned them, so a stale record could otherwise
/// lock a label out for the rest of the process's life.
#[cfg(desktop)]
fn claim_surface(app: &tauri::AppHandle, caller: &str, target: &str) -> Result<(), String> {
    let mut owners = SURFACE_OWNERS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    owners.retain(|_, owner| app.get_webview_window(owner).is_some());
    may_attach(caller, target, owners.get(target).map(String::as_str))?;
    owners.insert(target.to_string(), caller.to_string());

    Ok(())
}

/// Authorize `caller` to reshape `target`'s input region.
#[cfg(desktop)]
fn check_reshape(caller: &str, target: &str) -> Result<(), String> {
    let owners = SURFACE_OWNERS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    may_reshape(caller, target, owners.get(target).map(String::as_str))
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

/// Probe the running Linux session. **Must run on the GTK main thread** — it
/// asks GDK for the backend and gtk-layer-shell for the compositor's answer.
#[cfg(target_os = "linux")]
fn probe_linux_session() -> LinuxSession {
    let shell = layer_shell::get();
    let wayland = gtk::gdk::Display::default()
        .map(|d| {
            use gtk::gdk::prelude::DisplayExtManual;
            d.backend().is_wayland()
        })
        .unwrap_or(false);

    LinuxSession {
        wayland,
        layer_shell_library: shell.is_some(),
        // Behavioural: asks the compositor, not the library's presence.
        layer_shell_supported: shell.map(|s| s.is_supported()).unwrap_or(false),
        layer_shell_protocol: shell
            .filter(|s| s.is_supported())
            .map(|s| s.protocol_version()),
        hyprland: below::hyprland_available(),
    }
}

/// How a floating surface gets onto the right monitor here (MJXHRM-417). The
/// descriptor's `multiMonitorPlacement` is this same value, so a caller reading
/// the capability is reading the mechanism.
///
/// **Must run on the GTK main thread** on Linux.
#[cfg(desktop)]
fn placement_source() -> PlacementSource {
    #[cfg(target_os = "linux")]
    {
        placement_source_for_linux(probe_linux_session())
    }
    #[cfg(not(target_os = "linux"))]
    {
        // macOS and Windows: the pointer is readable and a window can be moved
        // to where it is.
        PlacementSource::Pointer
    }
}

/// Which mechanism answers `read_window_below` here (MJXHRM-392). The
/// descriptor's `readWindowBelow` is derived from this same value, so a caller
/// reading the capability is reading the mechanism.
///
/// **Must run on the GTK main thread** on Linux.
#[cfg(desktop)]
fn window_below_source() -> WindowBelowSource {
    #[cfg(target_os = "linux")]
    {
        window_below_source_for_linux(probe_linux_session())
    }
    #[cfg(target_os = "macos")]
    {
        // The one platform where the mechanism is the same call either way and
        // only the *completeness* of its answer changes. Preflight never
        // prompts; nothing in this crate calls the API that does. See
        // `surface/mac.rs`.
        if mac::titles_available() {
            WindowBelowSource::MacWindowList
        } else {
            WindowBelowSource::MacWindowListUntitled
        }
    }
    #[cfg(target_os = "windows")]
    {
        WindowBelowSource::Win32EnumWindows
    }
}

/// [`window_below_source`], from wherever the caller happens to be.
///
/// The `read_window_below` command runs on a blocking pool and the Linux probe
/// must run on the GTK main thread, so the hop lives here rather than being
/// worked around with a second, cheaper, subtly different probe — which is how
/// a capability report and the code behind it come apart.
#[cfg(desktop)]
pub fn window_below_source_for(app: &tauri::AppHandle) -> Result<WindowBelowSource, String> {
    #[cfg(target_os = "linux")]
    {
        on_main_thread(app, |_| window_below_source())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = app;

        Ok(window_below_source())
    }
}

/// Which output the user is on, from whatever will say so — blocking IPC, so it
/// is fetched off the main thread before a window is built rather than during.
///
/// `None` is a normal answer: it means the compositor chooses, which is what a
/// layer surface naming no output already gets.
#[cfg(desktop)]
pub async fn active_output() -> Option<placement::FocusedOutput> {
    #[cfg(target_os = "linux")]
    {
        tauri::async_runtime::spawn_blocking(below::read_focused_monitor)
            .await
            .ok()
            .flatten()
    }
    #[cfg(not(target_os = "linux"))]
    {
        // The pointer answers this on every other platform, and it is read at
        // placement time from the main thread — there is nothing to fetch here.
        None
    }
}

/// Move `window` onto the monitor the pointer is on, horizontally centred and
/// `top_margin` logical pixels down (vertically centred when `top_margin` is
/// `None`). Returns the monitor it was placed on, or `None` when nothing was
/// moved.
///
/// Refuses on Wayland, and that refusal is the substance of this function.
/// `cursor_position()` there is a hardcoded `Ok((0, 0))` (tao 0.35.3,
/// `platform_impl/linux/util.rs:18`) and `set_position` is a request the
/// protocol has no way to make, so a placement written the obvious way would
/// report success while pinning every surface to whichever monitor sits at the
/// layout origin. [`placement_source`] is what stops that, and it is the same
/// value the descriptor publishes.
///
/// **Must run on the GTK main thread** on Linux.
#[cfg(desktop)]
pub fn place_on_active_monitor(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    top_margin: Option<i32>,
) -> Option<String> {
    if placement_source() != PlacementSource::Pointer {
        return None;
    }

    let cursor = app.cursor_position().ok()?;
    let monitors = app.available_monitors().ok()?;
    // Containment is tested against the whole monitor: the pointer can sit over
    // a taskbar, which is outside the work area but very much on that screen.
    let screens: Vec<MonitorRect> = monitors
        .iter()
        .map(|m| MonitorRect {
            name: m.name().cloned(),
            x: f64::from(m.position().x),
            y: f64::from(m.position().y),
            width: f64::from(m.size().width),
            height: f64::from(m.size().height),
        })
        .collect();
    let monitor = monitors.get(placement::monitor_at_point(&screens, cursor.x, cursor.y)?)?;
    // Placement uses the work area, so the surface does not open underneath a
    // taskbar or the macOS menu bar.
    let area = monitor.work_area();
    let usable = MonitorRect {
        name: None,
        x: f64::from(area.position.x),
        y: f64::from(area.position.y),
        width: f64::from(area.size.width),
        height: f64::from(area.size.height),
    };
    let size = window.outer_size().ok()?;
    let (width, height) = (f64::from(size.width), f64::from(size.height));
    let margin = match top_margin {
        // Everything here is physical; the margin is authored in logical pixels
        // because that is what the layer-shell side uses for the same surface.
        Some(margin) => f64::from(margin) * monitor.scale_factor(),
        None => ((usable.height - height) / 2.0).max(0.0),
    };
    let (x, y) = placement::top_centred(&usable, width, height, margin);

    window
        .set_position(tauri::PhysicalPosition::new(
            x.round() as i32,
            y.round() as i32,
        ))
        .map_err(|e| {
            log::warn!(
                "could not place {} on {:?}: {e}",
                window.label(),
                monitor.name()
            )
        })
        .ok()?;

    monitor.name().cloned()
}

/// The GDK monitor for `output`, or `None` when nothing matches it — in which
/// case the surface names no output and the compositor chooses.
///
/// **Must run on the GTK main thread.**
#[cfg(target_os = "linux")]
fn gdk_monitor_for(
    display: &gtk::gdk::Display,
    output: &placement::FocusedOutput,
) -> Option<gtk::gdk::Monitor> {
    use gtk::gdk::prelude::MonitorExt;

    let monitors: Vec<gtk::gdk::Monitor> = (0..display.n_monitors())
        .filter_map(|index| display.monitor(index))
        .collect();
    // GDK reports LOGICAL geometry, which is the space Hyprland's layout
    // coordinates are in; the two agreed exactly on the machine this was built
    // against (0,0 and 1920,0). The model is the fallback key — GDK never
    // reports the connector name.
    let rects: Vec<MonitorRect> = monitors
        .iter()
        .map(|m| {
            let geometry = m.geometry();

            MonitorRect {
                name: m.model().map(|model| model.to_string()),
                x: f64::from(geometry.x()),
                y: f64::from(geometry.y()),
                width: f64::from(geometry.width()),
                height: f64::from(geometry.height()),
            }
        })
        .collect();

    monitors
        .into_iter()
        .nth(placement::monitor_at_origin(&rects, output)?)
}

/// What this platform can do for a floating surface.
#[cfg(desktop)]
#[tauri::command]
pub async fn surface_capabilities(app: tauri::AppHandle) -> Result<SurfaceCapabilities, String> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "linux")]
        {
            on_main_thread(&app, |_| capabilities_for_linux(probe_linux_session()))
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
///
/// **Not an IPC command, and that is the point (MJXHRM-382).** The only caller is
/// `window::open_satellite_window`, which builds the window in the same
/// main-thread turn and hands over a request out of its own pinned registry, so
/// neither the target nor the layer/namespace/keyboard-focus it gets is ever a
/// value that crossed the IPC boundary. `caller` is the label of the webview
/// that asked for the satellite; it is still authorized (see [`may_attach`]) and
/// recorded as the surface's owner, because [`surface_set_interactive_rect`] —
/// which *is* reachable from JS — answers to that record.
///
/// Must be called on the main thread.
#[cfg(desktop)]
pub fn attach_floating_surface(
    app: &tauri::AppHandle,
    caller: &str,
    label: &str,
    request: &SurfaceRequest,
    output: Option<&placement::FocusedOutput>,
) -> Result<SurfaceGrant, String> {
    attach_on_main(app, caller, label, request, output)
}

#[cfg(desktop)]
fn attach_on_main(
    app: &tauri::AppHandle,
    caller: &str,
    label: &str,
    request: &SurfaceRequest,
    output: Option<&placement::FocusedOutput>,
) -> Result<SurfaceGrant, String> {
    claim_surface(app, caller, label)?;

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

        let placement = placement_source();
        let shell = layer_shell::get().filter(|s| s.is_supported());
        if let Some(shell) = shell {
            shell.init_for_window(&gtk_win)?;
            // Which output the surface belongs on (MJXHRM-417). Naming one is
            // the only way a client on Wayland has any say; where nothing will
            // tell us which output has focus we name none, the compositor
            // chooses, and the grant says which of the two happened.
            let monitor = output.and_then(|output| {
                use gtk::prelude::WidgetExt;

                gdk_monitor_for(&gtk_win.display(), output)
            });
            if monitor.is_none() {
                degraded.push(placement.note().map(str::to_string).unwrap_or_else(|| {
                    // The session *can* name an output and we still did not:
                    // the socket did not answer, or what it named matched no
                    // monitor GDK knows about. Distinct from "this session
                    // cannot choose", and it must not be silent.
                    "Could not work out which monitor has focus, so the compositor chose which \
                     screen this surface opened on."
                        .to_string()
                }));
            }
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
                monitor.as_ref(),
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
                monitor: monitor.and_then(|m| {
                    use gtk::gdk::prelude::MonitorExt;

                    m.model().map(|model| model.to_string())
                }),
                degraded,
            });
        }

        // Fallback: an ordinary toplevel. On X11 that genuinely floats; on
        // Wayland it does not, and saying so is the entire job of this branch.
        let _ = window.set_always_on_top(true);
        // X11 can still be put on the right monitor; Wayland cannot, and
        // `place_on_active_monitor` refuses rather than pretending.
        let placed = place_on_active_monitor(app, &window, Some(request.margins[2]));
        if placed.is_none() {
            if let Some(note) = placement.note() {
                degraded.push(note.to_string());
            }
        }
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
            monitor: placed,
            degraded,
        });
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = output;
        window
            .set_always_on_top(true)
            .map_err(|e| format!("could not raise the surface: {e}"))?;
        let placed = place_on_active_monitor(app, &window, Some(request.margins[2]));
        if placed.is_none() {
            degraded.push(
                "Could not work out which monitor the pointer is on, so this surface opened \
                 wherever the window manager put it."
                    .to_string(),
            );
        }
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
            monitor: placed,
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
///
/// `label` is **authorized, not trusted** — see [`may_reshape`]. A surface may
/// shape itself (the HUD does), and its owner may shape it; nothing else can,
/// because an input region is also a way to make a window swallow or ignore
/// every click in it. This is the one half of the surface API that stayed on the
/// IPC boundary, because the rect is measured inside the satellite's own
/// document (`app/hud/use-hud-surface.ts`) and only it knows the number.
#[cfg(desktop)]
#[tauri::command]
pub async fn surface_set_interactive_rect(
    app: tauri::AppHandle,
    webview: tauri::WebviewWindow,
    label: String,
    rect: Option<Rect>,
) -> Result<Support, String> {
    check_reshape(webview.label(), &label)?;

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

/// Mobile stub. Registered so a stray call from shared frontend code gets a
/// clear refusal rather than "unknown command".
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
        // X11 hands out the pointer's real position and honours a move, so the
        // surface goes on the monitor the user is on.
        assert_eq!(caps.multi_monitor_placement, Support::Supported);
        assert!(!caps.notes.iter().any(|n| n.contains("compositor's choice")));
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

    // -----------------------------------------------------------------------
    // Which mechanism reads the window underneath (MJXHRM-392)
    // -----------------------------------------------------------------------

    /// Wayland-without-Hyprland is the one Linux session that cannot answer.
    /// It must say so *and say why* — an `Unsupported` with no note is a bug
    /// report the user has no next step for.
    #[test]
    fn wayland_without_hyprland_cannot_read_the_window_below_and_says_why() {
        let session = LinuxSession {
            hyprland: false,
            ..hyprland_session()
        };
        assert_eq!(
            window_below_source_for_linux(session),
            WindowBelowSource::Nothing
        );

        let caps = capabilities_for_linux(session);
        assert_eq!(caps.read_window_below, Support::Unsupported);
        assert!(caps.read_window_below_source.is_none());
        // Matched on a phrase only THIS note carries. "Wayland" on its own is
        // not a check: the placement note on the very same session says it too,
        // so the assertion still passed with the read-below note deleted.
        assert!(
            caps.notes
                .iter()
                .any(|n| n.contains("withholds window identity")),
            "{:?}",
            caps.notes
        );
    }

    /// X11 can enumerate every window on the display; that is the property
    /// Wayland removed. Before MJXHRM-392 this session reported `Unsupported`
    /// with a note saying so, and the note was the accurate part.
    #[test]
    fn an_x11_session_reads_the_window_below_over_the_x_protocol() {
        let session = LinuxSession {
            wayland: false,
            layer_shell_library: false,
            layer_shell_supported: false,
            layer_shell_protocol: None,
            hyprland: false,
        };
        assert_eq!(
            window_below_source_for_linux(session),
            WindowBelowSource::X11Stacking
        );

        let caps = capabilities_for_linux(session);
        assert_eq!(caps.read_window_below, Support::Supported);
        assert_eq!(
            caps.read_window_below_source.as_deref(),
            Some("x11-stacking")
        );
        assert!(
            !caps.notes.iter().any(|n| n.contains("window underneath")),
            "a supported mechanism owes no apology: {:?}",
            caps.notes
        );
    }

    /// Hyprland wins over X11 even with `DISPLAY` set, which it is on any
    /// session running XWayland: its IPC socket sees native Wayland clients and
    /// an X11 enumeration cannot.
    #[test]
    fn hyprland_beats_x11_when_both_look_available() {
        assert_eq!(
            window_below_source_for_linux(LinuxSession {
                wayland: false,
                ..hyprland_session()
            }),
            WindowBelowSource::HyprlandIpc
        );
        assert_eq!(
            capabilities_for_linux(hyprland_session())
                .read_window_below_source
                .as_deref(),
            Some("hyprland-ipc")
        );
    }

    /// The macOS/Windows descriptor, exercised from the Linux CI job — the only
    /// job this repo runs. MJXHRM-417 found `multiMonitorPlacement: Supported`
    /// here with nothing behind it precisely because nothing compiled this
    /// function.
    #[test]
    fn windows_reads_the_window_below_and_says_which_call_does_it() {
        let caps =
            capabilities_for_other_desktop_with("windows", WindowBelowSource::Win32EnumWindows);
        assert_eq!(caps.platform, "windows");
        assert_eq!(caps.read_window_below, Support::Supported);
        assert_eq!(
            caps.read_window_below_source.as_deref(),
            Some("win32-enum-windows")
        );
        assert!(!caps.notes.iter().any(|n| n.contains("Screen Recording")));
    }

    /// macOS is the one platform whose answer can be partial: everything but
    /// the title is public. `Degraded` with the reason attached is the honest
    /// report — `Supported` would promise titles that are not coming, and
    /// `Unsupported` would throw away a reading the model can use.
    #[test]
    fn macos_degrades_rather_than_refusing_when_titles_are_withheld() {
        let granted =
            capabilities_for_other_desktop_with("macos", WindowBelowSource::MacWindowList);
        assert_eq!(granted.read_window_below, Support::Supported);
        assert_eq!(
            granted.read_window_below_source.as_deref(),
            Some("macos-window-list")
        );
        assert!(!granted.notes.iter().any(|n| n.contains("Screen Recording")));

        let withheld =
            capabilities_for_other_desktop_with("macos", WindowBelowSource::MacWindowListUntitled);
        assert_eq!(withheld.read_window_below, Support::Degraded);
        assert_eq!(
            withheld.read_window_below_source.as_deref(),
            Some("macos-window-list-untitled")
        );
        assert!(
            withheld
                .notes
                .iter()
                .any(|n| n.contains("Screen Recording")),
            "{:?}",
            withheld.notes
        );
    }

    // -----------------------------------------------------------------------
    // Which monitor a surface opens on (MJXHRM-417)
    // -----------------------------------------------------------------------

    /// With the compositor's focused output readable, the surface is placed
    /// deliberately — `gtk_layer_set_monitor` with the output Hyprland named —
    /// so the descriptor may say so outright.
    #[test]
    fn hyprland_places_the_surface_on_the_focused_output() {
        let caps = capabilities_for_linux(hyprland_session());
        assert_eq!(
            placement_source_for_linux(hyprland_session()),
            PlacementSource::FocusedOutput
        );
        assert_eq!(caps.multi_monitor_placement, Support::Supported);
    }

    /// A wlroots compositor with no IPC we can read: the surface names no
    /// output and the compositor chooses. Degraded — and, unlike before this
    /// ticket, degraded *with a stated reason*, which is what the enum's own
    /// documentation promises.
    #[test]
    fn without_an_ipc_socket_the_compositor_chooses_and_says_so() {
        let session = LinuxSession {
            hyprland: false,
            ..hyprland_session()
        };
        assert_eq!(
            placement_source_for_linux(session),
            PlacementSource::CompositorChoice
        );

        let caps = capabilities_for_linux(session);
        assert_eq!(caps.multi_monitor_placement, Support::Degraded);
        assert!(
            caps.notes
                .iter()
                .any(|n| n.contains("the compositor's choice")),
            "a degraded placement must explain itself: {:?}",
            caps.notes
        );
    }

    /// The correction this ticket turned up: a plain Wayland toplevel cannot be
    /// placed at all — no pointer position, no way to move itself — so the
    /// answer is Unsupported, not the Degraded that was reported for every
    /// Linux session regardless of backend.
    #[test]
    fn a_plain_wayland_toplevel_cannot_be_placed_at_all() {
        let session = LinuxSession {
            layer_shell_supported: false,
            ..hyprland_session()
        };
        assert_eq!(
            placement_source_for_linux(session),
            PlacementSource::Nothing
        );

        let caps = capabilities_for_linux(session);
        assert_eq!(caps.multi_monitor_placement, Support::Unsupported);
        assert!(caps
            .notes
            .iter()
            .any(|n| n.contains("neither the pointer's position nor the ability to move")));
    }

    /// The guard the whole module turns on. `cursor_position()` answers
    /// `Ok((0, 0))` on Wayland (tao) and `gdk_device_get_position` answers the
    /// same, so a pointer-driven placement there would silently pin every
    /// surface to whichever monitor sits at the layout origin. No Wayland
    /// session may reach that path, whatever else is true of it.
    #[test]
    fn no_wayland_session_ever_places_from_the_pointer() {
        for library in [false, true] {
            for supported in [false, true] {
                for hyprland in [false, true] {
                    let session = LinuxSession {
                        wayland: true,
                        layer_shell_library: library,
                        layer_shell_supported: supported,
                        layer_shell_protocol: None,
                        hyprland,
                    };
                    assert_ne!(
                        placement_source_for_linux(session),
                        PlacementSource::Pointer,
                        "{session:?} must not trust the pointer"
                    );
                }
            }
        }
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

    // -----------------------------------------------------------------------
    // Ownership (MJXHRM-382)
    // -----------------------------------------------------------------------

    #[cfg(desktop)]
    #[test]
    fn only_satellite_labels_are_reshapeable() {
        for label in ["sat-hud", "sat-bubble", "sat-a1-b2"] {
            assert!(is_satellite_label(label), "{label} should be a satellite");
        }
        for label in [
            "main",
            "tile-1",
            "instance-2",
            "session-abc",
            "screen",
            "sat-",
            "sat--x",
            "sat-1hud",
            "sat-HUD",
            "sat-hud/../main",
            "SAT-hud",
            "",
        ] {
            assert!(
                !is_satellite_label(label),
                "{label} should not be a satellite"
            );
        }
    }

    #[cfg(desktop)]
    #[test]
    fn a_caller_cannot_attach_a_window_it_does_not_own() {
        // The finding this ticket exists for: naming the main window and handing
        // it an overlay role with exclusive keyboard focus.
        assert!(may_attach("main", "main", None).is_err());
        assert!(may_attach("main", "tile-1", None).is_err());
        assert!(may_attach("tile-1", "instance-2", None).is_err());

        // Its own satellite is fine.
        assert!(may_attach("main", "sat-hud", None).is_ok());
        assert!(may_attach("main", "sat-hud", Some("main")).is_ok());

        // Another window's satellite is not.
        assert!(may_attach("tile-1", "sat-hud", Some("main")).is_err());
    }

    #[cfg(desktop)]
    #[test]
    fn a_satellite_cannot_attach_anything() {
        // A HUD living over other applications is the app's most exposed
        // webview; it must not be able to mint further overlay surfaces.
        assert!(may_attach("sat-hud", "sat-other", None).is_err());
        assert!(may_attach("sat-hud", "sat-hud", None).is_err());
        assert!(may_attach("sat-hud", "main", None).is_err());
    }

    #[cfg(desktop)]
    #[test]
    fn a_surface_may_shape_itself_or_be_shaped_by_its_owner() {
        // The HUD reports its own interactive rect from inside itself.
        assert!(may_reshape("sat-hud", "sat-hud", Some("main")).is_ok());
        assert!(may_reshape("sat-hud", "sat-hud", None).is_ok());
        // So may the window that attached it.
        assert!(may_reshape("main", "sat-hud", Some("main")).is_ok());

        // A bystander may not, and no one may shape a non-satellite — making the
        // main window's input region empty would swallow every click in it.
        assert!(may_reshape("tile-1", "sat-hud", Some("main")).is_err());
        assert!(may_reshape("sat-other", "sat-hud", Some("main")).is_err());
        assert!(may_reshape("main", "main", None).is_err());
    }
}
