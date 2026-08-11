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

use std::collections::{BTreeSet, HashMap};
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

/// Characters an OAuth bearer is allowed to be made of (RFC 6750 §2.1's
/// `token68`). Used to tell a real credential from the English word "bearer"
/// followed by a noun, so [`redact_bearer`] does not mangle our own prose.
fn is_token68(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_' | '~' | '+' | '/' | '=')
}

/// Replace the value of any `Bearer <token>` in a message with `***`.
///
/// [`redact_url`] covers a credential carried in a query string; this covers the
/// other place one can appear — an `Authorization` header value quoted back at
/// us by a library. Since MJXHRM-354 the gateway bearer never leaves Rust, so an
/// error string is the last path by which it could still reach the webview, and
/// error strings from this module are rendered directly onto the connect screen.
///
/// Only a run that actually looks like a credential is redacted (token68
/// characters, at least 8 of them), so "bearer token missing" survives intact.
pub fn redact_bearer(message: String) -> String {
    const MARKER: &str = "bearer ";
    const MIN_TOKEN_LEN: usize = 8;

    // ASCII-lowercasing is byte-length preserving, so offsets found here index
    // the original string; and every offset used below lands after ASCII text,
    // hence on a char boundary.
    let lower = message.to_ascii_lowercase();

    if !lower.contains(MARKER) {
        return message;
    }

    let mut out = String::with_capacity(message.len());
    let mut cursor = 0;

    while let Some(hit) = lower[cursor..].find(MARKER) {
        let start = cursor + hit + MARKER.len();
        let end = message[start..]
            .find(|c: char| !is_token68(c))
            .map_or(message.len(), |offset| start + offset);

        out.push_str(&message[cursor..start]);

        if end - start >= MIN_TOKEN_LEN {
            out.push_str("***");
            cursor = end;
        } else {
            // Not a credential — leave the words alone and keep scanning past them.
            cursor = start;
        }
    }

    out.push_str(&message[cursor..]);
    out
}

/// Scrub one specific secret we are holding out of a message we did not build.
///
/// The complement of [`redact_bearer`]: that one recognises the header shape,
/// this one is used where we know the exact material (a refresh token posted in
/// a body, say) and the library is free to echo it in any shape it likes. Short
/// values are left alone — a secret of five characters would turn every message
/// into confetti, and is not a credential worth protecting anyway.
pub fn redact_secret(message: String, secret: &str) -> String {
    if secret.len() < 8 || !message.contains(secret) {
        return message;
    }

    message.replace(secret, "***")
}

/// Which gateway bases may have their RFC 8252 bearer attached to a request, and
/// which origins have already been checked and found to have none.
///
/// This registry is the whole guard against leaking the credential to a third
/// party: a request is authenticated only when its URL sits *under* a base we
/// know holds a native session — never because the URL "looks like" a gateway.
/// The `checked` half only keeps the origin fallback in
/// [`TransportState::bearer_base_for_url`] from hitting the OS keyring once per
/// request to some unrelated host.
#[derive(Default)]
struct BearerBases {
    known: BTreeSet<String>,
    checked: BTreeSet<String>,
}

/// Is `url` at, or underneath, `base`? A prefix test alone would match
/// `https://gw.evil.com` against a base of `https://gw.ev`, so the character
/// after the prefix has to end the authority or start a path/query.
fn url_is_under(url: &str, base: &str) -> bool {
    url.strip_prefix(base)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with('/') || rest.starts_with('?'))
}

/// The path namespaces a Hermes gateway serves. Used only to decide whether an
/// UNKNOWN origin is worth one keyring lookup — never to decide that a URL is
/// trustworthy. A gateway behind a path prefix (`https://host/hermes`, which the
/// settings copy explicitly supports) matches neither, and is reached the other
/// way: `oauth_status` registers its base the first time the webview probes it.
const GATEWAY_PATH_PREFIXES: &[&str] = &["/api/", "/auth/"];

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
    /// Gateway bases whose bearer `http_request` may attach (MJXHRM-354). A
    /// `std::sync::Mutex` on purpose: every access is a set lookup with no await
    /// inside, so the async-aware lock would buy nothing.
    bearer_bases: std::sync::Mutex<BearerBases>,
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
            bearer_bases: std::sync::Mutex::new(BearerBases::default()),
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

    /// Record that `base` holds a native (bearer) session, so requests under it
    /// are authenticated with it. Called by oauth.rs whenever a token set is
    /// written to, or found in, the keyring.
    pub fn register_bearer_base(&self, base: &str) {
        if let Ok(mut bases) = self.bearer_bases.lock() {
            bases.checked.remove(base);
            bases.known.insert(base.to_string());
        }
    }

    /// Record that `base` has no native session, so the origin fallback below
    /// stops asking the keyring about it.
    pub fn note_no_bearer_base(&self, base: &str) {
        if let Ok(mut bases) = self.bearer_bases.lock() {
            bases.known.remove(base);
            bases.checked.insert(base.to_string());
        }
    }

    /// Forget a base whose native session is gone (sign-out, or a refresh the
    /// gateway refused). Deliberately does NOT mark it checked: the user may
    /// sign straight back in, and a stale negative would then suppress the
    /// bearer until the next probe.
    pub fn forget_bearer_base(&self, base: &str) {
        if let Ok(mut bases) = self.bearer_bases.lock() {
            bases.known.remove(base);
            bases.checked.remove(base);
        }
    }

    /// The gateway base whose bearer `url` may carry, if any.
    ///
    /// A registered base wins — it can carry a path prefix
    /// (`https://host/hermes`), which no amount of URL parsing would recover.
    /// Otherwise the URL's ORIGIN is offered once, so a session left in the
    /// keyring by a previous run is found on the first request of a new one
    /// rather than only after the webview happens to call `oauth_status`. The
    /// caller answers that offer by calling `register_bearer_base` or
    /// `note_no_bearer_base`, and the origin is never offered again.
    ///
    /// That one-shot offer is confined to the gateway's own path namespaces —
    /// not as a trust decision (the answer still comes from the keyring) but so
    /// that fetching, say, a marketplace listing does not spend a Secret Service
    /// round trip to be told what it already knew.
    pub fn bearer_base_for_url(&self, url: &str) -> Option<String> {
        let Ok(bases) = self.bearer_bases.lock() else {
            return None;
        };

        // Descending order tries the longest shared prefix first, so a base of
        // `https://host/hermes` wins over a bare `https://host`.
        if let Some(base) = bases
            .known
            .iter()
            .rev()
            .find(|base| url_is_under(url, base))
        {
            return Some(base.clone());
        }

        let parsed = Url::parse(url).ok()?;

        if !GATEWAY_PATH_PREFIXES
            .iter()
            .any(|prefix| parsed.path().starts_with(prefix))
        {
            return None;
        }

        let origin = parsed.origin().ascii_serialization();

        // "null" is what an opaque origin (data:, file:, …) serialises to; it is
        // not an address a gateway can live at.
        if origin == "null" || bases.checked.contains(&origin) {
            return None;
        }

        Some(origin)
    }
}

impl Default for TransportState {
    fn default() -> Self {
        Self::new()
    }
}

/// A single-file `multipart/form-data` upload, sent under the field name
/// `file` — the shape FastAPI's `UploadFile` parameters expect, and the one
/// desktop's Electron bridge already assembles by hand.
///
/// The bytes arrive base64-encoded because the Tauri command boundary is JSON:
/// a `Vec<u8>` would serialise as an array of numbers, roughly 4x the wire size
/// of base64 and far more allocation on both sides.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpUpload {
    filename: String,
    #[serde(default)]
    content_type: Option<String>,
    bytes_base64: String,
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
    /// Mutually exclusive with `body` — a multipart request has no JSON body.
    /// When both are set the upload wins, matching desktop.
    #[serde(default)]
    upload: Option<HttpUpload>,
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

/// Did the caller supply its own `Authorization`? The MCP and marketplace panels
/// talk to third-party services with their own keys, and their header must win —
/// we would otherwise overwrite it with a credential meant for somewhere else.
fn caller_set_authorization(headers: &HashMap<String, String>) -> bool {
    headers
        .keys()
        .any(|key| key.eq_ignore_ascii_case("authorization"))
}

/// Attach the gateway bearer, if we hold one. Split out so the "the header is
/// actually on the request" invariant is testable without a network or a
/// keyring: `RequestBuilder::build` produces the request without sending it.
fn apply_gateway_bearer(
    builder: reqwest::RequestBuilder,
    bearer: Option<&str>,
) -> reqwest::RequestBuilder {
    match bearer {
        Some(token) => builder.bearer_auth(token),
        None => builder,
    }
}

/// Build the `multipart/form-data` form for an upload.
///
/// Rebuilt per attempt rather than built once and reused: `multipart::Form` is
/// a one-shot stream, so the 401-rotate retry below needs a fresh one.
fn upload_form(upload: &HttpUpload) -> Result<reqwest::multipart::Form, String> {
    use base64::Engine as _;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(upload.bytes_base64.as_bytes())
        .map_err(|e| format!("invalid upload payload: {e}"))?;

    // Strip quotes and CRLF from the filename — they would otherwise break out
    // of the Content-Disposition header. Same guard as desktop's bridge.
    let filename = upload
        .filename
        .replace(['"', '\r', '\n'], "_")
        .trim()
        .to_string();
    let filename = if filename.is_empty() {
        "file".to_string()
    } else {
        filename
    };

    let mut part = reqwest::multipart::Part::bytes(bytes).file_name(filename);
    part = part
        .mime_str(
            upload
                .content_type
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or("application/octet-stream"),
        )
        .map_err(|e| format!("invalid upload content type: {e}"))?;

    Ok(reqwest::multipart::Form::new().part("file", part))
}

/// Issue `req` once, with `bearer` attached when there is one.
async fn send_http(
    client: &reqwest::Client,
    method: &reqwest::Method,
    req: &HttpReq,
    bearer: Option<&str>,
) -> Result<reqwest::Response, String> {
    let mut builder = client.request(method.clone(), &req.url);
    for (key, value) in &req.headers {
        builder = builder.header(key, value);
    }
    if let Some(upload) = &req.upload {
        // `multipart` sets Content-Type itself, boundary included — a caller
        // header would produce a boundary that does not match the body.
        builder = builder.multipart(upload_form(upload)?);
    } else if let Some(body) = &req.body {
        builder = builder.json(body);
    }
    if let Some(ms) = req.timeout_ms {
        builder = builder.timeout(Duration::from_millis(ms));
    }

    // reqwest puts the request URL in its transport errors; REST auth rides in a
    // header rather than the query, but a caller is free to pass either, so the
    // scrub is unconditional. `redact_bearer` covers the header itself — this
    // error string is rendered on the connect screen.
    apply_gateway_bearer(builder, bearer)
        .send()
        .await
        .map_err(|e| redact_bearer(redact_error(e.to_string(), &req.url)))
}

/// Generic REST proxy. Powers `/api/status` probing, session create/history,
/// and the OAuth ws-ticket mint — all with the auth header/cookie attached here
/// in Rust rather than in the webview.
///
/// The `Authorization: Bearer` of an RFC 8252 native session is attached HERE,
/// read from the OS keyring at request time (MJXHRM-354). It used to be returned
/// to JS by `oauth_status` and pasted on by the ws-ticket mint, which put a
/// long-lived credential inside the webview — reachable by any script, and by
/// anything that logs or serialises it. The webview now asks for a request; it
/// never holds the credential.
#[tauri::command]
pub async fn http_request(
    app: AppHandle,
    state: State<'_, TransportState>,
    req: HttpReq,
) -> Result<HttpResp, String> {
    let method = reqwest::Method::from_bytes(req.method.to_uppercase().as_bytes())
        .map_err(|e| format!("invalid method {}: {e}", req.method))?;

    let auth_base = if caller_set_authorization(&req.headers) {
        None
    } else {
        state.bearer_base_for_url(&req.url)
    };
    let bearer = match &auth_base {
        Some(base) => crate::oauth::gateway_bearer(&app, state.inner(), base, false).await,
        None => None,
    };

    let mut resp = send_http(&state.http, &method, &req, bearer.as_deref()).await?;

    // A bearer the gateway refuses is normally one rotated or revoked out from
    // under us between the keyring read and the send, so force a rotation and
    // try exactly once more — this is the retry that used to live in the JS
    // ws-ticket mint. Replaying is safe for any method: a 401 means the gateway
    // rejected the request before acting on it.
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED && bearer.is_some() {
        if let Some(base) = &auth_base {
            let rotated = crate::oauth::gateway_bearer(&app, state.inner(), base, true).await;

            if rotated.is_some() && rotated != bearer {
                resp = send_http(&state.http, &method, &req, rotated.as_deref()).await?;
            }
        }
    }

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
        .map_err(|e| redact_bearer(redact_error(e.to_string(), &url)))?;
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
    // The reader outlives this function, so it needs its own copy of the URL to
    // scrub its errors against — see the `Err` arm below.
    let url_reader = url.clone();
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
                            let _ = app_reader
                                .emit(&format!("ws://{id_reader}/binary"), payload.to_vec());
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
                    // Redacted like the connect-time error above (MJXHRM-376).
                    // It was not, and that was the gap: this error takes the
                    // same route to the same place — `ws://{id}/error` is
                    // broadcast to every window and rendered on the connect
                    // screen — and tungstenite quotes the request URL, which
                    // carries the ws auth token, into several of its variants.
                    // A socket that fails *after* the handshake is exactly the
                    // case where the token was accepted, so it is real.
                    let message = redact_bearer(redact_error(err.to_string(), &url_reader));
                    let _ = app_reader.emit(&format!("ws://{id_reader}/error"), message);
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

    use super::{
        apply_gateway_bearer, caller_set_authorization, redact_bearer, redact_error, redact_secret,
        redact_url, send_binary_frame, upload_form, HttpUpload, TransportState,
    };

    /// A `Channel` that records what it was handed, standing in for the webview.
    fn recording_channel() -> (
        Channel<InvokeResponseBody>,
        Arc<Mutex<Vec<InvokeResponseBody>>>,
    ) {
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
        let message = redact_error(
            "connection reset by peer".to_string(),
            "ws://h/api/ws?token=x",
        );

        assert_eq!(message, "connection reset by peer");
    }

    // ── the gateway bearer (MJXHRM-354) ──────────────────────────────────────

    /// The header is the entire point of the change: the credential must reach
    /// the wire from Rust, without ever having been handed to the webview.
    #[test]
    fn attaches_the_gateway_bearer_to_the_outgoing_request() {
        let client = reqwest::Client::new();
        let request = apply_gateway_bearer(
            client.post("https://gw.example.com/api/auth/ws-ticket"),
            Some("at-1"),
        )
        .build()
        .expect("request builds");

        assert_eq!(
            request
                .headers()
                .get(reqwest::header::AUTHORIZATION)
                .map(|v| v.to_str().unwrap()),
            Some("Bearer at-1")
        );
    }

    #[test]
    fn sends_no_authorization_at_all_when_there_is_no_native_session() {
        let client = reqwest::Client::new();
        let request = apply_gateway_bearer(client.get("https://gw.example.com/api/status"), None)
            .build()
            .expect("request builds");

        // A cookie session authenticates from the shared jar; an empty bearer
        // header would make the gated middleware answer 401 instead.
        assert!(request
            .headers()
            .get(reqwest::header::AUTHORIZATION)
            .is_none());
    }

    #[test]
    fn a_caller_supplied_authorization_is_detected_in_any_casing() {
        // The MCP and marketplace panels reach third-party services with their
        // own keys; overwriting one with the gateway bearer would both break the
        // call and send our credential somewhere it does not belong.
        assert!(caller_set_authorization(
            &[("Authorization".to_string(), "Bearer theirs".to_string())].into()
        ));
        assert!(caller_set_authorization(
            &[("authorization".to_string(), "Basic x".to_string())].into()
        ));
        assert!(!caller_set_authorization(
            &[("Origin".to_string(), "https://gw".to_string())].into()
        ));
    }

    #[test]
    fn the_bearer_is_offered_only_to_urls_under_a_known_gateway_base() {
        let state = TransportState::new();
        state.register_bearer_base("https://gw.example.com");

        assert_eq!(
            state.bearer_base_for_url("https://gw.example.com/api/auth/ws-ticket"),
            Some("https://gw.example.com".to_string())
        );
        // A host that merely STARTS with the base is a different host, and must
        // never be handed our gateway's base.
        assert_ne!(
            state.bearer_base_for_url("https://gw.example.com.evil.test/api/steal"),
            Some("https://gw.example.com".to_string())
        );
        assert_eq!(
            state.bearer_base_for_url("https://gw.example.com.evil.test/steal"),
            None
        );
    }

    #[test]
    fn a_path_prefixed_base_beats_the_bare_origin() {
        // `https://host/hermes` is a legal gateway base and no amount of URL
        // parsing recovers it — only the registry knows.
        let state = TransportState::new();
        state.register_bearer_base("https://host");
        state.register_bearer_base("https://host/hermes");

        assert_eq!(
            state.bearer_base_for_url("https://host/hermes/api/status"),
            Some("https://host/hermes".to_string())
        );
        assert_eq!(
            state.bearer_base_for_url("https://host/api/status"),
            Some("https://host".to_string())
        );
    }

    #[test]
    fn an_origin_is_offered_once_and_then_remembered_as_bearer_free() {
        // The offer is how a session left in the keyring by a PREVIOUS run is
        // found on the first request of a new one; the memo is what stops every
        // later request paying a keyring round trip for the same answer.
        let state = TransportState::new();

        assert_eq!(
            state.bearer_base_for_url("https://gw.example.com/api/status"),
            Some("https://gw.example.com".to_string())
        );

        state.note_no_bearer_base("https://gw.example.com");

        assert_eq!(
            state.bearer_base_for_url("https://gw.example.com/api/status"),
            None
        );
    }

    #[test]
    fn a_url_outside_the_gateway_namespaces_never_reaches_the_keyring() {
        // Not a trust boundary — the registry is. This only keeps a third-party
        // fetch from paying a Secret Service round trip to learn nothing.
        let state = TransportState::new();

        assert_eq!(
            state.bearer_base_for_url("https://third-party.test/v1/models"),
            None
        );
        assert_eq!(state.bearer_base_for_url("https://gw.example.com/"), None);
    }

    #[test]
    fn signing_out_reopens_the_question_rather_than_answering_it_no() {
        // A user who signs straight back in must not be stuck bearer-less until
        // something happens to probe the gateway again.
        let state = TransportState::new();
        state.register_bearer_base("https://gw.example.com");
        state.forget_bearer_base("https://gw.example.com");

        assert_eq!(
            state.bearer_base_for_url("https://gw.example.com/api/status"),
            Some("https://gw.example.com".to_string())
        );
    }

    #[test]
    fn an_unparseable_or_opaque_url_is_never_authenticated() {
        let state = TransportState::new();

        assert_eq!(state.bearer_base_for_url("not a url"), None);
        assert_eq!(state.bearer_base_for_url("data:text/plain,hi"), None);
    }

    #[test]
    fn scrubs_a_bearer_a_library_quoted_back_at_us() {
        let message =
            redact_bearer("request failed: Authorization: Bearer eyJhbGciOi.J9.sig".to_string());

        assert!(!message.contains("eyJhbGciOi"), "{message}");
        assert_eq!(message, "request failed: Authorization: Bearer ***");
    }

    /// MJXHRM-376. The socket's read loop failing mid-session emits its error on
    /// `ws://{id}/error`, which is broadcast to every window and rendered on the
    /// connect screen — the same destination as the connect-time error that was
    /// already scrubbed. Tungstenite quotes the request URL into several of its
    /// variants, and that URL carries the ws auth token.
    #[test]
    fn a_reader_error_is_scrubbed_the_same_way_a_connect_error_is() {
        let url = "wss://gw.example.com/api/ws?token=s3cr3t-ws-ticket";
        let raw = format!("IO error on {url}: connection reset by peer");

        let scrubbed = redact_bearer(redact_error(raw, url));

        assert!(!scrubbed.contains("s3cr3t-ws-ticket"), "{scrubbed}");
        assert!(scrubbed.contains("token=***"), "{scrubbed}");
        // Still says what went wrong: a redaction that eats the diagnosis is
        // how a user ends up with "something failed".
        assert!(scrubbed.contains("connection reset by peer"), "{scrubbed}");
    }

    #[test]
    fn leaves_the_english_word_bearer_alone() {
        // Redacting on the word alone would turn our own messages into noise —
        // and noise is what stops people reading them.
        assert_eq!(
            redact_bearer("the bearer was refused".to_string()),
            "the bearer was refused"
        );
        assert_eq!(redact_bearer("no bearer".to_string()), "no bearer");
    }

    #[test]
    fn scrubs_every_bearer_in_a_message_not_just_the_first() {
        let message = redact_bearer("tried Bearer aaaaaaaaaa then Bearer bbbbbbbbbb".to_string());

        assert_eq!(message, "tried Bearer *** then Bearer ***");
    }

    #[test]
    fn scrubs_a_secret_we_are_holding_but_leaves_short_strings_alone() {
        assert_eq!(
            redact_secret("refresh rt-0123456789 failed".to_string(), "rt-0123456789"),
            "refresh *** failed"
        );
        // A short value is not a credential worth protecting, and replacing it
        // would shred unrelated messages that happen to contain it.
        assert_eq!(redact_secret("a b c".to_string(), "b"), "a b c");
        assert_eq!(
            redact_secret("nothing to do".to_string(), "rt-0123456789"),
            "nothing to do"
        );
    }

    fn upload(filename: &str, content_type: Option<&str>, bytes_base64: &str) -> HttpUpload {
        HttpUpload {
            filename: filename.to_string(),
            content_type: content_type.map(str::to_string),
            bytes_base64: bytes_base64.to_string(),
        }
    }

    #[test]
    fn upload_form_accepts_a_base64_payload() {
        // "hi" — the happy path a plugin attachment takes.
        assert!(upload_form(&upload("a.txt", Some("text/plain"), "aGk=")).is_ok());
    }

    #[test]
    fn upload_form_defaults_a_missing_content_type() {
        assert!(upload_form(&upload("a.bin", None, "aGk=")).is_ok());
        assert!(upload_form(&upload("a.bin", Some("   "), "aGk=")).is_ok());
    }

    #[test]
    fn upload_form_rejects_a_bad_payload() {
        let err = upload_form(&upload("a.txt", None, "not base64!!")).unwrap_err();
        assert!(err.contains("invalid upload payload"), "got: {err}");
    }

    #[test]
    fn upload_form_rejects_an_unparseable_content_type() {
        let err = upload_form(&upload("a.txt", Some("not a mime"), "aGk=")).unwrap_err();
        assert!(err.contains("invalid upload content type"), "got: {err}");
    }

    /// Quotes and CRLF in a filename would otherwise break out of the
    /// Content-Disposition header the multipart part writes.
    #[test]
    fn upload_form_survives_a_hostile_filename() {
        assert!(upload_form(&upload("a\"; x=\"\r\n.txt", None, "aGk=")).is_ok());
        // An all-whitespace name still produces a part rather than an empty one.
        assert!(upload_form(&upload("   ", None, "aGk=")).is_ok());
    }
}
