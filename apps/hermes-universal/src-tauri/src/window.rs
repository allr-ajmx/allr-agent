//! Native multi-window support (MJX-104). Opens an internal app route in a new
//! `WebviewWindow`: a single chat session (frameless, `?win=secondary`) or a full
//! app instance. Windows are built on the main thread (gtk/WKWebView requirement),
//! mirroring `oauth.rs`. Rust-side creation bypasses the ACL; the new window's own
//! JS surface is scoped by the `session-*` / `instance-*` capability globs in
//! `capabilities/default.json`.
//!
//! Session/instance pop-outs are desktop-only for now — mobile (Android Activity /
//! iOS UIScene) needs native scaffolding tracked by MJX-141/142; the frontend
//! gates that affordance off there.
//!
//! Activity screens (MJX-141): on mobile, Settings and the Command Center open in
//! their OWN native Activity — `open_settings_window` / `open_system_window` build
//! a `WebviewWindow` (`?win=activity&screen=…`) which, under Android Activity
//! Embedding, launches the registered `TauriActivity` subclass. They are stubbed
//! on desktop (where those surfaces stay in-app overlays and the frontend never
//! invokes them).

// --------------------------------------------------------------------------
// Desktop: real multi-window support. `unminimize()` / `decorations()` and the
// rest of `WebviewWindow(Builder)`'s window-management surface only exist on the
// desktop runtime, so the whole implementation is gated to it.
// --------------------------------------------------------------------------
#[cfg(desktop)]
use std::sync::atomic::{AtomicU32, Ordering};

#[cfg(desktop)]
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
#[cfg(desktop)]
use tokio::sync::oneshot;

#[cfg(desktop)]
const WINDOW_WIDTH: f64 = 480.0;
#[cfg(desktop)]
const WINDOW_HEIGHT: f64 = 900.0;
#[cfg(desktop)]
const WINDOW_MIN_WIDTH: f64 = 380.0;
#[cfg(desktop)]
const WINDOW_MIN_HEIGHT: f64 = 520.0;

// Monotonic so a closed-then-reopened instance never reuses a live label.
#[cfg(desktop)]
static INSTANCE_SEQ: AtomicU32 = AtomicU32::new(1);

/// Build a frameless window for `url` under `label`, or focus the existing one
/// (one window per target). The gtk/WKWebView calls must run on the main thread;
/// a oneshot carries the build result back so a failure surfaces to the caller.
/// `decorations(false)` is set explicitly — it is a per-window property and is NOT
/// inherited from the `main` window; the frontend draws its own titlebar.
#[cfg(desktop)]
async fn open_or_focus(app: tauri::AppHandle, label: String, url: String) -> Result<(), String> {
    let (tx, rx) = oneshot::channel::<Result<(), String>>();
    // Clone for the closure — `app` itself is borrowed by `run_on_main_thread`, so
    // the closure can't also own it (mirrors `oauth.rs`).
    let app_main = app.clone();
    app.run_on_main_thread(move || {
        if let Some(existing) = app_main.get_webview_window(&label) {
            let _ = existing.unminimize();
            let _ = existing.show();
            let _ = existing.set_focus();
            let _ = tx.send(Ok(()));
            return;
        }
        let build = WebviewWindowBuilder::new(&app_main, &label, WebviewUrl::App(url.into()))
            .title("Hermes")
            .decorations(false)
            .inner_size(WINDOW_WIDTH, WINDOW_HEIGHT)
            .min_inner_size(WINDOW_MIN_WIDTH, WINDOW_MIN_HEIGHT)
            .build();
        let _ = tx.send(build.map(|_| ()).map_err(|e| format!("could not open window: {e}")));
    })
    .map_err(|e| format!("failed to schedule window: {e}"))?;
    rx.await.map_err(|_| "failed to open window".to_string())?
}

/// Map a session id to a Tauri window label. Labels allow only `[A-Za-z0-9-/:_]`;
/// anything else collapses to `-` (stored ids are uuid-like, so collisions are
/// not a practical concern).
#[cfg(desktop)]
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

/// Open a single chat session in its own frameless window (desktop pop-out). The
/// id rides in the HashRouter route (`#/<id>`); `?win=secondary` (read before the
/// hash) puts the frontend into single-chat mode. `watch=1` marks a spectator
/// window for a running subagent.
#[cfg(desktop)]
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

/// Open a full app instance in a new window (desktop ⌘⇧N peer). No `?win` flag —
/// it renders the complete app against the shared backend. Instances share
/// `localStorage` with `main`, so layout persistence is last-writer-wins (same as
/// desktop's multi-instance behaviour).
#[cfg(desktop)]
#[tauri::command]
pub async fn open_instance_window(app: tauri::AppHandle) -> Result<(), String> {
    let n = INSTANCE_SEQ.fetch_add(1, Ordering::Relaxed);
    open_or_focus(app, format!("instance-{n}"), "index.html".to_string()).await
}

// Activity screens are a mobile concept. On desktop, Settings and the Command
// Center render as in-app overlays and the frontend never invokes these (the JS
// gate is Android-only); the stubs exist only so the command names register
// uniformly across both builds.
#[cfg(desktop)]
#[tauri::command]
pub async fn open_settings_window(
    _app: tauri::AppHandle,
    _route: Option<String>,
) -> Result<(), String> {
    Err("unsupported_platform".to_string())
}

#[cfg(desktop)]
#[tauri::command]
pub async fn open_system_window(
    _app: tauri::AppHandle,
    _route: Option<String>,
) -> Result<(), String> {
    Err("unsupported_platform".to_string())
}

// --------------------------------------------------------------------------
// Mobile: no native multi-window (Android Activity / iOS UIScene scaffolding is
// tracked by MJX-141/142). The frontend already gates the pop-out affordance off
// on mobile; these stubs keep the command names registered so a stray call
// returns a clear error instead of a missing-command failure.
// --------------------------------------------------------------------------
#[cfg(mobile)]
#[tauri::command]
pub async fn open_session_window(
    _app: tauri::AppHandle,
    _session_id: String,
    _watch: Option<bool>,
) -> Result<(), String> {
    Err("unsupported_platform".to_string())
}

#[cfg(mobile)]
#[tauri::command]
pub async fn open_instance_window(_app: tauri::AppHandle) -> Result<(), String> {
    Err("unsupported_platform".to_string())
}

// --------------------------------------------------------------------------
// Mobile activity screens (MJX-141): Settings + Command Center each open in
// their own Activity. `WebviewWindowBuilder::build()` on mobile launches the
// registered `TauriActivity` subclass matched by label (`settings` /
// `command-center`); the window's JS surface is scoped by the matching capability
// globs in `capabilities/default.json`. Built on the main thread (WebView
// requirement), mirroring the desktop path and `oauth.rs`.
// --------------------------------------------------------------------------
#[cfg(mobile)]
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
#[cfg(mobile)]
use tokio::sync::oneshot;

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
// `activity` is the Kotlin `TauriActivity` subclass to host it — `activity_name()`
// is how Tauri binds a window label to an Android Activity class (the class must
// be registered in `AndroidManifest.xml`). The arg is unused off Android.
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
        // Already open: launching again brings the existing activity forward, so
        // there is nothing more to do here.
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

#[cfg(mobile)]
#[tauri::command]
pub async fn open_settings_window(
    app: tauri::AppHandle,
    route: Option<String>,
) -> Result<(), String> {
    let route = activity_route(route.as_deref(), "/settings");
    let url = format!("index.html?win=activity&screen=settings#{route}");
    open_activity(app, "settings".to_string(), url, "SettingsActivity").await
}

#[cfg(mobile)]
#[tauri::command]
pub async fn open_system_window(
    app: tauri::AppHandle,
    route: Option<String>,
) -> Result<(), String> {
    let route = activity_route(route.as_deref(), "/command-center");
    let url = format!("index.html?win=activity&screen=command-center#{route}");
    open_activity(app, "command-center".to_string(), url, "SystemActivity").await
}
