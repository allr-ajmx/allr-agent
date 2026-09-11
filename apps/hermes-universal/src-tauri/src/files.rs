//! `download_file` — save a gateway file to a path the user picked.
//!
//! The workspace lives on the GATEWAY, not on this device, so "download" is a
//! network fetch plus a local write, not a copy. Both halves have to happen in
//! Rust:
//!
//! * **Auth.** The gateway authenticates either by session token (loopback
//!   mode) or by cookie (gated/OAuth mode). Only `/api/files/download` accepts
//!   a `?token=` query param at all (`_QUERY_TOKEN_API_PATHS` in
//!   `hermes_cli/web_server.py`), and in gated mode there is no token minted to
//!   put there — the SPA authenticates with a `SameSite=Lax` cookie that a
//!   webview subresource never carries. Reusing `TransportState`'s client gets
//!   the cookie jar and the native bearer for free.
//!
//! * **CSP + webview downloads.** The route this replaces read the file as a
//!   `data:` URL and did `fetch(dataUrl)` in JS — which the app CSP
//!   (`connect-src 'self' ipc:`, no `data:`) blocks — then handed the blob to a
//!   synthetic `<a download>`, which a wry/WKWebView shell does not reliably
//!   honour on mobile. Neither problem exists once the bytes never enter the
//!   webview.
//!
//! It also lifts the ceiling: the old `/api/fs/read-data-url` route caps at
//! 16 MB (`_FS_DATA_URL_MAX_BYTES`), while `/api/files/download` has no size
//! ceiling at all now — the gateway used to 413 above `_MANAGED_FILE_MAX_BYTES`
//! and no longer does, because nothing on either side holds the file whole.
//!
//! **Nothing here is buffered.** The body is read one `chunk()` at a time into
//! `<dest>.part` and renamed into place at the end, so a 4 GB download costs one
//! chunk of memory rather than 4 GB. That is also what makes the two things
//! around it possible: a `{received, total}` progress event per ~100 ms (rule
//! 23's per-instance topic `hermes-download://{id}/progress` — the BYTES never
//! ride it, rule 24), and `cancel_download`, which flips an
//! `AtomicBool` the loop reads between chunks.
//!
//! `download_folder` is the same machinery pointed at
//! `/api/files/download-archive`, which streams a zip of a directory built on
//! the fly. That route is NEW, and MJXHRM-511 freezes the gateway — so a
//! backend that predates it must degrade rather than error, and telling "this
//! gateway has no such route" from "that folder is gone" is what
//! [`archive_404_code`] does.
//!
//! The gateway target is `media.rs`'s — same host, same auth, same endpoint,
//! kept current by the `media_set_target` push in `src/lib/media-stream.ts`.

use std::collections::HashMap;
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde::Serialize;
use tauri::{Emitter, State};

use crate::media::{MediaState, MediaTarget};
use crate::transport::{apply_gateway_bearer, TransportState};

/// Generous next to `media.rs`'s 20 s: that one bounds a 2 MiB range on a
/// latency-sensitive playback path, this one can legitimately be a multi-GB file
/// over a slow link. Still finite so a wedged gateway surfaces as an error
/// rather than a spinner that never resolves.
///
/// It bounds the WHOLE transfer, not one chunk — reqwest applies a request
/// timeout across the response body too — which is why it is measured in
/// minutes.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);

/// The scheme half of the per-instance progress topic (rule 23).
const DOWNLOAD_SCHEME: &str = "hermes-download";

/// Shortest gap between two progress events for one download.
///
/// reqwest hands back a chunk roughly per TCP read — 8-64 KiB — so a 4 GB file
/// is on the order of a hundred thousand of them. One event each would put a
/// hundred thousand JSON round trips on the IPC bridge and re-render the tray
/// on every one, to move a progress bar by 0.001%. At 100 ms the bar is still
/// smooth and the bridge carries ten events a second.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

/// Write buffer between the network and the disk. Chunk-sized writes would
/// otherwise mean one `write(2)` per TCP read.
const WRITE_BUFFER_BYTES: usize = 256 * 1024;

/// What a progress event carries. Never bytes (rule 24) — just the two numbers
/// a progress bar needs. `total` is `Option` because it is `Content-Length`, and
/// a streamed archive has none: the gateway is still building the zip when the
/// first byte leaves, so nobody knows how big it will be.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    received: u64,
    total: Option<u64>,
}

/// Which gateway route a transfer is reading from.
///
/// The two differ in exactly two places — the URL and what a 404 means — so
/// they share one function rather than one being a copy of the other with the
/// path swapped.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Route {
    File,
    Archive,
}

impl Route {
    fn path(self) -> &'static str {
        match self {
            Route::File => "/api/files/download",
            Route::Archive => "/api/files/download-archive",
        }
    }
}

/// The live transfers, so `cancel_download` has something to flip.
///
/// A `std::sync::Mutex`, deliberately: every access is a lock, a map operation
/// and a drop, with no `await` anywhere inside — the flag itself is what crosses
/// the awaits, and it is an atomic. A `tokio::sync::Mutex` here would buy
/// nothing and cost every caller a scheduler round trip (§6.1).
///
/// Managed state is per PROCESS, not per window, which is what lets a download
/// started in the HUD be cancelled from the main window's tray without either
/// side knowing where the other is.
#[derive(Default)]
pub struct DownloadState(Mutex<HashMap<String, Arc<AtomicBool>>>);

impl DownloadState {
    /// Claim `id` and hand back the flag its loop should watch.
    ///
    /// A second `download_file` with a live id replaces the entry, which also
    /// orphans the first one's flag — it is still reachable by the first loop,
    /// so that transfer keeps running and simply stops being cancellable by id.
    /// The frontend mints a fresh id per download, so this is a defence against
    /// a caller bug rather than a path anything takes.
    fn register(&self, id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));

        if let Ok(mut live) = self.0.lock() {
            live.insert(id.to_string(), Arc::clone(&flag));
        }

        flag
    }

    fn forget(&self, id: &str) {
        if let Ok(mut live) = self.0.lock() {
            live.remove(id);
        }
    }

    /// Ask a running transfer to stop. `false` means there was nothing to stop.
    fn cancel(&self, id: &str) -> bool {
        let Ok(live) = self.0.lock() else {
            return false;
        };

        match live.get(id) {
            Some(flag) => {
                flag.store(true, Ordering::SeqCst);
                true
            }
            None => false,
        }
    }
}

/// Deregisters the id however the command leaves — early `?`, cancel, or
/// success. Without it every failed download would leak a registry entry and
/// `cancel_download` would keep answering `true` for a transfer that ended
/// minutes ago.
struct Registration<'a> {
    state: &'a DownloadState,
    id: Option<String>,
}

impl Drop for Registration<'_> {
    fn drop(&mut self) {
        if let Some(id) = &self.id {
            self.state.forget(id);
        }
    }
}

/// Should a progress event go out now?
///
/// Split out as a pure function (rule 35) so the throttle is testable without a
/// network: the invariant a future edit could quietly undo is that the LAST
/// event always goes out regardless of timing — drop it and a finished download
/// sits at 97% forever.
fn should_emit(since_last: Duration, is_final: bool) -> bool {
    is_final || since_last >= PROGRESS_INTERVAL
}

/// Where the bytes land before the download is known to be complete.
///
/// A partial file under the real name is indistinguishable from a finished one
/// to everything that later opens it, so the transfer writes beside the
/// destination and renames at the end — the same shape as the gateway's own
/// `/api/files/upload-stream`.
fn part_path(dest: &str) -> String {
    format!("{dest}.part")
}

/// Tell "this gateway has no archive route" from "that folder is gone".
///
/// Both are a 404 and the client has to degrade differently: a missing route
/// hides the folder-download affordance for the rest of the session
/// (MJXHRM-511's backend freeze), a missing folder is an error about that one
/// folder. The gateway's SPA catch-all answers an unmatched `/api/*` path with
/// either `{"detail": "No such API endpoint: …"}` (frontend built) or
/// `{"error": "Frontend not built…"}` (it isn't); the archive route's own 404
/// always carries a plain FastAPI `detail`. Anything unparseable — an HTML 404
/// page from a reverse proxy in front of an old gateway — degrades to
/// `route_missing`, which is the direction that hides an affordance rather than
/// showing a broken one.
fn archive_404_code(body: &str) -> &'static str {
    match serde_json::from_str::<serde_json::Value>(body) {
        Ok(value) => match value.get("detail").and_then(|detail| detail.as_str()) {
            Some(detail) if !detail.contains("No such API endpoint") => "file_not_found",
            _ => "route_missing",
        },
        Err(_) => "route_missing",
    }
}

/// Save the gateway file at `path` to the local `dest`, returning the byte count.
///
/// Errors are short stable codes, not prose: the frontend maps them to
/// localized strings (an untranslated Rust sentence would be the only English
/// in an otherwise translated UI).
///
/// `id` is optional because watching a download is optional: with one, the
/// transfer reports progress on `hermes-download://{id}/progress` and can be
/// stopped by `cancel_download`; without one it is a plain write nobody can
/// watch or stop, which is all a caller with no UI to feed needs. Everything
/// that goes through `store/downloads.ts` mints one.
///
/// §6.2: the COMMAND name stays snake_case at the `invoke()` site, but the
/// arguments arrive camelCased — `path`, `dest` and `id` are already single
/// words, which is why this signature has no trap in it. `download_folder`'s
/// does not either, for the same reason.
#[tauri::command]
pub async fn download_file(
    app: tauri::AppHandle,
    state: State<'_, TransportState>,
    media: State<'_, MediaState>,
    downloads: State<'_, DownloadState>,
    path: String,
    dest: String,
    id: Option<String>,
) -> Result<u64, String> {
    stream_to_file(app, state, media, downloads, Route::File, path, dest, id).await
}

/// Save the gateway DIRECTORY at `path` to the local `dest` as a zip.
///
/// The gateway builds the archive as it sends it, so there is no
/// `Content-Length` and progress is byte-count-only — the UI shows an
/// indeterminate bar with a running total rather than a percentage.
///
/// Fails with `route_missing` against a gateway that predates the route, which
/// is the frontend's cue to hide the affordance rather than show an error
/// (MJXHRM-511).
#[tauri::command]
pub async fn download_folder(
    app: tauri::AppHandle,
    state: State<'_, TransportState>,
    media: State<'_, MediaState>,
    downloads: State<'_, DownloadState>,
    path: String,
    dest: String,
    id: Option<String>,
) -> Result<u64, String> {
    stream_to_file(app, state, media, downloads, Route::Archive, path, dest, id).await
}

/// Stop a running transfer. Returns whether one was actually found.
///
/// Rule 9: a `cancel` that always answers `Ok(())` cannot tell the tray "that
/// download had already finished" from "cancelled", and the tray needs to know
/// — the two leave a different row behind.
#[tauri::command]
pub fn cancel_download(downloads: State<'_, DownloadState>, id: String) -> Result<bool, String> {
    Ok(downloads.cancel(&id))
}

/// The whole transfer: auth ladder, streaming body, progress, cancel, rename.
#[allow(clippy::too_many_arguments)]
async fn stream_to_file(
    app: tauri::AppHandle,
    state: State<'_, TransportState>,
    media: State<'_, MediaState>,
    downloads: State<'_, DownloadState>,
    route: Route,
    path: String,
    dest: String,
    id: Option<String>,
) -> Result<u64, String> {
    // Claimed BEFORE the first await, so a cancel that arrives while the auth
    // ladder is still running is not silently dropped on the floor.
    let cancelled = match &id {
        Some(id) => downloads.register(id),
        None => Arc::new(AtomicBool::new(false)),
    };
    let _registration = Registration {
        state: downloads.inner(),
        id: id.clone(),
    };

    let Some(target) = media.target() else {
        return Err("no_gateway".into());
    };

    let url = format!(
        "{}{}?path={}",
        target.base_url.trim_end_matches('/'),
        route.path(),
        utf8_percent_encode(&path, NON_ALPHANUMERIC)
    );

    // The same auth ladder `transport::http_request` runs, and it has to be:
    // `target.headers` carries only the session token, which authenticates a
    // LOOPBACK gateway. A gated/OAuth gateway authenticates by bearer, and
    // without one every request here came back 401 — surfaced to the user as
    // "session expired" on a session that was perfectly alive.
    let auth_base = state.bearer_base_for_url(&url);
    let bearer = match &auth_base {
        Some(base) => crate::oauth::gateway_bearer(&app, state.inner(), base, false).await,
        None => None,
    };

    let mut response = send(&state, &url, &target, bearer.as_deref()).await?;

    // A bearer the gateway refuses is normally one rotated or revoked out from
    // under us; force a rotation and replay once. A 401 means the request was
    // rejected before it was acted on, so replaying is safe.
    //
    // Rotating to NOTHING counts as a change worth replaying: the gated
    // middleware short-circuits on a presented-but-invalid bearer and answers
    // 401 without ever reading the session cookies, so the bearer-less replay
    // is what lets a live cookie session finally be seen. Same reasoning as the
    // retry in `http_request`.
    if response.status() == reqwest::StatusCode::UNAUTHORIZED && bearer.is_some() {
        if let Some(base) = &auth_base {
            let rotated = crate::oauth::gateway_bearer(&app, state.inner(), base, true).await;

            if rotated.as_deref() != bearer.as_deref() {
                response = send(&state, &url, &target, rotated.as_deref()).await?;
            }
        }
    }

    let status = response.status().as_u16();

    if !(200..300).contains(&status) {
        // The archive route's 404 is ambiguous in a way the file route's is
        // not, and only here is it worth spending a body read to disambiguate.
        if route == Route::Archive && status == 404 {
            let body = response.text().await.unwrap_or_default();

            return Err(archive_404_code(&body).into());
        }

        return Err(download_error(status).into());
    }

    write_body(&app, response, &dest, id.as_deref(), &cancelled).await
}

/// Drain the response body to `<dest>.part`, then rename it into place.
async fn write_body(
    app: &tauri::AppHandle,
    mut response: reqwest::Response,
    dest: &str,
    id: Option<&str>,
    cancelled: &AtomicBool,
) -> Result<u64, String> {
    // Absent for the archive route, which is still being built when the headers
    // go out; present for a plain file. `Option` all the way to the UI rather
    // than a 0 that would render as "0 bytes total".
    let total = response.content_length();

    // The parent is whatever the save dialog or the downloads directory named,
    // so it normally exists; create it anyway rather than failing after the
    // request has already been made.
    if let Some(parent) = std::path::Path::new(dest).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|_| "write_failed")?;
        }
    }

    let part = part_path(dest);
    // A `.part` left by an earlier attempt is NOT resumed — see the module
    // docs. Truncating is what `File::create` already does; the explicit remove
    // is for the case where the leftover is a directory or is read-only.
    let _ = std::fs::remove_file(&part);

    let file = std::fs::File::create(&part).map_err(|_| "write_failed")?;
    let mut sink = std::io::BufWriter::with_capacity(WRITE_BUFFER_BYTES, file);

    let mut received: u64 = 0;
    let mut last_emit = Instant::now();

    // An immediate 0/total, so the tray can show the size and a real bar from
    // the first frame instead of "starting…" for however long the first chunk
    // takes on a slow link.
    emit_progress(app, id, received, total);

    loop {
        if cancelled.load(Ordering::SeqCst) {
            drop(sink);
            let _ = std::fs::remove_file(&part);

            return Err("download_cancelled".into());
        }

        let chunk = match response.chunk().await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(_) => {
                drop(sink);
                let _ = std::fs::remove_file(&part);

                return Err("gateway_unreachable".into());
            }
        };

        if sink.write_all(&chunk).is_err() {
            drop(sink);
            let _ = std::fs::remove_file(&part);

            return Err("write_failed".into());
        }

        received += chunk.len() as u64;

        if should_emit(last_emit.elapsed(), false) {
            last_emit = Instant::now();
            emit_progress(app, id, received, total);
        }
    }

    // Flushed and closed BEFORE the rename: a `BufWriter` dropped by the rename
    // path would write its tail after the file had already been moved.
    if sink.flush().is_err() {
        drop(sink);
        let _ = std::fs::remove_file(&part);

        return Err("write_failed".into());
    }

    drop(sink);

    if std::fs::rename(&part, dest).is_err() {
        let _ = std::fs::remove_file(&part);

        return Err("write_failed".into());
    }

    // The final event is unconditional (see `should_emit`): without it a
    // download whose last chunk landed inside the throttle window would sit at
    // whatever the second-to-last event said forever.
    emit_progress(app, id, received, total);

    Ok(received)
}

/// One progress event on this download's own topic (rule 23).
///
/// `app.emit` reaches EVERY window on purpose: the tray that shows this
/// download may not be in the window that started it, and the store rebroadcasts
/// only what peers cannot derive. A download with no id emits nothing — there is
/// no topic to emit on.
fn emit_progress(app: &tauri::AppHandle, id: Option<&str>, received: u64, total: Option<u64>) {
    let Some(id) = id else {
        return;
    };

    let _ = app.emit(
        &format!("{DOWNLOAD_SCHEME}://{id}/progress"),
        DownloadProgress { received, total },
    );
}

/// One GET, carrying every credential the gateway might want: the shared cookie
/// jar (on the client itself), the session-token headers, and the OAuth bearer.
async fn send(
    state: &TransportState,
    url: &str,
    target: &MediaTarget,
    bearer: Option<&str>,
) -> Result<reqwest::Response, String> {
    build_request(state.client(), url, target, bearer)
        .send()
        .await
        .map_err(|_| "gateway_unreachable".into())
}

/// Split out from [`send`] so the "every credential is actually ON the request"
/// invariant is testable without a network, a keyring or a `TransportState` —
/// `RequestBuilder::build` materializes the request without sending it. Missing
/// the bearer here is precisely the bug that made a gated gateway answer 401 and
/// the UI say "session expired".
fn build_request(
    client: &reqwest::Client,
    url: &str,
    target: &MediaTarget,
    bearer: Option<&str>,
) -> reqwest::RequestBuilder {
    let mut req = client.get(url).timeout(DOWNLOAD_TIMEOUT);

    for (name, value) in &target.headers {
        req = req.header(name, value);
    }

    apply_gateway_bearer(req, bearer)
}

/// Map an upstream status onto a code the frontend has a message for.
///
/// 404 (gone), 403 (outside a hosted gateway's managed root, or a path on its
/// sensitive denylist), 401 (the session really has lapsed — by this point the
/// bearer rotation above has already been tried). 413 stays mapped even though
/// the current gateway no longer caps this route: an OLDER gateway still
/// answers 413 above `_MANAGED_FILE_MAX_BYTES`, and MJXHRM-511's freeze means
/// this client meets both.
fn download_error(status: u16) -> &'static str {
    match status {
        404 => "file_not_found",
        403 => "file_forbidden",
        413 => "file_too_large",
        401 => "unauthorized",
        _ => "download_failed",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A `.part` sibling, not a temp directory: the rename that promotes it has
    /// to be on the same filesystem as the destination, or it stops being
    /// atomic and becomes a copy of the whole file.
    #[test]
    fn stages_the_download_beside_its_destination() {
        assert_eq!(
            part_path("/Users/me/Downloads/report.pdf"),
            "/Users/me/Downloads/report.pdf.part"
        );
        assert_eq!(
            std::path::Path::new(&part_path("/Users/me/Downloads/report.pdf")).parent(),
            std::path::Path::new("/Users/me/Downloads/report.pdf").parent()
        );
    }

    /// The invariant a throttle edit could quietly undo: the LAST event always
    /// goes out. Drop it and a finished download whose final chunk landed inside
    /// the throttle window sits at 97% for the rest of the session.
    #[test]
    fn always_emits_the_final_progress_however_recent_the_last_one() {
        assert!(should_emit(Duration::from_millis(0), true));
        assert!(should_emit(PROGRESS_INTERVAL, false));
        assert!(should_emit(PROGRESS_INTERVAL * 2, false));
        assert!(!should_emit(Duration::from_millis(0), false));
        assert!(!should_emit(PROGRESS_INTERVAL / 2, false));
    }

    /// Rule 23's shape, pinned: the topic the store subscribes to before it
    /// invokes the command is assembled here, and the two halves are in
    /// different languages. A rename on either side is a silent no-progress bug.
    #[test]
    fn progress_topic_is_the_per_instance_shape() {
        assert_eq!(DOWNLOAD_SCHEME, "hermes-download");
        assert_eq!(
            format!("{DOWNLOAD_SCHEME}://{}/progress", "dl-7"),
            "hermes-download://dl-7/progress"
        );
    }

    /// Rule 24, pinned by construction: the event struct has room for two
    /// numbers and nowhere to put a byte. A `Vec<u8>` added here would serialize
    /// as `[12,255,3,…]` and be parsed on the webview's main thread.
    #[test]
    fn progress_events_carry_no_bytes() {
        let json = serde_json::to_string(&DownloadProgress {
            received: 12,
            total: Some(100),
        })
        .expect("serializes");

        assert_eq!(json, r#"{"received":12,"total":100}"#);

        let unknown = serde_json::to_string(&DownloadProgress {
            received: 12,
            total: None,
        })
        .expect("serializes");

        // `null`, not 0: a streamed archive has no Content-Length, and a 0 would
        // render as a bar that is somehow 12 bytes past its own end.
        assert_eq!(unknown, r#"{"received":12,"total":null}"#);
    }

    #[test]
    fn cancel_finds_a_registered_download_and_nothing_else() {
        let state = DownloadState::default();
        let flag = state.register("dl-1");

        assert!(!flag.load(Ordering::SeqCst));
        assert!(!state.cancel("dl-2"), "an unknown id cancels nothing");

        assert!(state.cancel("dl-1"));
        assert!(
            flag.load(Ordering::SeqCst),
            "the loop's flag is the one flipped"
        );
    }

    /// The leak this guards: a registry entry that outlives its transfer makes
    /// `cancel_download` answer `true` for a download that ended minutes ago,
    /// and the tray would show a cancel that never happens.
    #[test]
    fn forgetting_a_download_makes_it_uncancellable() {
        let state = DownloadState::default();

        state.register("dl-1");
        state.forget("dl-1");

        assert!(!state.cancel("dl-1"));
    }

    /// Both catch-all shapes the gateway can answer an unmatched /api/* path
    /// with, plus the route's own 404. Getting this backwards either hides
    /// folder downloads on a gateway that supports them, or shows a broken
    /// affordance on one that does not.
    #[test]
    fn tells_a_missing_archive_route_from_a_missing_folder() {
        assert_eq!(
            archive_404_code(r#"{"detail":"No such API endpoint: /api/files/download-archive"}"#),
            "route_missing"
        );
        assert_eq!(
            archive_404_code(r#"{"error":"Frontend not built. Run: cd web && npm run build"}"#),
            "route_missing"
        );
        assert_eq!(archive_404_code("<html>404</html>"), "route_missing");
        assert_eq!(archive_404_code(""), "route_missing");

        assert_eq!(
            archive_404_code(r#"{"detail":"Path not found"}"#),
            "file_not_found"
        );
        assert_eq!(
            archive_404_code(r#"{"detail":"Directory not found"}"#),
            "file_not_found"
        );
    }

    /// The two routes are one function with a URL swap; this is the swap.
    #[test]
    fn the_two_routes_are_the_gateway_paths_they_claim_to_be() {
        assert_eq!(Route::File.path(), "/api/files/download");
        assert_eq!(Route::Archive.path(), "/api/files/download-archive");
    }

    #[test]
    fn maps_the_statuses_the_gateway_returns() {
        assert_eq!(download_error(404), "file_not_found");
        assert_eq!(download_error(403), "file_forbidden");
        assert_eq!(download_error(413), "file_too_large");
        assert_eq!(download_error(401), "unauthorized");
        assert_eq!(download_error(500), "download_failed");
    }

    fn target_with_session_header() -> MediaTarget {
        let mut headers = std::collections::HashMap::new();
        headers.insert("X-Allr-Session-Token".to_string(), "sess-123".to_string());

        MediaTarget {
            base_url: "https://gw.example".to_string(),
            headers,
        }
    }

    /// The regression this pins: a gated/OAuth gateway authenticates by BEARER.
    /// Sending only the session-token headers got a 401 back, which the UI
    /// phrased as "session expired" on a session that was perfectly alive.
    #[test]
    fn carries_the_bearer_and_the_session_headers_together() {
        let client = reqwest::Client::new();
        let request = build_request(
            &client,
            "https://gw.example/api/files/download?path=%2Fx.pdf",
            &target_with_session_header(),
            Some("bearer-abc"),
        )
        .build()
        .expect("request builds");

        let headers = request.headers();

        assert_eq!(headers["authorization"], "Bearer bearer-abc");
        assert_eq!(headers["X-Allr-Session-Token"], "sess-123");
    }

    /// A loopback gateway holds no bearer. The session headers must still ride,
    /// and no empty `Authorization` may be forged — the gated middleware
    /// short-circuits on a presented-but-invalid bearer WITHOUT reading the
    /// session cookies, so an empty one would lock out a live cookie session.
    #[test]
    fn omits_authorization_entirely_when_there_is_no_bearer() {
        let client = reqwest::Client::new();
        let request = build_request(
            &client,
            "https://gw.example/api/files/download?path=%2Fx.pdf",
            &target_with_session_header(),
            None,
        )
        .build()
        .expect("request builds");

        assert!(!request.headers().contains_key("authorization"));
        assert_eq!(request.headers()["X-Allr-Session-Token"], "sess-123");
    }

    /// A path with spaces, `/`, and non-ASCII has to survive the hop into the
    /// gateway's own `?path=` — `NON_ALPHANUMERIC` encodes the separators that
    /// would otherwise split the query.
    #[test]
    fn encodes_every_reserved_character_in_the_path() {
        let encoded = utf8_percent_encode("/work/a b&c=d/é.pdf", NON_ALPHANUMERIC).to_string();

        assert_eq!(encoded, "%2Fwork%2Fa%20b%26c%3Dd%2F%C3%A9%2Epdf");
        assert!(!encoded.contains('&'));
        assert!(!encoded.contains('='));
    }
}
