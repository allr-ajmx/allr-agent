//! Native multi-window support: MJX-104 (desktop session/instance pop-outs),
//! MJX-142 (iOS UIScene), MJX-141 (Android Activity). Opens an internal app route
//! in a new `WebviewWindow`: a single chat session (frameless, `?win=secondary`),
//! a full app instance, or an activity screen (Settings / Command Center,
//! `?win=activity&screen=…`). Windows are built on the main thread (gtk/WKWebView
//! requirement), mirroring `oauth.rs`. Rust-side creation bypasses the ACL; each
//! new window's JS surface is scoped by the `session-*` / `instance-*` / `settings`
//! / `command-center` capability globs in `capabilities/default.json`.
//!
//! Platform model:
//! - Desktop: real multi-window. Session/instance pop-outs open frameless windows;
//!   activity screens stay in-app overlays (the stubs below only keep the command
//!   names registered).
//! - iOS (MJX-142/176): with `UIApplicationSupportsMultipleScenes` (`Info.ios.plist`)
//!   set, building a `WebviewWindow` maps onto a native `UIScene` — side-by-side on
//!   iPad, replacing on single-scene iPhone. Session/instance pop-outs and the
//!   Settings/Command-Center activity screens all open as scenes. `fill_requested_scene`
//!   fills scenes the *system* requests unprompted (state restoration, iPad
//!   app-switcher "+", Handoff) via `RunEvent::SceneRequested` in `lib.rs`.
//! - Android (MJX-141): Settings/Command Center open as their own `TauriActivity`
//!   (bound by label via `activity_name`). Session/instance pop-outs are not yet
//!   wired on Android (stubbed); the frontend gates that affordance off there.
//!
//! The runtime affordances are gated frontend-side on `supportsMultipleWindows()`
//! (`store/windows.ts`).

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::oneshot;

// --------------------------------------------------------------------------
// Session & instance pop-outs (desktop + iOS). `unminimize()` / `decorations()`
// are desktop-only `WebviewWindow` ops; on iOS a window IS a UIScene (no chrome,
// no minimize, system-sized), so those calls are gated to `desktop`. Not built on
// Android, where session pop-out needs Activity scaffolding that isn't wired yet.
// --------------------------------------------------------------------------
#[cfg(any(desktop, target_os = "ios"))]
use std::sync::atomic::{AtomicU32, Ordering};

#[cfg(any(desktop, target_os = "ios"))]
const WINDOW_WIDTH: f64 = 480.0;
#[cfg(any(desktop, target_os = "ios"))]
const WINDOW_HEIGHT: f64 = 900.0;
#[cfg(any(desktop, target_os = "ios"))]
const WINDOW_MIN_WIDTH: f64 = 380.0;
#[cfg(any(desktop, target_os = "ios"))]
const WINDOW_MIN_HEIGHT: f64 = 520.0;

// Monotonic so a closed-then-reopened instance never reuses a live label.
#[cfg(any(desktop, target_os = "ios"))]
static INSTANCE_SEQ: AtomicU32 = AtomicU32::new(1);

/// Label prefix for a detached-tile window (`capabilities/default.json` scopes
/// the JS surface with a matching `tile-*` glob).
#[cfg(any(desktop, target_os = "ios"))]
const TILE_LABEL_PREFIX: &str = "tile";

/// A session tile's id — must match `TILE_PANE_PREFIX` in `src/lib/pane-ids.ts`.
#[cfg(any(desktop, target_os = "ios"))]
const SESSION_TILE_PREFIX: &str = "session-tile:";

/// Emitted to every window when a detached-tile window is destroyed, so the
/// primary window can put the tile back in its slot.
///
/// Native-side on purpose: the alternative is the closing webview announcing its
/// own `pagehide`, which is exactly the signal least likely to survive a window
/// being torn down — and universal runs WebKitGTK on Linux, where that is not a
/// theoretical worry. `RunEvent::WindowEvent` fires from tao regardless.
pub const TILE_WINDOW_CLOSED_EVENT: &str = "hermes://tile-window-closed";

/// Whether a destroyed window was a detached tile. The label is SLUGGED
/// (`session-tile:x` -> `tile-session-tile-x`) and therefore not the tile id, so
/// `open_tile_window` RETURNS the label it built and the frontend matches on
/// that — rather than either side reimplementing the other's slug.
pub fn is_tile_window_label(label: &str) -> bool {
    label.starts_with("tile-")
}

/// Emitted to every window when a satellite window is destroyed, carrying its
/// label (MJXHRM-371).
///
/// Native-side for the same reason as [`TILE_WINDOW_CLOSED_EVENT`], and the
/// reason binds harder here: the HUD holds the gateway's binding for whatever
/// session it resumed, so the main window cannot reclaim that stream until it
/// knows the HUD is gone. Asking the closing webview to announce its own
/// `pagehide` would put the one message that must not be missed on the least
/// reliable signal in the app. `RunEvent::WindowEvent` fires from tao regardless
/// of whether the page got to run anything.
pub const SATELLITE_WINDOW_CLOSED_EVENT: &str = "hermes://satellite-window-closed";

/// Whether a destroyed window was a satellite. Must agree with
/// `SATELLITE_LABEL_PREFIX` in `src/store/windows.ts`, which reads these labels
/// back, and with the `sat-*` glob in `capabilities/default.json`.
pub fn is_satellite_window_label(label: &str) -> bool {
    label.starts_with("sat-")
}

/// Emitted to every remaining window when a FULL APP window is destroyed — the
/// main window or an `instance-*` one, not a tile and not a satellite.
///
/// It exists for one thing the frontend cannot otherwise learn: OS-level hotkeys
/// (`lib/keybinds/global-shortcut.ts`) are claimed by a webview, and the claim is
/// app-global while the handler channel that answers it belongs to the window
/// that made it. Every full window tries to claim the same chords at boot and
/// all but the first are refused with "already registered", so exactly one
/// window owns each. When THAT window is closed natively no JS teardown runs in
/// it, `releaseGlobalShortcuts` never happens, and the chord stays claimed from
/// the whole machine while answering into a channel that died with the window —
/// registered, stolen, and dead, until the app restarts.
///
/// The survivors reclaim on this event. Emitted from `RunEvent::WindowEvent`
/// like its two siblings above, and for the same reason: the window it concerns
/// is the one that cannot report it.
pub const APP_WINDOW_CLOSED_EVENT: &str = "hermes://app-window-closed";

/// Whether a destroyed window was a full app window — one that mounts the whole
/// shell, and therefore one that may have been holding the global-hotkey claims.
/// Tiles and satellites never mount `useKeybinds`, so they never claim anything.
pub fn is_app_window_label(label: &str) -> bool {
    !is_tile_window_label(label) && !is_satellite_window_label(label)
}

// --------------------------------------------------------------------------
// Satellites (MJXHRM-55 / MJXHRM-213 / MJXHRM-382)
//
// A satellite is a SECOND SURFACE of the app in its own window — living over
// other applications, and gone the moment it is done. Three exist: the HUD and
// Quick Entry, both summoned by a hotkey and typed into, and the wake indicator
// (MJXHRM-228), which is not typed into at all — it is a light, opened and
// closed by the state it mirrors rather than by the user, and it is the only one
// that takes neither clicks nor focus.
//
// They are built HERE rather than in the frontend, and the frontend no longer
// holds `core:webview:allow-create-webview-window` at all. That is a security
// boundary, not tidiness (MJXHRM-382): a satellite is the one window kind that
// may be handed a wlr-layer-shell role — an output-sized overlay with exclusive
// keyboard focus — and while the webview could mint windows, the label space
// that role is keyed on was writable by whoever ran code in the webview. Any
// plugin (`contrib/runtime-loader.ts`: "a loaded plugin is evaluated as ESM in
// the webview realm with FULL app authority") could create its own `sat-…`,
// hand it that role, and cover the screen with content of its choosing; or
// create `sat-hud` first and *be* the HUD when the user next summoned it.
//
// So the registry below is the complete set of satellites, their geometry, and
// — the part that matters — the surface request each is allowed to be attached
// with. Nothing about a satellite except which one, and which in-app route it
// opens on, crosses the IPC boundary.
// --------------------------------------------------------------------------

/// A satellite's window, fixed at compile time.
#[cfg(desktop)]
struct SatelliteSpec {
    /// Surface id: the `?win=` flag, and the `sat-<id>` label suffix.
    surface: &'static str,
    width: f64,
    height: f64,
    transparent: bool,
    /// How far down the active monitor the window sits, in logical pixels;
    /// `None` centres it vertically. Only reached on the platforms that can
    /// place a window at all (MJXHRM-417) — a layer surface is positioned by
    /// [`FloatingSpec::margins`] instead, which is why the HUD repeats the same
    /// number through both.
    top_margin: Option<i32>,
    /// A `wlr-layer-shell` role to ask for, or `None` for a plain always-on-top
    /// window. **Pinned here, never taken from the caller** — namespace, layer
    /// and keyboard mode are exactly the privileges this ticket exists over.
    floating: Option<FloatingSpec>,
    /// Whether the satellite may take focus when it opens.
    ///
    /// False for a satellite that is a *light* rather than a surface to work in
    /// (MJXHRM-228): the wake indicator appears while the user is typing in
    /// another application, and a window that steals focus to say "I heard you"
    /// has interrupted the very thing it was supposed to leave alone.
    focusable: bool,
    /// Whether every click passes straight through to whatever is behind.
    ///
    /// Load-bearing rather than polish for a layer-shell satellite: that backend
    /// anchors all four edges, so the surface is the SIZE OF THE OUTPUT
    /// (`surface/layer_shell.rs`). Without click-through such a window swallows
    /// every click on the desktop — which is why [`build_satellite`] refuses to
    /// show a surface asking for it that did not get it, rather than degrading.
    click_through: bool,
}

/// The pinned half of a [`crate::surface::SurfaceRequest`].
#[cfg(desktop)]
struct FloatingSpec {
    namespace: &'static str,
    layer: crate::surface::SurfaceLayer,
    keyboard_focus: crate::surface::KeyboardFocus,
    /// `[left, right, top, bottom]`, logical pixels — how a layer surface is
    /// positioned, since it is never moved.
    margins: [i32; 4],
}

/// How far below the top of the screen the HUD's card sits on a layer surface.
/// The card itself is centred inside the output-sized surface by CSS, so this
/// margin is the whole of its vertical placement.
#[cfg(desktop)]
const HUD_TOP_MARGIN: i32 = 96;

/// Every satellite the app has. A surface not in here cannot be opened, and
/// therefore cannot be attached.
#[cfg(desktop)]
const SATELLITES: &[SatelliteSpec] = &[
    // The HUD (MJXHRM-213). Exclusive keyboard focus is the whole point: it is
    // typed into from inside another application, which keeps its own focus.
    SatelliteSpec {
        surface: "hud",
        width: 560.0,
        height: 260.0,
        transparent: true,
        top_margin: Some(HUD_TOP_MARGIN),
        floating: Some(FloatingSpec {
            namespace: "hermes:hud",
            layer: crate::surface::SurfaceLayer::Overlay,
            keyboard_focus: crate::surface::KeyboardFocus::Exclusive,
            margins: [0, 0, HUD_TOP_MARGIN, 0],
        }),
        focusable: true,
        click_through: false,
    },
    // Quick Entry (MJXHRM-384). Deliberately NOT a layer surface: it wants the
    // keyboard outright for one sentence and then to be gone, which an ordinary
    // focused always-on-top window is, on every platform.
    SatelliteSpec {
        surface: "quick",
        width: 640.0,
        height: 168.0,
        transparent: true,
        // Centred on the active monitor, which is where a window manager left
        // to itself would put it on a single screen — the difference this makes
        // is *which* screen (MJXHRM-417).
        top_margin: None,
        floating: None,
        focusable: true,
        click_through: false,
    },
    // The wake indicator (MJXHRM-228) — "the app heard you", drawn where the
    // user is looking rather than inside a window they may not be in. Desktop's
    // is an Electron panel pinned to the top of the internal display and is
    // macOS-only (`electron/wake-indicator-window.ts` returns early otherwise);
    // this is the same light on the surface layer, so it exists wherever the
    // layer answers for it and says why where it does not.
    //
    // Takes no input and no focus at all: it is a light. The state it shows is
    // decided once, in `store/wake-indicator.ts`, and pushed to this window over
    // the event bus — this end never re-derives it.
    SatelliteSpec {
        surface: "wake",
        // Desktop's 176×52. Only the size the light is drawn in on a plain
        // toplevel; a layer surface is output-sized and the CSS centres it.
        width: WAKE_INDICATOR_WIDTH,
        height: WAKE_INDICATOR_HEIGHT,
        transparent: true,
        // Top of the screen. `place_on_active_monitor` works in the WORK AREA,
        // so on macOS this sits directly under the menu bar rather than in the
        // notch cutout — a floating-level window cannot draw over the menu bar
        // anyway, so that is the honest position rather than a compromise.
        top_margin: Some(0),
        floating: Some(FloatingSpec {
            namespace: "hermes:wake-indicator",
            // Above a full-screen application: the point of a hands-free cue is
            // that it reaches you while you are somewhere else.
            layer: crate::surface::SurfaceLayer::Overlay,
            keyboard_focus: crate::surface::KeyboardFocus::None,
            margins: [0, 0, 0, 0],
        }),
        focusable: false,
        click_through: true,
    },
];

/// The wake indicator's window size — desktop's 176×52, shared with the
/// frontend through the same constants so the light and the window it is drawn
/// in cannot drift apart.
#[cfg(desktop)]
const WAKE_INDICATOR_WIDTH: f64 = 176.0;
#[cfg(desktop)]
const WAKE_INDICATOR_HEIGHT: f64 = 52.0;

#[cfg(desktop)]
fn satellite_spec(surface: &str) -> Option<&'static SatelliteSpec> {
    SATELLITES.iter().find(|spec| spec.surface == surface)
}

/// What the caller gets back: the window's label, and what the platform granted
/// the surface (absent for a satellite that asked for nothing, or one that was
/// already up).
#[cfg(desktop)]
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SatelliteWindow {
    pub label: String,
    pub grant: Option<crate::surface::SurfaceGrant>,
}

/// The route a satellite opens on, placed verbatim after the HashRouter `#`.
/// Accepts only an app-internal path, exactly as [`activity_route`] does for the
/// mobile screen activity: this is the one caller-supplied part of a satellite's
/// URL, so it may not leave the app's own document.
#[cfg(desktop)]
fn satellite_route(route: Option<&str>) -> String {
    match route {
        Some(r)
            if r.starts_with('/')
                // `//host` is a path the app's router can never match, and it is
                // the shape an off-origin URL is written in. It is inert after a
                // `#`, but a route that cannot be a route has no business here.
                && !r.starts_with("//")
                && !r.contains('#')
                && !r.contains('?')
                && !r.chars().any(char::is_whitespace) =>
        {
            format!("#{r}")
        }
        _ => String::new(),
    }
}

/// Open (or re-focus) a satellite.
///
/// `surface` names one of [`SATELLITES`]; anything else is refused. The caller
/// may not itself be a satellite — the frontend's `canOpenSatelliteWindow()`
/// says the same thing, and a HUD living over other applications is the app's
/// most exposed webview, so the rule is enforced where it cannot be edited out
/// of a bundle.
///
/// A floating satellite is built HIDDEN, attached, and only then shown. That
/// ordering is a hard requirement: a `wlr-layer-shell` surface has to be
/// configured before its GtkWindow is realized, and showing it first spends the
/// only chance. It is also why showing happens here — the webview is not granted
/// `core:window:allow-show` and must not be, since that command takes the label
/// of any window as an argument.
#[cfg(desktop)]
#[tauri::command]
pub async fn open_satellite_window(
    app: tauri::AppHandle,
    webview: tauri::WebviewWindow,
    surface: String,
    route: Option<String>,
) -> Result<SatelliteWindow, String> {
    let caller = webview.label().to_string();
    if is_satellite_window_label(&caller) {
        return Err(format!(
            "refusing to open a satellite from {caller}: a satellite may not summon another"
        ));
    }

    let spec = satellite_spec(&surface).ok_or_else(|| format!("unknown surface {surface}"))?;
    let label = format!("sat-{}", spec.surface);
    let url = format!(
        "index.html?win={}{}",
        spec.surface,
        satellite_route(route.as_deref())
    );

    // Which output the user is on, before anything touches the main thread: on
    // Hyprland this is a blocking round trip over a Unix socket, and the main
    // thread is where the window is about to be built (MJXHRM-417).
    let output = crate::surface::active_output().await;

    let (tx, rx) = oneshot::channel::<Result<SatelliteWindow, String>>();
    let app_main = app.clone();
    let label_main = label.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(build_satellite(
            &app_main,
            &caller,
            &label_main,
            spec,
            url,
            output.as_ref(),
        ));
    })
    .map_err(|e| format!("failed to schedule window: {e}"))?;

    rx.await.map_err(|_| "failed to open window".to_string())?
}

/// Main-thread half of [`open_satellite_window`]: build, attach, show. Every
/// gtk call below needs this thread, and the attach must happen between the
/// build and the show.
#[cfg(desktop)]
fn build_satellite(
    app: &tauri::AppHandle,
    caller: &str,
    label: &str,
    spec: &SatelliteSpec,
    url: String,
    output: Option<&crate::surface::placement::FocusedOutput>,
) -> Result<SatelliteWindow, String> {
    if let Some(existing) = app.get_webview_window(label) {
        // Already up: summoning it again brings it forward. The grant it was
        // attached with is the one the frontend already wrote down.
        let _ = existing.unminimize();
        let _ = existing.show();

        if spec.focusable {
            let _ = existing.set_focus();
        }

        return Ok(SatelliteWindow {
            label: label.to_string(),
            grant: None,
        });
    }

    #[allow(unused_mut)]
    let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
        .title("Hermes (MJX)")
        .inner_size(spec.width, spec.height)
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        // Every satellite is born hidden and shown at the end. A floating one
        // must be: a layer surface has to be configured before its GtkWindow is
        // realized. One with no role is too, so that it is moved onto the right
        // monitor (MJXHRM-417) before it is ever painted, rather than appearing
        // on one screen and jumping to another.
        .visible(false)
        .focused(spec.focusable);

    // A transient surface does not belong in the window list.
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    {
        builder = builder.skip_taskbar(true);
    }

    // `transparent` only exists on macOS behind `macos-private-api`, which this
    // build does not take — so there, the card loses its rounded corners rather
    // than the window failing to open.
    #[cfg(not(target_os = "macos"))]
    {
        builder = builder.transparent(spec.transparent);
    }

    let window = builder
        .build()
        .map_err(|e| format!("could not open window: {e}"))?;

    // Before anything is shown. A satellite that asked to be click-through and
    // is not would, on the layer-shell backend, be an OUTPUT-SIZED window
    // swallowing every click on the desktop — so this is a hard failure that
    // takes the window with it, not a degradation to report.
    if spec.click_through {
        if let Err(e) = window.set_ignore_cursor_events(true) {
            let _ = window.close();

            return Err(format!(
                "refusing to show {label}: it must pass clicks through and this platform would not \
                 let it ({e})"
            ));
        }
    }

    let Some(floating) = &spec.floating else {
        // Not a floating surface, but still a window that should open where the
        // user is looking. Placement is refused outright on Wayland — see
        // `surface::place_on_active_monitor` — so this is a no-op there rather
        // than a move that silently does nothing.
        let _ = crate::surface::place_on_active_monitor(app, &window, spec.top_margin);
        let _ = window.show();

        if spec.focusable {
            let _ = window.set_focus();
        }

        return Ok(SatelliteWindow {
            label: label.to_string(),
            grant: None,
        });
    };

    let request = crate::surface::SurfaceRequest {
        namespace: floating.namespace.to_string(),
        layer: floating.layer,
        keyboard_focus: floating.keyboard_focus,
        margins: floating.margins,
    };

    // A surface that could not be attached is still a window: an ordinary
    // always-on-top HUD is worse than a layer-shell one, and no HUD is worse
    // than that. The absent grant is what tells the frontend to lay itself out
    // as a plain window.
    let grant = crate::surface::attach_floating_surface(app, caller, label, &request, output)
        .map_err(|e| log::warn!("could not attach a floating surface to {label}: {e}"))
        .ok();

    // "It opened on the wrong screen" is a report with no visible cause, so the
    // cause goes in the log next to the window it is about (MJXHRM-417). The
    // grant carries the same lines to the frontend.
    if let Some(grant) = &grant {
        match &grant.monitor {
            Some(monitor) => log::info!("{label} placed on {monitor}"),
            None => log::info!(
                "{label} was not placed on a chosen monitor: {}",
                grant.degraded.join(" ")
            ),
        }
    }

    let _ = window.show();

    if spec.focusable {
        let _ = window.set_focus();
    }

    Ok(SatelliteWindow {
        label: label.to_string(),
        grant,
    })
}

/// Mobile stub. Satellites need a real second window; the frontend gates the
/// affordance off there, and this keeps the command name registered so a stray
/// call gets a clear refusal rather than "unknown command".
#[cfg(mobile)]
#[tauri::command]
pub async fn open_satellite_window(_surface: String, _route: Option<String>) -> Result<(), String> {
    Err("unsupported_platform".to_string())
}

/// Build a frameless window for `url` under `label`, or focus the existing one
/// (one window per target). The gtk/WKWebView calls must run on the main thread;
/// a oneshot carries the build result back so a failure surfaces to the caller.
/// `decorations(false)` / `unminimize()` are desktop-only concepts (the frontend
/// draws its own titlebar); on iOS the builder just maps onto a UIScene.
#[cfg(any(desktop, target_os = "ios"))]
async fn open_or_focus(app: tauri::AppHandle, label: String, url: String) -> Result<(), String> {
    let (tx, rx) = oneshot::channel::<Result<(), String>>();
    // Clone for the closure — `app` itself is borrowed by `run_on_main_thread`, so
    // the closure can't also own it (mirrors `oauth.rs`).
    let app_main = app.clone();
    app.run_on_main_thread(move || {
        if let Some(existing) = app_main.get_webview_window(&label) {
            #[cfg(desktop)]
            let _ = existing.unminimize();
            let _ = existing.show();
            let _ = existing.set_focus();
            let _ = tx.send(Ok(()));
            return;
        }
        #[allow(unused_mut)]
        let mut builder = WebviewWindowBuilder::new(&app_main, &label, WebviewUrl::App(url.into()))
            .title("Hermes (MJX)")
            .inner_size(WINDOW_WIDTH, WINDOW_HEIGHT)
            .min_inner_size(WINDOW_MIN_WIDTH, WINDOW_MIN_HEIGHT);
        #[cfg(desktop)]
        {
            builder = builder.decorations(false);
        }
        let build = builder.build();
        let _ = tx.send(
            build
                .map(|_| ())
                .map_err(|e| format!("could not open window: {e}")),
        );
    })
    .map_err(|e| format!("failed to schedule window: {e}"))?;
    rx.await.map_err(|_| "failed to open window".to_string())?
}

/// Map an id to a Tauri window label under `prefix`. Labels allow only
/// `[A-Za-z0-9-/:_]`; anything else collapses to `-` (stored ids are uuid-like
/// and tile ids are authored constants, so collisions are not a practical
/// concern).
#[cfg(any(desktop, target_os = "ios"))]
fn slug_label(prefix: &str, id: &str) -> String {
    let slug: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    format!("{prefix}-{slug}")
}

/// Reject ids that would corrupt the URL's query/hash split when placed verbatim
/// (`routeSessionId` also rejects `/`).
#[cfg(any(desktop, target_os = "ios"))]
fn url_safe(id: &str) -> bool {
    !id.is_empty()
        && !id.contains(['#', '?', '&', '/', '%'])
        && !id.chars().any(|c| c.is_whitespace())
}

/// Open ONE TILE in its own frameless window / scene — the `placement: 'detached'`
/// transport (MJXHRM-173).
///
/// `?win=tile&tile=<id>` puts the frontend into single-tile mode; the optional
/// `session_id` rides in the HashRouter route (`#/<id>`) for a chat tile, whose
/// host resumes that session. `watch=1` marks a spectator window for a running
/// subagent.
///
/// One window per tile: the label is derived from the tile id, so a second detach
/// of the same tile focuses the window that already exists. Returns that label —
/// it is what `TILE_WINDOW_CLOSED_EVENT` reports, and the caller needs the pair to
/// know which tile to reattach.
#[cfg(any(desktop, target_os = "ios"))]
#[tauri::command]
pub async fn open_tile_window(
    app: tauri::AppHandle,
    tile_id: String,
    session_id: Option<String>,
    watch: Option<bool>,
) -> Result<String, String> {
    let tile = tile_id.trim();
    if !url_safe(tile) {
        return Err("unsupported tile id".to_string());
    }
    let session = session_id.unwrap_or_default();
    let session = session.trim();
    if !session.is_empty() && !url_safe(session) {
        return Err("unsupported session id".to_string());
    }
    let watch_frag = if watch.unwrap_or(false) {
        "&watch=1"
    } else {
        ""
    };
    let route = if session.is_empty() {
        String::new()
    } else {
        format!("#/{session}")
    };
    let url = format!("index.html?win=tile&tile={tile}{watch_frag}{route}");
    let label = slug_label(TILE_LABEL_PREFIX, tile);
    open_or_focus(app, label.clone(), url).await?;
    Ok(label)
}

/// Open a single chat session in its own frameless window / scene (desktop pop-out,
/// iOS scene). Kept as its own command because the pop-out is reachable from three
/// call sites that know a SESSION and not a tile; it delegates to the tile window
/// so both paths produce the same root.
///
/// Returns the window's LABEL, exactly as [`open_tile_window`] does. The frontend
/// needs it: this window resumes the session and therefore takes the gateway's
/// binding for it, and the close event that hands the stream back reports a label
/// (MJXHRM-371). Rebuilding the slug on that side is the duplication
/// [`slug_label`] exists to prevent.
#[cfg(any(desktop, target_os = "ios"))]
#[tauri::command]
pub async fn open_session_window(
    app: tauri::AppHandle,
    session_id: String,
    watch: Option<bool>,
) -> Result<String, String> {
    let id = session_id.trim();
    if !url_safe(id) {
        return Err("unsupported session id".to_string());
    }
    open_tile_window(
        app,
        format!("{SESSION_TILE_PREFIX}{id}"),
        Some(id.to_string()),
        watch,
    )
    .await
}

/// Open a full app instance in a new window / scene (desktop ⌘⇧N peer, iOS scene).
/// No `?win` flag — it renders the complete app against the shared backend.
/// Instances share `localStorage` with `main`, so layout persistence is
/// last-writer-wins (same as desktop's multi-instance behaviour).
#[cfg(any(desktop, target_os = "ios"))]
#[tauri::command]
pub async fn open_instance_window(app: tauri::AppHandle) -> Result<(), String> {
    let n = INSTANCE_SEQ.fetch_add(1, Ordering::Relaxed);
    open_or_focus(app, format!("instance-{n}"), "index.html".to_string()).await
}

// Android: session/instance pop-outs are not wired yet (needs Activity scaffolding,
// MJX-141). The frontend gates the affordance off on Android; these stubs keep the
// command names registered so a stray call returns a clear error.
#[cfg(target_os = "android")]
#[tauri::command]
pub async fn open_session_window(
    _app: tauri::AppHandle,
    _session_id: String,
    _watch: Option<bool>,
) -> Result<String, String> {
    Err("unsupported_platform".to_string())
}

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn open_instance_window(_app: tauri::AppHandle) -> Result<(), String> {
    Err("unsupported_platform".to_string())
}

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn open_tile_window(
    _app: tauri::AppHandle,
    _tile_id: String,
    _session_id: Option<String>,
    _watch: Option<bool>,
) -> Result<String, String> {
    Err("unsupported_platform".to_string())
}

// Activity screens are a mobile concept. On desktop, Settings and the Command
// Center render as in-app overlays and the frontend never invokes these; the stubs
// exist only so the command names register uniformly across both builds.
#[cfg(desktop)]
#[tauri::command]
pub async fn open_screen_window(
    _app: tauri::AppHandle,
    _route: Option<String>,
) -> Result<(), String> {
    Err("unsupported_platform".to_string())
}

// --------------------------------------------------------------------------
// Really closing a window (MJXHRM-436).
//
// `close_this_window` is not a nicety. `core:window:allow-destroy` is absent
// from `capabilities/default.json` (and from `core:window:default`, which grants
// only read-only queries), while Tauri's core calls `prevent_close()` for any
// window that has a JS `tauri://close-requested` listener and the JS wrapper
// then falls through to `destroy()`. So once `installWindowCloseGuard` arms its
// listener, the ONLY way that window can actually go away is a Rust-side
// `destroy` — a webview `close()` re-enters `CloseRequested` and a webview
// `destroy()` is refused by the ACL.
//
// A command rather than a grant, for the MJXHRM-382 reason the rest of this file
// exists: it acts on the window that CALLED it, so no label crosses the IPC
// boundary.
// --------------------------------------------------------------------------

/// Destroy THIS window for real.
///
/// The counterpart to the close guard: the guard always calls `preventDefault`,
/// because the JS wrapper's fallback is a `destroy()` the ACL does not grant, so
/// the window's own close has to come back through here. `destroy` rather than
/// `close` — `close` re-emits `CloseRequested`, which the guard would intercept
/// again, forever.
#[cfg(desktop)]
#[tauri::command]
pub fn close_this_window(window: tauri::WebviewWindow) -> Result<(), String> {
    window.destroy().map_err(|e| e.to_string())
}

// Mobile: the store gates on `IS_DESKTOP` before this, and a phone has one
// surface anyway. Registered so a stray call is a clear refusal (the
// `open_satellite_window` idiom above).
#[cfg(mobile)]
#[tauri::command]
pub async fn close_this_window() -> Result<(), String> {
    Err("unsupported_platform".to_string())
}

// --------------------------------------------------------------------------
// Mobile screen activity (MJX-141 Android / MJX-176 iOS): the windowable surfaces
// (Settings / Command Center / Profiles) share ONE native container, opened at a
// route. `WebviewWindowBuilder::build()` on Android launches the registered
// `ScreenActivity` (matched by `activity_name`); on iOS it maps onto a UIScene.
// Built on the main thread (WebView requirement), mirroring the desktop path and
// `oauth.rs`.
// --------------------------------------------------------------------------

// The `route` is placed verbatim after the HashRouter `#`. Accept only an
// app-internal path (`/settings…`, `/command-center?section=…`); anything that
// could corrupt the URL split falls back to the screen's default route.
#[cfg(mobile)]
fn activity_route(route: Option<&str>, default: &str) -> String {
    match route {
        Some(r)
            if r.starts_with('/') && !r.contains('#') && !r.chars().any(char::is_whitespace) =>
        {
            r.to_string()
        }
        _ => default.to_string(),
    }
}

// Open (or focus, if already open) the activity WebView for `label` at `url`.
// `activity` is the Kotlin `TauriActivity` subclass to host it on Android —
// `activity_name()` is how Tauri binds a window label to an Android Activity class
// (the class must be registered in `AndroidManifest.xml`). On iOS the arg is
// discarded: the built window becomes its own UIScene, no class binding needed.
#[cfg(mobile)]
async fn open_activity(
    app: tauri::AppHandle,
    label: String,
    url: String,
    activity: &'static str,
) -> Result<(), String> {
    let (tx, rx) = oneshot::channel::<Result<(), String>>();
    let app_main = app.clone();
    app.run_on_main_thread(move || {
        // Already open: launching again brings the existing activity/scene forward,
        // so there is nothing more to do here.
        if app_main.get_webview_window(&label).is_some() {
            let _ = tx.send(Ok(()));
            return;
        }
        let builder = WebviewWindowBuilder::new(&app_main, &label, WebviewUrl::App(url.into()));
        #[cfg(target_os = "android")]
        let builder = builder.activity_name(activity.to_string());
        #[cfg(not(target_os = "android"))]
        let _ = activity;
        let build = builder.build();
        let _ = tx.send(
            build
                .map(|_| ())
                .map_err(|e| format!("could not open window: {e}")),
        );
    })
    .map_err(|e| format!("failed to schedule window: {e}"))?;
    rx.await.map_err(|_| "failed to open window".to_string())?
}

// One native screen activity / scene hosts every windowable surface (Settings /
// Command Center / Profiles). The surface is chosen by the frontend from `route`
// (`?win=activity#<route>`) and can change in place — see
// `activitySurfaceForPath` — so no per-surface class or command is needed.
#[cfg(mobile)]
#[tauri::command]
pub async fn open_screen_window(
    app: tauri::AppHandle,
    route: Option<String>,
) -> Result<(), String> {
    let route = activity_route(route.as_deref(), "/settings");
    let url = format!("index.html?win=activity#{route}");
    open_activity(app, "screen".to_string(), url, "ScreenActivity").await
}

/// Fill a scene that iOS requested on its own (not by an app-built window) with a
/// fresh app instance. Emitted from `RunEvent::SceneRequested` (see `lib.rs`) for
/// state restoration, the iPad app-switcher "+", Handoff, etc. When such a scene
/// connects, tao leaves it window-less; the next `WebviewWindow` we build attaches
/// to that waiting scene (tao's `unitialized_scene` path) rather than requesting
/// another — so a plain `instance-{n}` build is all that's needed, and the scene
/// never stays blank. Fire-and-forget: the RunEvent closure is sync, so we spawn
/// the async build and log any failure.
#[cfg(target_os = "ios")]
pub fn fill_requested_scene(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let n = INSTANCE_SEQ.fetch_add(1, Ordering::Relaxed);
        if let Err(e) = open_or_focus(app, format!("instance-{n}"), "index.html".to_string()).await
        {
            log::error!("failed to fill system-requested scene: {e}");
        }
    });
}

#[cfg(all(test, desktop))]
mod tests {
    use super::*;
    use crate::surface::{KeyboardFocus, SurfaceLayer};

    /// The registry IS the boundary (MJXHRM-382). A surface the webview names
    /// that is not in here gets no window, and therefore no chance at a
    /// layer-shell role — which is what stops a caller minting `sat-anything`
    /// of its own and being handed one.
    #[test]
    fn only_registered_surfaces_can_be_opened() {
        assert!(satellite_spec("hud").is_some());
        assert!(satellite_spec("quick").is_some());
        assert!(satellite_spec("wake").is_some());

        for surface in ["evil", "", "HUD", "hud ", "hud/../main", "sat-hud", "main"] {
            assert!(
                satellite_spec(surface).is_none(),
                "{surface} must not resolve to a satellite"
            );
        }
    }

    /// Every privilege the ticket is about — the compositor namespace, the
    /// layer, and exclusive keyboard focus — is a constant here rather than a
    /// value from the caller. If this ever reads from a request again, the
    /// ownership check on the label is decorative.
    #[test]
    fn the_huds_layer_shell_role_is_pinned_not_requested() {
        let floating = satellite_spec("hud")
            .expect("the hud is registered")
            .floating
            .as_ref()
            .expect("the hud is a floating surface");

        assert_eq!(floating.namespace, "hermes:hud");
        assert_eq!(floating.layer, SurfaceLayer::Overlay);
        assert_eq!(floating.keyboard_focus, KeyboardFocus::Exclusive);
        assert_eq!(floating.margins, [0, 0, HUD_TOP_MARGIN, 0]);
    }

    /// The wake indicator is a LIGHT, and the two properties that make it one
    /// are the two whose absence is catastrophic rather than cosmetic
    /// (MJXHRM-228).
    ///
    /// It is a layer-shell surface asking for the overlay layer, which anchors
    /// all four edges — so it is the size of the whole output. Taking clicks
    /// would mean swallowing every click on the desktop, and taking focus would
    /// mean stealing it from whatever the user was typing in at the exact moment
    /// they spoke to Hermes instead. `build_satellite` refuses to show a
    /// click-through satellite it could not make click-through, rather than
    /// degrading.
    #[test]
    fn the_wake_light_takes_no_clicks_and_no_focus() {
        let spec = satellite_spec("wake").expect("the wake indicator is registered");

        assert!(
            spec.click_through,
            "an output-sized light must not take clicks"
        );
        assert!(!spec.focusable, "a light must never take focus");

        let floating = spec
            .floating
            .as_ref()
            .expect("the wake light is a floating surface");

        assert_eq!(floating.namespace, "hermes:wake-indicator");
        assert_eq!(floating.layer, SurfaceLayer::Overlay);
        assert_eq!(floating.keyboard_focus, KeyboardFocus::None);
        // Flush with the top edge: this is the notch position.
        assert_eq!(floating.margins, [0, 0, 0, 0]);
        assert_eq!(spec.top_margin, Some(0));
    }

    /// The HUD and Quick Entry are surfaces to work IN, so they focus and take
    /// input; only the light does not. Asserted over the whole registry so a new
    /// satellite has to make the choice deliberately.
    #[test]
    fn only_the_wake_light_is_click_through() {
        for spec in SATELLITES {
            assert_eq!(
                spec.click_through,
                spec.surface == "wake",
                "{} click_through",
                spec.surface
            );
            assert_eq!(
                spec.focusable,
                spec.surface != "wake",
                "{} focusable",
                spec.surface
            );
        }
    }

    /// A floating satellite is born hidden, because a wlr-layer-shell surface
    /// must be configured before its GtkWindow is realized; one with no layer
    /// role has nothing to configure and is born visible. `build_satellite`
    /// spells that as `spec.floating.is_none()`.
    #[test]
    fn quick_entry_is_not_a_layer_surface() {
        assert!(satellite_spec("quick")
            .expect("quick entry is registered")
            .floating
            .is_none());
    }

    /// The one caller-supplied part of a satellite's URL. It lands after the
    /// HashRouter `#`, so it may not carry its own `#`/`?` or whitespace, and
    /// anything that is not an app-internal path degrades to the root rather
    /// than to somewhere else.
    #[test]
    fn a_route_may_only_be_an_app_internal_path() {
        assert_eq!(satellite_route(Some("/abc123")), "#/abc123");
        assert_eq!(satellite_route(None), "");

        for route in [
            "abc123",
            "//evil.example",
            "/a#b",
            "/a?win=main",
            "/a b",
            "https://evil.example",
            "",
        ] {
            assert_eq!(
                satellite_route(Some(route)),
                "",
                "{route} must not reach the URL"
            );
        }
    }

    /// The label a satellite is built under. `sat-*` is the capability glob in
    /// `capabilities/default.json` and the namespace `surface/mod.rs` keys
    /// ownership on; a registry entry that fell outside it would open a window
    /// with no JS surface at all.
    #[test]
    fn every_registered_satellite_has_a_satellite_label() {
        for spec in SATELLITES {
            let label = format!("sat-{}", spec.surface);
            assert!(is_satellite_window_label(&label), "{label}");
        }
    }

    /// Which windows get [`APP_WINDOW_CLOSED_EVENT`], and therefore which closes
    /// make the survivors reclaim the OS hotkeys. Only a window that mounts the
    /// whole shell can have been holding them; a satellite answering here would
    /// have Quick Entry's own dismiss churn the machine-wide claim every time it
    /// is summoned and let go.
    #[test]
    fn only_full_app_windows_are_app_windows() {
        for label in ["main", "instance-2", "screen"] {
            assert!(is_app_window_label(label), "{label} is a full app window");
        }

        for spec in SATELLITES {
            let label = format!("sat-{}", spec.surface);
            assert!(!is_app_window_label(&label), "{label} is a satellite");
        }

        assert!(!is_app_window_label("tile-session-tile-abc"));
    }
}
