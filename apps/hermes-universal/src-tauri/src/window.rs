//! Native multi-window support (MJX-104). Opens an internal app route in a new
//! `WebviewWindow`: a single chat session (frameless, `?win=secondary`) or a full
//! app instance. Windows are built on the main thread (gtk/WKWebView requirement),
//! mirroring `oauth.rs`. Rust-side creation bypasses the ACL; the new window's own
//! JS surface is scoped by the `session-*` / `instance-*` capability globs in
//! `capabilities/default.json`.
//!
//! Desktop-only for now — mobile (Android Activity / iOS UIScene) needs native
//! scaffolding tracked by MJX-141/142; the frontend gates the affordance off there.

use std::sync::atomic::{AtomicU32, Ordering};

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::oneshot;

const WINDOW_WIDTH: f64 = 480.0;
const WINDOW_HEIGHT: f64 = 900.0;
const WINDOW_MIN_WIDTH: f64 = 380.0;
const WINDOW_MIN_HEIGHT: f64 = 520.0;

// Monotonic so a closed-then-reopened instance never reuses a live label.
static INSTANCE_SEQ: AtomicU32 = AtomicU32::new(1);

/// Build a frameless window for `url` under `label`, or focus the existing one
/// (one window per target). The gtk/WKWebView calls must run on the main thread;
/// a oneshot carries the build result back so a failure surfaces to the caller.
/// `decorations(false)` is set explicitly — it is a per-window property and is NOT
/// inherited from the `main` window; the frontend draws its own titlebar.
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
#[tauri::command]
pub async fn open_instance_window(app: tauri::AppHandle) -> Result<(), String> {
    let n = INSTANCE_SEQ.fetch_add(1, Ordering::Relaxed);
    open_or_focus(app, format!("instance-{n}"), "index.html".to_string()).await
}
