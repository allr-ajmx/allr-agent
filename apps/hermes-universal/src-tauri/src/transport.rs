//! Generic network transport that runs entirely in Rust (Step 2a).
//!
//! The webview never opens a socket or issues `fetch` itself — it drives this
//! module over IPC. That removes the browser CORS constraint entirely (a native
//! client has no origin policy), so the app can talk to any Hermes/service on
//! the LAN or elsewhere.
//!
//! This is a *thin, generic* pipe on purpose: `http_request` proxies any REST
//! call, and `ws_open`/`ws_send`/`ws_close` proxy a raw WebSocket, forwarding
//! every server frame to the webview. The JSON-RPC framing and
//! request/response correlation stay in the reused JS `JsonRpcGatewayClient`,
//! which drives this via an IPC-backed `WebSocketLike`.
//!
//! Text/open/close/error frames ride Tauri events — they are low-rate and JSON
//! is the right shape for them. **Binary frames do not**: a Tauri event is JSON,
//! so a `Vec<u8>` crosses IPC as `[12,255,3,…]`, roughly 3.6 characters per
//! byte, parsed on the webview's main thread. Streaming TTS is ~32 KB of int16
//! PCM per second of speech, which is ~115 KB of JSON per second, continuously,
//! for the length of every spoken reply; the remote terminal pays the same tax
//! on every output burst. Binary therefore goes out on a `tauri::ipc::Channel`
//! as `InvokeResponseBody::Raw`, which reaches JS as an `ArrayBuffer` — no
//! encode, no parse, no per-element copy.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use reqwest_cookie_store::CookieStoreMutex;
use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody, JavaScriptChannelId};
use tauri::{AppHandle, Emitter, State, Url, Webview, Wry};
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

const USER_AGENT: &str = concat!("hermes-universal/", env!("CARGO_PKG_VERSION"));

/// Query parameters that carry a credential and must never reach a log line, an
/// error string, or the UI. The gateway WS authorizes with `?token=` (local /
/// SSH) or a per-connect `?ticket=` (gated + oauth) — see `store/gateway-config`
/// — so a WS URL *is* credential material, not just an address.
const SECRET_QUERY_KEYS: &[&str] = &[
    "access_token",
    "api_key",
    "key",
    "password",
    "refresh_token",
    "secret",
    "ticket",
    "token",
];

/// A URL safe to put in an error or a log: every secret-bearing query value is
/// replaced with `***`, while scheme, host, path and non-secret params (e.g.
/// `profile`) survive so the message still diagnoses something.
///
/// A parse failure truncates at the `?` rather than echoing the raw string — an
/// unparseable URL is exactly the case where a credential would otherwise ride
/// along untouched.
pub fn redact_url(raw: &str) -> String {
    let Ok(mut url) = Url::parse(raw) else {
        return match raw.split_once('?') {
            Some((head, _)) => format!("{head}?***"),
            None => raw.to_string(),
        };
    };

    if url.query().is_none() {
        return url.to_string();
    }

    let pairs: Vec<(String, String)> = url
        .query_pairs()
        .map(|(key, value)| {
            let value = if SECRET_QUERY_KEYS.contains(&key.as_ref()) {
                "***".to_string()
            } else {
                value.into_owned()
            };
            (key.into_owned(), value)
        })
        .collect();

    url.query_pairs_mut().clear().extend_pairs(pairs);
    url.to_string()
}

/// Scrub `url` out of a message some library built for us. reqwest embeds the
/// request URL in every transport error (`error sending request for url (…)`),
/// and tungstenite does the same for several of its URL errors, so an error we
/// merely forward can leak the ws auth param even though we never formatted it
/// in ourselves.
fn redact_error(message: String, url: &str) -> String {
    if url.is_empty() || !message.contains(url) {
        return message;
    }

    message.replace(url, &redact_url(url))
}

/// A live raw WebSocket: `tx` feeds the writer task; the two task handles are
/// aborted on close.
pub struct SocketHandle {
    tx: mpsc::UnboundedSender<Message>,
    reader: tokio::task::JoinHandle<()>,
    writer: tokio::task::JoinHandle<()>,
}

pub struct TransportState {
    /// Redirect-following client — the default for `http_request` and every
    /// REST call the webview drives.
    http: reqwest::Client,
    /// Redirect-DISABLED client sharing the same cookie jar. The OAuth flow
    /// (oauth.rs) needs to read the 302 `Location` off `/auth/login` rather than
    /// auto-following it into the IDP, while still landing every Set-Cookie in
    /// the shared jar.
    http_no_redirect: reqwest::Client,
    /// The one cookie jar both clients (and the WS ticket mint) share. Held
    /// explicitly (vs reqwest's private default) so OAuth can span two clients
    /// and D4 can serialize/rehydrate it across launches.
    cookies: Arc<CookieStoreMutex>,
    sockets: Mutex<HashMap<String, SocketHandle>>,
}

impl TransportState {
    pub fn new() -> Self {
        // One jar, shared by both clients via `.cookie_provider`, so the login
        // session cookie is retained across http_request calls and the
        // subsequent POST /api/auth/ws-ticket is authenticated (gated + oauth).
        let cookies = Arc::new(CookieStoreMutex::default());
        let http = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .cookie_provider(cookies.clone())
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        let http_no_redirect = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .cookie_provider(cookies.clone())
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self {
            http,
            http_no_redirect,
            cookies,
            sockets: Mutex::new(HashMap::new()),
        }
    }

    /// The redirect-following REST client (shared cookie jar).
    pub fn client(&self) -> &reqwest::Client {
        &self.http
    }

    /// The redirect-disabled client (shared cookie jar) — OAuth bootstrap legs.
    pub fn no_redirect_client(&self) -> &reqwest::Client {
        &self.http_no_redirect
    }

    /// The shared cookie jar — used by oauth.rs (post-callback inspection) and
    /// D4 persistence.
    pub fn cookies(&self) -> &Arc<CookieStoreMutex> {
        &self.cookies
    }
}

impl Default for TransportState {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpReq {
    method: String,
    url: String,
    #[serde(default)]
    headers: HashMap<String, String>,
    #[serde(default)]
    body: Option<serde_json::Value>,
    #[serde(default)]
    timeout_ms: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResp {
    status: u16,
    headers: HashMap<String, String>,
    body: String,
}

/// Generic REST proxy. Powers `/api/status` probing, session create/history,
/// and the OAuth ws-ticket mint — all with the auth header/cookie attached here
/// in Rust rather than in the webview.
#[tauri::command]
pub async fn http_request(
    state: State<'_, TransportState>,
    req: HttpReq,
) -> Result<HttpResp, String> {
    let method = reqwest::Method::from_bytes(req.method.to_uppercase().as_bytes())
        .map_err(|e| format!("invalid method {}: {e}", req.method))?;
    let mut builder = state.http.request(method, &req.url);
    for (key, value) in &req.headers {
        builder = builder.header(key, value);
    }
    if let Some(body) = &req.body {
        builder = builder.json(body);
    }
    if let Some(ms) = req.timeout_ms {
        builder = builder.timeout(Duration::from_millis(ms));
    }

    // reqwest puts the request URL in its transport errors; REST auth rides in a
    // header rather than the query, but a caller is free to pass either, so the
    // scrub is unconditional.
    let resp = builder
        .send()
        .await
        .map_err(|e| redact_error(e.to_string(), &req.url))?;
    let status = resp.status().as_u16();
    let headers = resp
        .headers()
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or_default().to_string()))
        .collect();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    Ok(HttpResp {
        status,
        headers,
        body,
    })
}

/// Hand one binary frame to the webview as raw IPC bytes.
///
/// `InvokeResponseBody::Raw` is delivered to JS as an `ArrayBuffer`: small
/// frames through a direct `eval`, larger ones through Tauri's queued fetch —
/// either way the bytes are never rendered as a JSON number array. Split out so
/// the "forwarded unmodified" invariant is testable without a webview: a
/// `Channel` built with `Channel::new` runs any closure the test hands it.
fn send_binary_frame(channel: &Channel<InvokeResponseBody>, payload: &[u8]) -> tauri::Result<()> {
    channel.send(InvokeResponseBody::Raw(payload.to_vec()))
}

/// Open a raw WebSocket. The *client* supplies `id` (a uuid) and subscribes to
/// `ws://{id}/open|message|close|error` BEFORE calling this, so no frame is
/// missed. `origin` is set on the upgrade to whatever the JS caller passes — the
/// gateway client sends `Origin: null` to mirror desktop's file:// renderer (the
/// value Hermes gateways accept for native clients). Sending the gateway's own
/// origin instead is rejected by reverse proxies that guard /api/ws on Origin/Host.
///
/// `binary_channel` is optional so an OLD JS bundle — one that never passes a
/// channel — still gets its binary frames, on the legacy `ws://{id}/binary`
/// event. A packaged app can outlive its bundled Rust core in either direction
/// across a JS-only update, so both halves of the seam tolerate the other being
/// a release behind.
#[tauri::command]
pub async fn ws_open(
    app: AppHandle,
    webview: Webview<Wry>,
    state: State<'_, TransportState>,
    id: String,
    url: String,
    origin: Option<String>,
    binary_channel: Option<JavaScriptChannelId>,
) -> Result<(), String> {
    // Resolved against the INVOKING webview, not an arbitrary one: this app runs
    // many windows (session-*, tile-*, sat-*) and the frames belong to whichever
    // one opened the socket.
    let binary: Option<Channel<InvokeResponseBody>> =
        binary_channel.map(|channel| channel.channel_on(webview));

    // The URL carries the ws auth param, so it is redacted before it can reach
    // an error string — this one bubbles all the way to $connectionError and is
    // rendered on the connecting screen.
    let mut request = url
        .clone()
        .into_client_request()
        .map_err(|e| format!("invalid ws url {}: {e}", redact_url(&url)))?;
    if let Some(origin) = origin {
        if let Ok(value) = origin.parse() {
            request.headers_mut().insert("Origin", value);
        }
    }

    let (stream, _resp) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|e| redact_error(e.to_string(), &url))?;
    let (mut write, mut read) = stream.split();

    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

    let writer = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if write.send(msg).await.is_err() {
                break;
            }
        }
    });

    let app_reader = app.clone();
    let tx_pong = tx.clone();
    let id_reader = id.clone();
    let reader = tokio::spawn(async move {
        // Close code (e.g. 4401 auth / 4410 child-exit from /api/shell-pty) so the
        // terminal can decide whether to reconnect. `None` on error/EOF exits.
        let mut close_code: Option<u16> = None;
        // The server's close reason, when it sent one. /api/shell-pty puts its
        // refusal sentence here (RFC 6455 caps it at 123 bytes), which is the
        // only way the pane can say WHY a 4404 happened instead of "disabled".
        let mut close_reason: Option<String> = None;
        while let Some(item) = read.next().await {
            match item {
                Ok(Message::Text(text)) => {
                    let _ = app_reader.emit(&format!("ws://{id_reader}/message"), text.to_string());
                }
                Ok(Message::Binary(payload)) => {
                    // Raw byte frames — the /api/shell-pty terminal's PTY output
                    // and /api/audio/speak-stream's int16 PCM. They go out on
                    // their own path, never `/message`, so the JSON-RPC gateway
                    // client (text only) is never disturbed.
                    match binary.as_ref() {
                        // Preferred: raw bytes over the IPC channel.
                        Some(channel) => {
                            let _ = send_binary_frame(channel, &payload);
                        }
                        // Legacy: a JSON number array on the old event. Kept for
                        // one release so an old JS bundle still gets its frames.
                        None => {
                            let _ =
                                app_reader.emit(&format!("ws://{id_reader}/binary"), payload.to_vec());
                        }
                    }
                }
                Ok(Message::Ping(payload)) => {
                    // Split streams don't auto-respond to pings; keepalive by hand.
                    let _ = tx_pong.send(Message::Pong(payload));
                }
                Ok(Message::Close(frame)) => {
                    if let Some(frame) = frame {
                        close_code = Some(u16::from(frame.code));
                        let reason = frame.reason.to_string();
                        if !reason.is_empty() {
                            close_reason = Some(reason);
                        }
                    }
                    break;
                }
                Ok(_) => {}
                Err(err) => {
                    let _ = app_reader.emit(&format!("ws://{id_reader}/error"), err.to_string());
                    break;
                }
            }
        }
        // Payload is `{code, reason}`, both nullable. The JSON-RPC gateway socket
        // ignores it; the terminal socket uses the code for reconnect decisions and
        // the reason for the end banner.
        let _ = app_reader.emit(
            &format!("ws://{id_reader}/close"),
            serde_json::json!({ "code": close_code, "reason": close_reason }),
        );
    });

    state
        .sockets
        .lock()
        .await
        .insert(id.clone(), SocketHandle { tx, reader, writer });

    let _ = app.emit(&format!("ws://{id}/open"), ());
    Ok(())
}

#[tauri::command]
pub async fn ws_send(
    state: State<'_, TransportState>,
    id: String,
    text: String,
) -> Result<(), String> {
    let sockets = state.sockets.lock().await;
    let handle = sockets.get(&id).ok_or("socket not found")?;
    handle
        .tx
        .send(Message::Text(text.into()))
        .map_err(|_| "socket closed".to_string())
}

#[tauri::command]
pub async fn ws_close(state: State<'_, TransportState>, id: String) -> Result<(), String> {
    if let Some(handle) = state.sockets.lock().await.remove(&id) {
        handle.reader.abort();
        handle.writer.abort();
    }
    Ok(())
}

/// Serialize the shared cookie jar to JSON so the JS layer can persist it in the
/// OS keyring (R2b). Captures unexpired, persistent cookies — which includes the
/// gateway session (`hermes_session_at/_rt`) and any portal (Privy) cookie — so a
/// gateway/cloud login survives an app restart. The refresh-token cookie alone is
/// enough: the gateway transparently re-mints the short-lived access cookie.
#[tauri::command]
pub fn cookies_export(state: State<'_, TransportState>) -> Result<String, String> {
    let store = state
        .cookies()
        .lock()
        .map_err(|_| "cookie jar poisoned".to_string())?;
    let mut buf: Vec<u8> = Vec::new();
    cookie_store::serde::json::save(&store, &mut buf).map_err(|e| e.to_string())?;
    String::from_utf8(buf).map_err(|e| e.to_string())
}

/// Rehydrate the shared cookie jar from a previously-exported JSON blob (skipping
/// any expired cookies). Called once on launch before the first connect so a saved
/// gateway/cloud session is restored without a fresh sign-in.
///
/// The import REPLACES the jar, so it is guarded three ways — a keyring read that
/// silently returned nothing, or a blob that no longer decrypts, must not be able
/// to sign a live session out:
///
///   1. A blank payload is refused outright (an empty keyring entry, not a jar).
///   2. A parse failure is LOGGED rather than swallowed — a session that stopped
///      surviving restarts is otherwise invisible, and a keyring blob that stops
///      decrypting is exactly the shape that failure takes.
///   3. A payload that parses to zero live cookies never replaces a jar that
///      already holds some.
///
/// The JS layer (lib/session-persist) guards (1) too; this is the boundary, and
/// the command is callable regardless of what that layer does.
#[tauri::command]
pub fn cookies_import(state: State<'_, TransportState>, json: String) -> Result<(), String> {
    if json.trim().is_empty() {
        log::warn!("[transport] refusing to import an empty cookie jar payload");
        return Err("empty cookie jar payload".to_string());
    }

    let loaded = cookie_store::serde::json::load(json.as_bytes()).map_err(|e| {
        // Never log `json` itself: it is the session.
        log::warn!("[transport] stored cookie jar failed to decode ({e}); keeping the live jar");
        e.to_string()
    })?;

    let mut store = state
        .cookies()
        .lock()
        .map_err(|_| "cookie jar poisoned".to_string())?;

    if loaded.iter_unexpired().next().is_none() && store.iter_unexpired().next().is_some() {
        log::warn!("[transport] stored cookie jar held no live cookies; keeping the live jar");
        return Ok(());
    }

    *store = loaded;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use tauri::ipc::{Channel, InvokeResponseBody};

    use super::{redact_error, redact_url, send_binary_frame};

    /// A `Channel` that records what it was handed, standing in for the webview.
    fn recording_channel() -> (Channel<InvokeResponseBody>, Arc<Mutex<Vec<InvokeResponseBody>>>) {
        let seen: Arc<Mutex<Vec<InvokeResponseBody>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();

        let channel = Channel::new(move |body| {
            sink.lock().unwrap().push(body);
            Ok(())
        });

        (channel, seen)
    }

    fn raw_bytes(body: &InvokeResponseBody) -> &[u8] {
        match body {
            InvokeResponseBody::Raw(bytes) => bytes,
            // A `Json` body here is the whole bug back again: that is the shape
            // that becomes `[12,255,3,…]` on the wire.
            InvokeResponseBody::Json(json) => panic!("binary frame was sent as JSON: {json}"),
        }
    }

    #[test]
    fn forwards_binary_frames_as_raw_bytes_unmodified() {
        let (channel, seen) = recording_channel();

        // Every byte value, so nothing that a JSON/UTF-8 round trip would mangle
        // (0x00, 0x7f-0xff) can survive by luck.
        let every_byte: Vec<u8> = (0..=255u8).collect();
        let frames: Vec<Vec<u8>> = vec![
            // Zero-length: a real frame shape, and the one an "if empty, skip"
            // optimisation silently swallows.
            Vec::new(),
            // Odd length: tts.ts carries the trailing byte into the NEXT frame,
            // so an off-by-one here desynchronises int16 PCM for the whole reply.
            vec![0x01],
            vec![0x00, 0xff, 0x7f],
            every_byte.clone(),
        ];

        for frame in &frames {
            send_binary_frame(&channel, frame).unwrap();
        }

        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), frames.len(), "every frame must be forwarded");
        for (body, frame) in seen.iter().zip(&frames) {
            assert_eq!(raw_bytes(body), frame.as_slice());
        }
    }

    #[test]
    fn redacts_the_ws_auth_param_and_keeps_everything_else() {
        assert_eq!(
            redact_url("ws://127.0.0.1:5051/api/ws?token=s3cr3t&profile=work"),
            "ws://127.0.0.1:5051/api/ws?token=***&profile=work"
        );
        assert_eq!(
            redact_url("wss://gw.example.com/api/ws?ticket=abc123"),
            "wss://gw.example.com/api/ws?ticket=***"
        );
    }

    #[test]
    fn leaves_a_credential_free_url_alone() {
        assert_eq!(
            redact_url("https://gw.example.com/api/status"),
            "https://gw.example.com/api/status"
        );
        assert_eq!(
            redact_url("https://gw.example.com/api/config?profile=work"),
            "https://gw.example.com/api/config?profile=work"
        );
    }

    #[test]
    fn truncates_at_the_query_when_the_url_will_not_parse() {
        // The unparseable case is exactly where a credential would otherwise
        // ride along verbatim, so it must not fall through to the raw string.
        let redacted = redact_url("not a url at all?token=s3cr3t");
        assert!(!redacted.contains("s3cr3t"), "{redacted}");
        assert_eq!(redacted, "not a url at all?***");
    }

    #[test]
    fn scrubs_a_url_a_library_embedded_in_its_own_error() {
        let url = "ws://127.0.0.1:5051/api/ws?token=s3cr3t";
        let message = redact_error(format!("error sending request for url ({url})"), url);

        assert!(!message.contains("s3cr3t"), "{message}");
        assert!(message.contains("token=***"), "{message}");
    }

    #[test]
    fn leaves_an_error_that_never_mentioned_the_url_untouched() {
        let message = redact_error("connection reset by peer".to_string(), "ws://h/api/ws?token=x");

        assert_eq!(message, "connection reset by peer");
    }
}
