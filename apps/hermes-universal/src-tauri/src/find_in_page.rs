//! Find-in-page (MJXHRM-49) — the browser's own incremental search over the
//! rendered page.
//!
//! Desktop drives Electron's `webContents.findInPage`. Tauri has no equivalent,
//! so this reaches through `WebviewWindow::with_webview` to the underlying
//! WebKitGTK `WebView` and drives its `WebKitFindController` directly — the same
//! engine-level machinery Electron's API is a wrapper around.
//!
//! **Why not a DOM overlay.** The obvious alternative is to walk the document in
//! JavaScript and wrap matches in `<mark>`s. It cannot work here: the chat
//! transcript, the file tree and the editor are all virtualized, so most of the
//! text the user is searching for is not in the DOM at the moment they search
//! for it. A DOM scan would confidently report "no matches" for text that is
//! plainly in the conversation. The engine's own find has the same blind spot
//! for unmounted rows, but it is at least the same search the platform performs
//! everywhere else, and it highlights and scrolls without us reimplementing
//! either.
//!
//! **This module is the LINUX path, not the whole feature.** `with_webview`
//! hands back a platform-specific handle: `WKWebView` on macOS (no public find
//! API at all — `NSTextFinder` does not apply to web content), `ICoreWebView2`
//! on Windows (its `Find` API landed only in recent runtime versions and needs a
//! direct `webview2-com` dependency), and a `WebView` object on Android (JNI).
//! Three separate native bindings, none of which can even be COMPILED on the
//! Linux host this is developed on — so every other target is served instead by
//! a portable `window.find` path in `src/lib/find-in-page-dom.ts`, and the
//! frontend picks between the two in `src/store/find-in-page.ts`. Native
//! bindings for the remaining engines stay open as MJXHRM-302; they would buy
//! highlight-all and exact counts, not the feature itself.
//!
//! **One ordinal caveat.** WebKitGTK reports the match COUNT (`found-text`,
//! `counted-matches`) but never which match is currently selected — there is no
//! equivalent of Electron's `activeMatchOrdinal`. The frontend therefore counts
//! the steps itself (`store/find-in-page.ts`); this module reports only what the
//! engine actually knows.

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
