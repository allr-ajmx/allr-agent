//! Native multi-window support (MJX-104 desktop, MJX-142 iOS). Opens an internal
//! app route in a new `WebviewWindow`: a single chat session (frameless,
//! `?win=secondary`) or a full app instance. Windows are built on the main thread
//! (gtk/WKWebView requirement), mirroring `oauth.rs`. Rust-side creation bypasses
//! the ACL; the new window's own JS surface is scoped by the `session-*` /
//! `instance-*` capability globs in `capabilities/default.json`.
//!
//! iOS (MJX-142): with `UIApplicationSupportsMultipleScenes` set (see
//! `Info.ios.plist`), building a `WebviewWindow` maps onto a native `UIScene` —
//! tao requests a fresh scene (side-by-side on iPad) or attaches to the main scene
//! (replace, on single-scene iPhone) automatically, so no per-platform build code
//! is needed here. The runtime affordance is gated frontend-side on
//! `supportsMultipleWindows()` (`store/windows.ts`). `fill_requested_scene` handles
//! the inverse direction: scenes the *system* creates unprompted (state
//! restoration, iPad app-switcher "+", Handoff), which arrive via
//! `RunEvent::SceneRequested` in `lib.rs`.
//!
//! Android (MJX-141) still needs its own Activity scaffolding; the frontend keeps
//! the affordance gated off there.

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
/// `decorations`/`unminimize`/`inner_size` are desktop-only concepts: on iOS a
/// `WebviewWindow` is a UIScene (no chrome, no minimize, system-sized), so those
/// calls are gated to `desktop` and the builder just maps onto a scene there.
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
