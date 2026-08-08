//! `hermes-media://` — a Range-backed streaming scheme for gateway media.
//!
//! Inline audio and video used to load as base64 data URLs: the whole file went
//! into memory before the first frame, and there was no seeking at all. This
//! registers a custom URI scheme the media element can range-fetch instead, and
//! proxies each range to the gateway's `/api/files/download`.
//!
//! Desktop's `hermes-media://` (electron/main.ts) resolves a LOCAL path and lets
//! Electron's net stack serve it — and falls back to a plain download URL when
//! the gateway is remote. Universal always talks to a gateway over HTTP, so it
//! proxies rather than reads, and the auth that reaches the gateway is the
//! shared cookie jar plus the session-token header pushed in from JS.
//!
//! **The response is buffered, not streamed** — Tauri 2's `UriSchemeResponder`
//! takes a fully-materialized body, so there is no streaming API to use. What
//! keeps memory bounded is the chunk cap: every upstream request carries a
//! bounded `Range`, so the element sees `Accept-Ranges` plus a short
//! `Content-Range` and simply asks for the next chunk. Tauri's own `asset`
//! protocol does exactly this.

use std::collections::HashMap;
use std::sync::RwLock;
use std::time::Duration;

use serde::Deserialize;
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{Manager, State, UriSchemeContext, UriSchemeResponder};

use crate::transport::TransportState;

pub const MEDIA_SCHEME: &str = "hermes-media";

/// Per-response ceiling. Mirrors Tauri's own asset protocol (which caps at
/// 1000 KiB) but larger, since each chunk here is a network round trip rather
/// than a disk read. It must also stay well inside the 30 s that wry gives an
/// Android custom-protocol handler before it gives up and returns nothing —
/// hence this and `UPSTREAM_TIMEOUT` below, which is shorter still so a slow
/// gateway surfaces as a real error status instead of a silent timeout.
const MAX_CHUNK: u64 = 2 * 1024 * 1024;

const UPSTREAM_TIMEOUT: Duration = Duration::from_secs(20);

/// Where media requests go, pushed in from JS on every connection change.
/// Modeled on `voice::TranscribeTarget` — the scheme handler runs outside the
/// webview and cannot read the `$connection` nanostore, and the token must NOT
/// ride in the URL (it would land in the DOM and in devtools).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaTarget {
    pub base_url: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
}

#[derive(Default)]
pub struct MediaState(RwLock<Option<MediaTarget>>);

#[tauri::command]
pub fn media_set_target(
    state: State<'_, MediaState>,
    target: Option<MediaTarget>,
) -> Result<(), String> {
    let mut guard = state.0.write().map_err(|_| "media_state_poisoned")?;
    *guard = target;
    Ok(())
}

/// Extensions worth streaming, and the MIME each one gets.
///
/// This doubles as the gate: without it the scheme would be an uncapped read of
/// any gateway-readable file for anything that can build a URL. Mirrors
/// desktop's `STREAMABLE_MEDIA_EXTS`.
///
/// The MIME comes from here rather than from the gateway on purpose — the
/// download endpoint uses a bare `mimetypes.guess_type`, which answers
/// `application/octet-stream` for `.opus`/`.m4a`/`.mkv` and silently kills
/// playback.
pub fn streamable_mime(path: &str) -> Option<&'static str> {
    let ext = path.rsplit('.').next()?.to_ascii_lowercase();

    Some(match ext.as_str() {
        "mp4" | "m4v" => "video/mp4",
        "mkv" => "video/x-matroska",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "avi" => "video/x-msvideo",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        "ogg" => "audio/ogg",
        "opus" => "audio/ogg",
        _ => return None,
    })
}

/// The `Range` to ask the gateway for: whatever the element wanted, clamped to
/// `MAX_CHUNK`, and a bounded first chunk when it asked for nothing at all.
///
/// Only single ranges are handled. Media elements never send a multi-range
/// request, and relaying a `multipart/byteranges` body correctly is not worth
/// the code — an unparseable header falls back to the leading chunk, which is
/// always a valid answer.
pub fn bounded_range(requested: Option<&str>) -> String {
    let default = format!("bytes=0-{}", MAX_CHUNK - 1);

    let Some(spec) = requested.and_then(|value| value.trim().strip_prefix("bytes=")) else {
        return default;
    };

    // A suffix range (`bytes=-500`, "the last 500 bytes") can't be clamped
    // without knowing the length, and it is already small by construction.
    if spec.starts_with('-') {
        return format!("bytes={spec}");
    }

    let mut parts = spec.splitn(2, '-');
    let Some(start) = parts.next().and_then(|value| value.parse::<u64>().ok()) else {
        return default;
    };

    let ceiling = start.saturating_add(MAX_CHUNK - 1);
    let end = match parts.next().unwrap_or("").trim() {
        "" => ceiling,
        value => value.parse::<u64>().unwrap_or(ceiling).min(ceiling),
    };

    format!("bytes={start}-{end}")
}

/// The value of a query parameter, still percent-encoded.
///
/// Left encoded on purpose: it is forwarded verbatim into the gateway's own
/// `?path=`, so there is no decode/re-encode round trip to get wrong (a `+`
/// or a `%2F` surviving one hop but not the other).
fn query_param<'a>(query: &'a str, key: &str) -> Option<&'a str> {
    query.split('&').find_map(|pair| {
        let (name, value) = pair.split_once('=')?;
        (name == key).then_some(value)
    })
}

fn percent_decode(value: &str) -> String {
    percent_encoding::percent_decode_str(value)
        .decode_utf8_lossy()
        .into_owned()
}

fn status_only(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .body(Vec::new())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

pub fn handle<R: tauri::Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = ctx.app_handle().clone();

    let range = request
        .headers()
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);

    let encoded = query_param(request.uri().query().unwrap_or(""), "path").map(str::to_owned);

    // `UriSchemeResponder` is Send, so the whole round trip can move onto the
    // async runtime rather than blocking the protocol thread.
    tauri::async_runtime::spawn(async move {
        responder.respond(fetch_chunk(&app, encoded, range).await);
    });
}

async fn fetch_chunk<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    encoded: Option<String>,
    range: Option<String>,
) -> Response<Vec<u8>> {
    let Some(encoded) = encoded else {
        return status_only(StatusCode::BAD_REQUEST);
    };

    let Some(mime) = streamable_mime(&percent_decode(&encoded)) else {
        return status_only(StatusCode::UNSUPPORTED_MEDIA_TYPE);
    };

    let Some(target) = app
        .state::<MediaState>()
        .0
        .read()
        .ok()
        .and_then(|guard| guard.clone())
    else {
        // No gateway yet — the frontend falls back to the data URL.
        return status_only(StatusCode::SERVICE_UNAVAILABLE);
    };

    let url = format!(
        "{}/api/files/download?path={}",
        target.base_url.trim_end_matches('/'),
        encoded
    );

    let client = app.state::<TransportState>().client().clone();
    let mut req = client
        .get(&url)
        // Always bounded, even when the element asked for the whole file: that
        // is what keeps a 90-minute video from being buffered whole.
        .header(header::RANGE, bounded_range(range.as_deref()))
        .timeout(UPSTREAM_TIMEOUT);

    for (name, value) in &target.headers {
        req = req.header(name, value);
    }

    let upstream = match req.send().await {
        Ok(response) => response,
        Err(_) => return status_only(StatusCode::BAD_GATEWAY),
    };

    let upstream_status = upstream.status();

    if !upstream_status.is_success() {
        // 403 (outside a hosted gateway's managed root), 404, 413 (over the
        // 100 MB cap) — relayed so the frontend's one-shot retry can fall back
        // to the data URL rather than showing a dead player.
        return status_only(
            StatusCode::from_u16(upstream_status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY),
        );
    }

    let content_range = upstream.headers().get(header::CONTENT_RANGE).cloned();

    let bytes = match upstream.bytes().await {
        Ok(bytes) => bytes.to_vec(),
        Err(_) => return status_only(StatusCode::BAD_GATEWAY),
    };

    let mut out = Response::builder()
        .status(if upstream_status == StatusCode::PARTIAL_CONTENT {
            StatusCode::PARTIAL_CONTENT
        } else {
            StatusCode::OK
        })
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_TYPE, mime)
        .header(header::CONTENT_LENGTH, bytes.len());

    if let Some(value) = content_range {
        out = out.header(header::CONTENT_RANGE, value);
    }

    // `Content-Disposition: attachment` is deliberately NOT relayed — the
    // download endpoint sets it, and it has no place on a media subresource.
    out.body(bytes)
        .unwrap_or_else(|_| status_only(StatusCode::INTERNAL_SERVER_ERROR))
}

#[cfg(test)]
mod tests {
    use super::*;

    const CAP: u64 = MAX_CHUNK - 1;

    #[test]
    fn defaults_to_a_bounded_first_chunk() {
        assert_eq!(bounded_range(None), format!("bytes=0-{CAP}"));
        assert_eq!(bounded_range(Some("")), format!("bytes=0-{CAP}"));
        assert_eq!(bounded_range(Some("nonsense")), format!("bytes=0-{CAP}"));
        assert_eq!(bounded_range(Some("bytes=abc-")), format!("bytes=0-{CAP}"));
    }

    #[test]
    fn bounds_an_open_ended_range() {
        assert_eq!(bounded_range(Some("bytes=0-")), format!("bytes=0-{CAP}"));
        assert_eq!(
            bounded_range(Some("bytes=1000-")),
            format!("bytes=1000-{}", 1000 + CAP)
        );
    }

    #[test]
    fn keeps_a_range_already_inside_the_cap() {
        assert_eq!(bounded_range(Some("bytes=100-199")), "bytes=100-199");
    }

    #[test]
    fn clamps_a_range_past_the_cap() {
        assert_eq!(
            bounded_range(Some("bytes=0-99999999")),
            format!("bytes=0-{CAP}")
        );
    }

    #[test]
    fn passes_a_suffix_range_through() {
        assert_eq!(bounded_range(Some("bytes=-500")), "bytes=-500");
    }

    #[test]
    fn tolerates_surrounding_whitespace() {
        assert_eq!(bounded_range(Some("  bytes=10-20 ")), "bytes=10-20");
    }

    #[test]
    fn recognises_every_streamable_extension() {
        for (path, mime) in [
            ("/x/a.mp4", "video/mp4"),
            ("/x/a.MKV", "video/x-matroska"),
            ("/x/a.mov", "video/quicktime"),
            ("/x/a.webm", "video/webm"),
            ("/x/a.avi", "video/x-msvideo"),
            ("/x/a.mp3", "audio/mpeg"),
            ("/x/a.m4a", "audio/mp4"),
            ("/x/a.wav", "audio/wav"),
            ("/x/a.flac", "audio/flac"),
            ("/x/a.ogg", "audio/ogg"),
            ("/x/a.opus", "audio/ogg"),
        ] {
            assert_eq!(streamable_mime(path), Some(mime), "{path}");
        }
    }

    #[test]
    fn rejects_anything_not_streamable() {
        for path in ["/x/a.png", "/x/a.pdf", "/etc/passwd", "/x/noext"] {
            assert_eq!(streamable_mime(path), None, "{path}");
        }
    }

    #[test]
    fn reads_the_path_parameter_still_encoded() {
        assert_eq!(
            query_param("path=%2Fhome%2Fme%2Fa.mp4", "path"),
            Some("%2Fhome%2Fme%2Fa.mp4")
        );
        assert_eq!(query_param("a=1&path=x&b=2", "path"), Some("x"));
        assert_eq!(query_param("a=1", "path"), None);
        assert_eq!(query_param("", "path"), None);
    }
}
