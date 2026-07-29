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
            .title("Hermes")
            .inner_size(WINDOW_WIDTH, WINDOW_HEIGHT)
            .min_inner_size(WINDOW_MIN_WIDTH, WINDOW_MIN_HEIGHT);
        #[cfg(desktop)]
        {
            builder = builder.decorations(false);
        }
        let build = builder.build();
        let _ = tx.send(build.map(|_| ()).map_err(|e| format!("could not open window: {e}")));
    })
    .map_err(|e| format!("failed to schedule window: {e}"))?;
    rx.await.map_err(|_| "failed to open window".to_string())?
}

/// Map a session id to a Tauri window label. Labels allow only `[A-Za-z0-9-/:_]`;
/// anything else collapses to `-` (stored ids are uuid-like, so collisions are
/// not a practical concern).
#[cfg(any(desktop, target_os = "ios"))]
fn session_label(session_id: &str) -> String {
    let slug: String = session_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    format!("session-{slug}")
}

/// Open a single chat session in its own frameless window / scene (desktop pop-out,
/// iOS scene). The id rides in the HashRouter route (`#/<id>`); `?win=secondary`
/// (read before the hash) puts the frontend into single-chat mode. `watch=1` marks
/// a spectator window for a running subagent.
#[cfg(any(desktop, target_os = "ios"))]
#[tauri::command]
pub async fn open_session_window(
    app: tauri::AppHandle,
    session_id: String,
    watch: Option<bool>,
) -> Result<(), String> {
    let id = session_id.trim();
    if id.is_empty() {
        return Err("invalid session id".to_string());
    }
    // The id is placed verbatim into the URL's query/hash. Reject characters that
    // would corrupt the split or the route (`routeSessionId` also rejects `/`).
    if id.contains(['#', '?', '/', '%']) || id.chars().any(|c| c.is_whitespace()) {
        return Err("unsupported session id".to_string());
    }
    let watch_frag = if watch.unwrap_or(false) { "&watch=1" } else { "" };
    let url = format!("index.html?win=secondary{watch_frag}#/{id}");
    open_or_focus(app, session_label(id), url).await
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
) -> Result<(), String> {
    Err("unsupported_platform".to_string())
}

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn open_instance_window(_app: tauri::AppHandle) -> Result<(), String> {
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
        let _ = tx.send(build.map(|_| ()).map_err(|e| format!("could not open window: {e}")));
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
