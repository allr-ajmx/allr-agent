//! Find-in-page (MJXHRM-49) — the browser's own incremental search over the
//! rendered page.
//!
//! Desktop drives Electron's `webContents.findInPage`. Tauri has no equivalent,
//! so this reaches through `WebviewWindow::with_webview` to the underlying
//! WebKitGTK `WebView` and drives its `WebKitFindController` directly — the same
//! engine-level machinery Electron's API is a wrapper around.
//!
//! **Why not a DOM overlay.** Wrapping matches in `<mark>`s in JavaScript would
//! mean rewriting text nodes under a streaming transcript and putting them back
//! afterwards. The engine highlights and scrolls without any of that, and it
//! does not fight the render budget for ownership of the DOM.
//!
//! **This module is the LINUX path, not the whole feature.** `with_webview`
//! hands back a platform-specific handle, and each one wants a separate native
//! binding. Every other target is served instead by a portable `window.find`
//! path in `src/lib/find-in-page-dom.ts`, and the frontend picks between the two
//! in `src/store/find-in-page.ts`. The per-platform ledger, verified against
//! tauri 2.11 / wry 0.55 rather than inherited:
//!
//! - **macOS / iOS.** An earlier version of this comment said `WKWebView` "has
//!   no public find API at all". That is FALSE, and the correction matters:
//!   `findString:configuration:completionHandler:` has been public since macOS
//!   13 / iOS 16, `PlatformWebview::inner()` hands over the `WKWebView` pointer,
//!   and `objc2-web-kit` is already in the tree. It is skipped on merit, not for
//!   want of an API — `WKFindResult` exposes `matchFound` and nothing else: no
//!   count, no active index, no highlight-all. That is exactly what
//!   `window.find` already returns, so the binding would add an unsafe FFI hop
//!   and buy the user nothing. There is no gap here to close.
//! - **Windows.** `ICoreWebView2_25::Find` (WebView2 SDK 1.0.2957+) reports the
//!   match count AND the active index, and highlights all matches — strictly
//!   better than the portable path, and the only target where the count would
//!   stop being ours. `PlatformWebview::controller()` already hands back the
//!   controller, but reaching `_25` needs a direct `webview2-com` dependency
//!   pinned to tauri's, and a runtime recent enough to QueryInterface it.
//! - **Android.** `WebView.findAllAsync` + `setFindListener` gives the same
//!   count, active index and highlight-all, through
//!   `PlatformWebview::jni_handle().exec(..)`.
//!
//! The two that WOULD pay are also the two that cannot be verified here: `cargo
//! check` on this Linux host never compiles `#[cfg(target_os = "windows")]` or
//! `"android"` code, and CI does not build those targets either. Unsafe FFI that
//! has never been compiled is worse than the portable path it would replace, so
//! they stay open as MJXHRM-302 — as an accurate cost (highlight-all and an
//! engine-reported ordinal), not as a missing feature.
//!
//! **One ordinal caveat.** WebKitGTK reports the match COUNT (`found-text`,
//! `counted-matches`) but never which match is currently selected — there is no
//! equivalent of Electron's `activeMatchOrdinal`. The frontend therefore counts
//! the steps itself (`store/find-in-page.ts`); this module reports only what the
//! engine actually knows.
//!
//! **Scope is the calling window.** Both commands take an injected
//! `tauri::WebviewWindow`, which Tauri resolves to the webview that issued the
//! IPC call — so a detached tile window or the HUD searches ITSELF, and the
//! `found-text` handlers are keyed by `window.label()` so each window wires its
//! controller exactly once. The frontend mounts the bar per window to match
//! (`src/app.tsx`).

/// Emitted to the searching window with the match count for the current query.
pub const FOUND_IN_PAGE_EVENT: &str = "hermes://found-in-page";

#[cfg(target_os = "linux")]
mod linux {
    use std::collections::HashSet;
    use std::sync::{Mutex, OnceLock};

    use tauri::Emitter;

    use super::FOUND_IN_PAGE_EVENT;

    /// Windows whose find controller already has our signal handlers.
    ///
    /// The handlers are connected inside `with_webview`, which runs per call —
    /// without this, every ⌘F would stack another listener on the same
    /// controller and each result would be emitted N times.
    fn wired() -> &'static Mutex<HashSet<String>> {
        static WIRED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
        WIRED.get_or_init(|| Mutex::new(HashSet::new()))
    }

    /// Case-insensitive and wrapping — what every find bar does, and what the
    /// user means by "find" without being asked.
    fn find_options() -> u32 {
        (webkit2gtk::FindOptions::CASE_INSENSITIVE | webkit2gtk::FindOptions::WRAP_AROUND).bits()
    }

    /// No practical cap: the counter should say how many matches there ARE, and
    /// a truncated total is worse than a slightly slower count.
    const MAX_MATCHES: u32 = u32::MAX;

    /// What to do to the controller, once we are on the main thread with it.
    pub enum Op {
        Next,
        Previous,
        Search(String),
        Stop,
    }

    pub fn run(window: tauri::WebviewWindow, op: Op) -> Result<(), String> {
        let label = window.label().to_string();
        let emitter = window.clone();

        window
            .with_webview(move |platform_webview| {
                use webkit2gtk::{FindControllerExt, WebViewExt};

                let Some(controller) = platform_webview.inner().find_controller() else {
                    return;
                };

                // First search in this window: subscribe to the results. Both
                // signals matter — `failed-to-find-text` is the ONLY way a query
                // with no matches is reported, so without it the counter would
                // keep showing the previous query's total.
                let first_time = wired()
                    .lock()
                    .map(|mut set| set.insert(label.clone()))
                    .unwrap_or(false);

                if first_time {
                    let found = emitter.clone();
                    controller.connect_found_text(move |_, match_count| {
                        let _ = found.emit(FOUND_IN_PAGE_EVENT, match_count);
                    });

                    let counted = emitter.clone();
                    controller.connect_counted_matches(move |_, match_count| {
                        let _ = counted.emit(FOUND_IN_PAGE_EVENT, match_count);
                    });

                    let failed = emitter.clone();
                    controller.connect_failed_to_find_text(move |_| {
                        let _ = failed.emit(FOUND_IN_PAGE_EVENT, 0u32);
                    });
                }

                match &op {
                    Op::Next => controller.search_next(),
                    Op::Previous => controller.search_previous(),
                    Op::Search(query) => {
                        // `search` highlights and jumps; `count_matches` is what
                        // fills in the total, and it is a separate call because
                        // `found-text` reports the count of the CURRENT batch
                        // rather than the document total.
                        controller.search(query, find_options(), MAX_MATCHES);
                        controller.count_matches(query, find_options(), MAX_MATCHES);
                    }
                    // Ends the search AND drops the highlight/selection, which is
                    // what Escape has to mean — a bar that closes over a still-
                    // highlighted page has not really closed.
                    Op::Stop => controller.search_finish(),
                }
            })
            .map_err(|e| format!("find-in-page unavailable: {e}"))
    }
}

/// Search the window's rendered page.
///
/// `find_next` distinguishes "step to the next match of the query I already
/// gave you" from "search for this query from scratch" — the frontend passes
/// false on a fresh query and true on Enter / ⌘G, exactly as the Electron
/// bridge does.
#[cfg(target_os = "linux")]
#[tauri::command]
pub async fn find_in_page(
    window: tauri::WebviewWindow,
    query: String,
    forward: Option<bool>,
    find_next: Option<bool>,
) -> Result<(), String> {
    let op = if find_next.unwrap_or(false) {
        if forward.unwrap_or(true) {
            linux::Op::Next
        } else {
            linux::Op::Previous
        }
    } else {
        linux::Op::Search(query)
    };

    linux::run(window, op)
}

/// Stop searching and clear the highlight.
#[cfg(target_os = "linux")]
#[tauri::command]
pub async fn stop_find_in_page(window: tauri::WebviewWindow) -> Result<(), String> {
    linux::run(window, linux::Op::Stop)
}

// Every other platform needs its own engine binding (see the module docs) and
// takes the portable `window.find` path instead, so these commands are never
// invoked there — `store/find-in-page.ts` branches on `PLATFORM === 'linux'`
// BEFORE calling, and does not read this string. They stay registered anyway so
// a stray call returns a clear, catchable error rather than an "unknown
// command" that looks like a build fault.
#[cfg(not(target_os = "linux"))]
#[tauri::command]
pub async fn find_in_page(
    _window: tauri::WebviewWindow,
    _query: String,
    _forward: Option<bool>,
    _find_next: Option<bool>,
) -> Result<(), String> {
    Err("unsupported_platform".to_string())
}

#[cfg(not(target_os = "linux"))]
#[tauri::command]
pub async fn stop_find_in_page(_window: tauri::WebviewWindow) -> Result<(), String> {
    Err("unsupported_platform".to_string())
}
