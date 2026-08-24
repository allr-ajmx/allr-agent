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
//! 16 MB (`_FS_DATA_URL_MAX_BYTES`), while `/api/files/download` serves up to
//! 100 MB (`_MANAGED_FILE_MAX_BYTES`).
//!
//! The gateway target is `media.rs`'s — same host, same auth, same endpoint,
//! kept current by the `media_set_target` push in `src/lib/media-stream.ts`.

use std::time::Duration;

use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use tauri::State;

use crate::media::{MediaState, MediaTarget};
use crate::transport::{apply_gateway_bearer, TransportState};

/// Generous next to `media.rs`'s 20 s: that one bounds a 2 MiB range on a
/// latency-sensitive playback path, this one can legitimately be a 100 MB file
/// over a slow link. Still finite so a wedged gateway surfaces as an error
/// rather than a spinner that never resolves.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);

/// Save the gateway file at `path` to the local `dest`, returning the byte count.
///
/// Errors are short stable codes, not prose: the frontend maps them to
/// localized strings (an untranslated Rust sentence would be the only English
/// in an otherwise translated UI).
#[tauri::command]
pub async fn download_file(
    app: tauri::AppHandle,
    state: State<'_, TransportState>,
    media: State<'_, MediaState>,
    path: String,
    dest: String,
) -> Result<u64, String> {
    let Some(target) = media.target() else {
        return Err("no_gateway".into());
    };

    let url = format!(
        "{}/api/files/download?path={}",
        target.base_url.trim_end_matches('/'),
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
        return Err(download_error(status).into());
    }

    let bytes = response.bytes().await.map_err(|_| "gateway_unreachable")?;
    let len = bytes.len() as u64;

    // The parent is whatever the save dialog returned, so it normally exists;
    // create it anyway rather than failing after the whole file is in hand.
    if let Some(parent) = std::path::Path::new(&dest).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|_| "write_failed")?;
        }
    }

    std::fs::write(&dest, &bytes).map_err(|_| "write_failed")?;

    Ok(len)
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
/// The three the gateway actually returns for this route: 404 (gone), 403
/// (outside a hosted gateway's managed root, or a path on its sensitive
/// denylist), 413 (over the 100 MB cap). 401 means the session really has
/// lapsed — by this point the bearer rotation above has already been tried.
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
