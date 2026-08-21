//! Generic network transport that runs entirely in Rust (Step 2a).
//!
//! The webview never opens a socket or issues `fetch` itself — it drives this
//! module over IPC. That removes the browser CORS constraint entirely (a native
//! client has no origin policy), so the app can talk to any Allr/service on
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
/// replaced with `***`, and so is a password carried in the userinfo, while
/// scheme, host, path, username and non-secret params (e.g. `profile`) survive so
/// the message still diagnoses something.
///
/// The userinfo half is not hypothetical. The gateway base URL is typed by hand
/// in Settings, `normalizeBaseUrl` (store/connection.ts) keeps whatever was
/// typed, and a gateway behind a basic-auth reverse proxy is reached exactly that
/// way — `https://me:pw@gw.example.com`. reqwest quotes the WHOLE url, userinfo
/// included, into every error it builds, and those errors are rendered on the
/// connect screen.
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

    if url.password().is_some() {
        // Ignorable: `set_password` only refuses on a URL that cannot have a
        // host, and one that cannot have a host cannot have had a password.
        let _ = url.set_password(Some("***"));
    }

    if url.query().is_some() {
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
    }

    url.to_string()
}

/// Where a query value ends. `)` and `>` matter as much as `&`: reqwest writes
/// ` for url (…)`, so a terminator set without them would swallow the closing
/// paren and mangle every message it touched.
fn is_query_value_end(c: char) -> bool {
    c.is_whitespace()
        || matches!(
            c,
            '&' | '"' | '\'' | ';' | ')' | ']' | '}' | ',' | '<' | '>' | '#' | '|'
        )
}

/// Characters that can be part of a parameter NAME, used only to require that a
/// key match starts on a word boundary — so `token=` inside `access_token=` is
/// left to the `access_token=` match, and a field called `mytoken=` is not
/// mistaken for one.
fn is_query_key_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.')
}

/// Scrub `key=value` credential material out of a message whatever shape it
/// arrived in.
///
/// [`redact_error`] can only remove a URL it was handed VERBATIM — and no library
/// hands ours back verbatim. reqwest quotes its own *normalised parse* of the
/// URL, so a base typed as `http://LOCALHOST:5051` comes back as
/// `http://localhost:5051` and the substring test misses entirely; the same goes
/// for a default port reqwest drops or a path it appends a `/` to. This one keys
/// off the parameter NAME, which survives every normalisation, so it holds
/// exactly where the exact-string test does not.
///
/// Deliberately broader than a query-string match (no `[?&]` prefix required): a
/// library is free to quote `token=…` on its own, and over-redacting a diagnostic
/// is the cheaper mistake — the same call `ssh::error::redact_secrets` makes.
fn redact_query_secrets(message: String) -> String {
    let lower = message.to_ascii_lowercase();
    let mut out = String::with_capacity(message.len());
    let mut cursor = 0;

    while cursor < message.len() {
        // The EARLIEST key at or after the cursor, not the first one listed:
        // scrubbing a later `token=` first would move the cursor past an
        // `api_key=` that came before it.
        let hit = SECRET_QUERY_KEYS
            .iter()
            .filter_map(|key| {
                let marker = format!("{key}=");
                let mut from = cursor;

                loop {
                    let at = from + lower[from..].find(&marker)?;

                    if !lower[..at].ends_with(is_query_key_char) {
                        return Some((at, marker.len()));
                    }

                    from = at + marker.len();
                }
            })
            .min_by_key(|(at, _)| *at);

        let Some((at, marker_len)) = hit else {
            break;
        };

        let value_start = at + marker_len;
        let value_end = message[value_start..]
            .find(is_query_value_end)
            .map_or(message.len(), |offset| value_start + offset);

        out.push_str(&message[cursor..value_start]);

        if value_end > value_start {
            out.push_str("***");
        }

        cursor = value_end;
    }

    out.push_str(&message[cursor..]);
    out
}

/// The single exit for every error string this module hands to the webview.
///
/// Both halves are needed and neither subsumes the other: [`redact_bearer`]
/// catches a credential quoted back as an `Authorization` header,
/// [`redact_query_secrets`] catches one carried in a query parameter. A call site
/// that remembered one and forgot the other is precisely how MJXHRM-376 happened,
/// so there is one function to remember instead of two.
pub fn redact_message(message: String) -> String {
    redact_query_secrets(redact_bearer(message))
}

/// Scrub `url` out of a message some library built for us, then run the result
/// through [`redact_message`] regardless.
///
/// reqwest embeds the request URL in EVERY error it builds — transport, decode
/// and body alike (`… for url (…)`) — so an error we merely forward can leak the
/// ws auth param even though we never formatted it in ourselves. Replacing the
/// URL wholesale is the nicer outcome when it lands, because the host, the path
/// and the non-secret params survive it; the funnel is what holds when the URL
/// comes back in any shape but the one we passed in.
pub fn redact_error(message: String, url: &str) -> String {
    let message = if !url.is_empty() && message.contains(url) {
        message.replace(url, &redact_url(url))
    } else {
        message
    };

    redact_message(message)
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
    const MARKER: &str = "bearer";
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
        let after = cursor + hit + MARKER.len();

        // Separator, then value. ALL of the whitespace is skipped rather than
        // one hard-coded space: a library reflowing a header is free to use a
        // tab or two spaces, and matching on `"bearer "` alone is how
        // `Bearer\t<token>` used to walk straight through this function intact.
        let mut start = after;
        while message[start..].starts_with([' ', '\t']) {
            start += 1;
        }

        let end = message[start..]
            .find(|c: char| !is_token68(c))
            .map_or(message.len(), |offset| start + offset);

        out.push_str(&message[cursor..start]);

        // `start > after` demands the separator: without it `bearerToken` would
        // read as the marker plus a credential.
        if start > after && end - start >= MIN_TOKEN_LEN {
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

/// The path namespaces an Allr gateway serves. Used only to decide whether an
/// UNKNOWN origin is worth one keyring lookup — never to decide that a URL is
/// trustworthy. A gateway behind a path prefix (`https://host/hermes`, which the
/// settings copy explicitly supports) matches neither, and is reached the other
/// way: `oauth_status` registers its base the first time the webview probes it.
/// Canonical token-mode session header. Current gateways read this one.
pub(crate) const SESSION_TOKEN_HEADER: &str = "X-Allr-Session-Token";

/// The same header as a gateway built before the Allr rename knows it. Nothing else
/// authenticates against those builds.
pub(crate) const LEGACY_SESSION_TOKEN_HEADER: &str = "X-Hermes-Session-Token"; // rebrand:keep

/// Attach `token` under both header names.
///
/// The backends this is used against — a locally spawned one, a backend reached through
/// an SSH tunnel — are installed and updated on their own schedule, so either spelling
/// may be the only one that gateway reads. Sending both costs a few dozen bytes and
/// removes the need to probe for a version before the first authenticated request; an
/// unknown header is ignored by every server that receives it.
///
/// Mirrors `src/lib/session-token-header.ts`, which does the same for the webview.
pub(crate) fn with_session_token(
    request: reqwest::RequestBuilder,
    token: &str,
) -> reqwest::RequestBuilder {
    request
        .header(SESSION_TOKEN_HEADER, token)
        .header(LEGACY_SESSION_TOKEN_HEADER, token)
}

const GATEWAY_PATH_PREFIXES: &[&str] = &["/api/", "/auth/"];

/// A live raw WebSocket: `tx` feeds the writer task; the two task handles are
/// aborted on close.
pub struct SocketHandle {
    tx: mpsc::UnboundedSender<Message>,
    reader: tokio::task::JoinHandle<()>,
    writer: tokio::task::JoinHandle<()>,
    /// Label of the window that opened this socket. A socket is a real OS
    /// connection owned by this process, not by the WebView — so it needs an
    /// owner to be reaped against when that window dies natively (see
    /// [`reap_window_sockets`]), exactly like a PTY (`pty.rs`).
    owner: String,
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

/// Should a 401 be replayed after forcing a rotation?
///
/// Yes whenever the credential we would send is not the one that was just
/// refused — and "no credential at all" is a different credential. That arm is
/// the one mobile depends on: a refresh that fails drops the stored session
/// (`oauth::ensure_native_tokens`) and returns `None`, and replaying WITHOUT the
/// dead bearer is what lets the gated middleware finally read the cookie session
/// it refuses to look at while an invalid bearer is present.
///
/// No when the rotation handed back the same token, because that is the one case
/// where the replay is guaranteed to be refused identically.
fn bearer_retry_warranted(sent: Option<&str>, rotated: Option<&str>) -> bool {
    rotated != sent
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

/// The response headers the webview is allowed to see.
///
/// `Set-Cookie` is dropped rather than forwarded: the shared jar has already
/// taken it by the time this runs — that is what the cookie store is for — so
/// passing it on would only put the gateway session, the credential MJXHRM-354
/// moved OUT of the webview, back into a JS object on every login response.
/// Nothing in the app reads `HttpResp.headers` at all, let alone for that.
///
/// `set-cookie2` is RFC 2965 and long dead, but a gateway behind an old proxy can
/// still emit it and it holds the same value.
fn visible_response_headers(headers: &reqwest::header::HeaderMap) -> HashMap<String, String> {
    headers
        .iter()
        .filter(|(name, _)| {
            let name = name.as_str();

            !name.eq_ignore_ascii_case("set-cookie") && !name.eq_ignore_ascii_case("set-cookie2")
        })
        .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or_default().to_string()))
        .collect()
}

/// A filename safe to put in a `Content-Disposition` header.
///
/// Quotes and CRLF would otherwise break out of the header — the same guard
/// desktop's bridge applies. Split out from [`upload_form`] because a
/// `multipart::Form` exposes nothing to assert against: a test can only see that
/// it BUILT, which is equally true of one carrying an injected header.
fn safe_upload_filename(raw: &str) -> String {
    let cleaned = raw.replace(['"', '\r', '\n'], "_").trim().to_string();

    if cleaned.is_empty() {
        "file".to_string()
    } else {
        cleaned
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

    let mut part =
        reqwest::multipart::Part::bytes(bytes).file_name(safe_upload_filename(&upload.filename));
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

/// Did a redirect swallow this upload?
///
/// A redirect does not carry a multipart body anywhere. reqwest's redirect
/// middleware downgrades a 301/302/303 POST to a **GET with no body** and
/// follows it (RFC 7231 §6.4.2-4), and `multipart::Form` streams — it cannot be
/// cloned, so 307/308 stop at the 3xx instead. Either way the file never left
/// this process.
///
/// The 301/302/303 half is the dangerous one, because the caller is then handed
/// the redirect target's response as if it were the upload's. On the kanban
/// attachment route that target answers `GET /tasks/<id>/attachments` with a
/// perfectly good `200 {"attachments": […]}` — a silent success for an upload
/// that never happened. A gateway behind an http→https or add-a-trailing-slash
/// proxy is all it takes.
///
/// Comparing the FINAL url against the requested one catches it without any
/// redirect-policy surgery, and cannot fire falsely: an upload that moved was
/// necessarily stripped, since the only redirects reqwest will follow with this
/// body are exactly the ones that discard it.
///
/// Deliberately NOT extended to JSON bodies: a 307/308 replays those correctly
/// (a bytes body clones), so a moved URL there is not evidence of loss.
fn upload_lost_to_redirect(req: &HttpReq, final_url: &reqwest::Url) -> bool {
    req.upload.is_some()
        && reqwest::Url::parse(&req.url).is_ok_and(|requested| &requested != final_url)
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
    // scrub is unconditional. `redact_error` also covers the header itself — this
    // error string is rendered on the connect screen.
    apply_gateway_bearer(builder, bearer)
        .send()
        .await
        .map_err(|e| redact_error(e.to_string(), &req.url))
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
    //
    // The retry fires whenever the credential CHANGED, and "changed to nothing"
    // counts. A refresh that FAILS is the case that matters on mobile: coming back
    // from the background the access token is past its skew, the refresh runs, and
    // if the refresh token has itself expired or rotated away `ensure_native_tokens`
    // drops the stored set and returns None. Requiring `rotated.is_some()` skipped
    // the replay in exactly that case and handed the raw 401 back to the ws-ticket
    // mint, which phrases it as "Session expired — sign in again".
    //
    // That 401 is not the truth about the session. The gated middleware
    // short-circuits on a presented-but-invalid bearer and answers 401 WITHOUT
    // reading the session cookies (`dashboard_auth/middleware.py`), so a live cookie
    // session is invisible on that request. `clear_native_tokens` has already
    // forgotten the base, so the replay below carries no Authorization header at all
    // and the gateway finally falls through to the cookie session it was never
    // allowed to see. Without this, the user recovers by tapping Connect — which is
    // this very replay, performed by hand.
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED && bearer.is_some() {
        if let Some(base) = &auth_base {
            let rotated = crate::oauth::gateway_bearer(&app, state.inner(), base, true).await;

            if bearer_retry_warranted(bearer.as_deref(), rotated.as_deref()) {
                resp = send_http(&state.http, &method, &req, rotated.as_deref()).await?;
            }
        }
    }

    if upload_lost_to_redirect(&req, resp.url()) {
        return Err(format!(
            "{} {} was redirected to {} — a redirect drops the upload, so the file was NOT sent. \
             Point this client at the final URL.",
            method,
            redact_url(&req.url),
            redact_url(resp.url().as_str())
        ));
    }

    let status = resp.status().as_u16();
    let headers = visible_response_headers(resp.headers());
    // reqwest appends ` for url (…)` to EVERY error it builds, decode errors
    // included — so this one leaks the request URL exactly like a send failure
    // would, and takes the same scrub.
    let body = resp
        .text()
        .await
        .map_err(|e| redact_error(e.to_string(), &req.url))?;
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

/// What the reader task does with each frame it takes off the socket.
///
/// A trait rather than the `AppHandle` itself so [`pump_reader`] is drivable
/// without a webview or a live server — which is what makes the invariant this
/// ticket is about ("nothing leaves the read loop unredacted", MJXHRM-376) a
/// testable property of the loop rather than of a helper the loop is merely
/// expected to call.
trait ReaderSink {
    fn text(&self, text: String);
    fn binary(&self, payload: &[u8]);
    fn pong(&self, message: Message);
    fn error(&self, message: String);
    fn close(&self, code: Option<u16>, reason: Option<String>);
}

/// The real sink: Tauri events for text/error/close, the IPC channel for bytes.
///
/// `app.emit` BROADCASTS to every window — session-*, tile-*, sat-* — so anything
/// handed to `error` below is visible app-wide, not just to the window that
/// opened the socket. That is the reason the error arm scrubs.
struct EventSink {
    app: AppHandle,
    id: String,
    binary: Option<Channel<InvokeResponseBody>>,
    pong: mpsc::UnboundedSender<Message>,
}

impl ReaderSink for EventSink {
    fn text(&self, text: String) {
        let _ = self.app.emit(&format!("ws://{}/message", self.id), text);
    }

    fn binary(&self, payload: &[u8]) {
        match self.binary.as_ref() {
            // Preferred: raw bytes over the IPC channel.
            Some(channel) => {
                let _ = send_binary_frame(channel, payload);
            }
            // Legacy: a JSON number array on the old event. Kept for one release
            // so an old JS bundle still gets its frames.
            None => {
                let _ = self
                    .app
                    .emit(&format!("ws://{}/binary", self.id), payload.to_vec());
            }
        }
    }

    fn pong(&self, message: Message) {
        let _ = self.pong.send(message);
    }

    fn error(&self, message: String) {
        let _ = self.app.emit(&format!("ws://{}/error", self.id), message);
    }

    fn close(&self, code: Option<u16>, reason: Option<String>) {
        // Payload is `{code, reason}`, both nullable. The JSON-RPC gateway socket
        // ignores it; the terminal socket uses the code for reconnect decisions
        // and the reason for the end banner.
        let _ = self.app.emit(
            &format!("ws://{}/close", self.id),
            serde_json::json!({ "code": code, "reason": reason }),
        );
    }
}

/// Drive a socket's read half until it ends, feeding `sink`. Always ends with
/// exactly one `close`, whether the socket closed, errored or hit EOF.
///
/// `url` is what the error arm scrubs against. A socket that fails AFTER the
/// handshake is precisely the case where the ws ticket was accepted, so the
/// credential in that URL is live — hence [`redact_error`], never `to_string`.
async fn pump_reader<S>(mut read: S, url: &str, sink: &impl ReaderSink)
where
    S: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    // Close code (e.g. 4401 auth / 4410 child-exit from /api/shell-pty) so the
    // terminal can decide whether to reconnect. `None` on error/EOF exits.
    let mut close_code: Option<u16> = None;
    // The server's close reason, when it sent one. /api/shell-pty puts its
    // refusal sentence here (RFC 6455 caps it at 123 bytes), which is the only
    // way the pane can say WHY a 4404 happened instead of "disabled".
    let mut close_reason: Option<String> = None;

    while let Some(item) = read.next().await {
        match item {
            Ok(Message::Text(text)) => sink.text(text.to_string()),
            Ok(Message::Binary(payload)) => {
                // Raw byte frames — the /api/shell-pty terminal's PTY output and
                // /api/audio/speak-stream's int16 PCM. They go out on their own
                // path, never `/message`, so the JSON-RPC gateway client (text
                // only) is never disturbed.
                sink.binary(&payload);
            }
            Ok(Message::Ping(payload)) => {
                // Split streams don't auto-respond to pings; keepalive by hand.
                sink.pong(Message::Pong(payload));
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
                sink.error(redact_error(err.to_string(), url));
                break;
            }
        }
    }

    sink.close(close_code, close_reason);
}

/// Open a raw WebSocket. The *client* supplies `id` (a uuid) and subscribes to
/// `ws://{id}/open|message|close|error` BEFORE calling this, so no frame is
/// missed. `origin` is set on the upgrade to whatever the JS caller passes — the
/// gateway client sends `Origin: null` to mirror desktop's file:// renderer (the
/// value Allr gateways accept for native clients). Sending the gateway's own
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
    // Taken before `webview` is consumed below: the socket is reaped against the
    // WINDOW, which is what tao reports destroyed (see `reap_window_sockets`).
    let owner = webview.window().label().to_string();
    let binary: Option<Channel<InvokeResponseBody>> =
        binary_channel.map(|channel| channel.channel_on(webview));

    // The URL carries the ws auth param, so it is redacted before it can reach
    // an error string — this one bubbles all the way to $connectionError and is
    // rendered on the connecting screen.
    let mut request = url
        .clone()
        .into_client_request()
        .map_err(|e| redact_message(format!("invalid ws url {}: {e}", redact_url(&url))))?;
    if let Some(origin) = origin {
        if let Ok(value) = origin.parse() {
            request.headers_mut().insert("Origin", value);
        }
    }

    let (stream, _resp) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|e| redact_error(e.to_string(), &url))?;
    let (mut write, read) = stream.split();

    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

    let writer = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if write.send(msg).await.is_err() {
                break;
            }
        }
    });

    let sink = EventSink {
        app: app.clone(),
        id: id.clone(),
        binary,
        pong: tx.clone(),
    };
    // The reader outlives this function, so it needs its own copy of the URL to
    // scrub its errors against — see `pump_reader`'s `Err` arm.
    let url_reader = url.clone();
    let app_reader = app.clone();
    let id_reader = id.clone();
    // The reader waits for its own registry entry before pumping. A socket the
    // server closes immediately would otherwise deregister BEFORE the insert
    // below, leaving a dead handle in the map for the life of the process.
    let (registered_tx, registered_rx) = tokio::sync::oneshot::channel::<()>();
    let reader = tokio::spawn(async move {
        let _ = registered_rx.await;
        pump_reader(read, &url_reader, &sink).await;
        // Drops the sink's `tx` clone, so dropping the handle below is enough to
        // end the writer task too.
        drop(sink);
        deregister_socket(&app_reader, &id_reader).await;
    });

    state.sockets.lock().await.insert(
        id.clone(),
        SocketHandle {
            tx,
            reader,
            writer,
            owner,
        },
    );
    let _ = registered_tx.send(());

    let _ = app.emit(&format!("ws://{id}/open"), ());
    Ok(())
}

/// Forget a socket whose read half has ended.
///
/// Nothing else did: `ws_close` is the only other remover, and the JS side never
/// calls it for a socket the SERVER closed (`transport/tauri-websocket.ts` just
/// marks itself CLOSED on the `/close` event). Every reconnect — the gateway
/// client's, the terminal's, a plugin's — therefore left a `SocketHandle` behind
/// holding a live writer task parked on a channel nothing would ever send to.
async fn deregister_socket(app: &AppHandle, id: &str) {
    use tauri::Manager;

    if let Some(state) = app.try_state::<TransportState>() {
        forget_socket(&state, id).await;
    }
}

/// Drop a socket's handle. Dropping it drops the sender half of the writer's
/// channel, which is what ends the writer TASK — so this frees a task, not just
/// a map entry.
async fn forget_socket(state: &TransportState, id: &str) {
    state.sockets.lock().await.remove(id);
}

/// Take every socket a window owns out of the registry.
fn take_window_sockets(
    sockets: &mut HashMap<String, SocketHandle>,
    label: &str,
) -> Vec<SocketHandle> {
    let ids: Vec<String> = sockets
        .iter()
        .filter(|(_, handle)| handle.owner == label)
        .map(|(id, _)| id.clone())
        .collect();

    ids.into_iter()
        .filter_map(|id| sockets.remove(&id))
        .collect()
}

/// Reap the sockets owned by a destroyed window.
///
/// A natively closed window runs NO JS teardown, so nothing calls `ws_close` for
/// the sockets it opened — and a WebSocket, unlike a `fetch`, survives its
/// WebView: the reader task keeps pumping frames and emitting Tauri events at a
/// window that no longer exists, forever. A detached tile or a satellite left
/// one live gateway/plugin connection per close, and a plugin's `/events` stream
/// keeps the server polling its database for it. Same shape and same reason as
/// `pty::reap_window_ptys` (MJXHRM-373), which is called from the very same arm.
///
/// Called from the `RunEvent::WindowEvent { Destroyed }` arm in `lib.rs`, which
/// is not an async context — hence the detached task.
pub fn reap_window_sockets(app: &AppHandle, label: &str) {
    let app = app.clone();
    let label = label.to_string();

    tauri::async_runtime::spawn(async move {
        use tauri::Manager;

        let Some(state) = app.try_state::<TransportState>() else {
            return;
        };

        let doomed = take_window_sockets(&mut *state.sockets.lock().await, &label);

        for handle in doomed {
            handle.reader.abort();
            handle.writer.abort();
        }
    });
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
/// gateway session (`allr_session_at/_rt`, or `hermes_session_*` from a gateway
/// deployed before the rename) and any portal (Privy) cookie — so a
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
        apply_gateway_bearer, bearer_retry_warranted, caller_set_authorization, forget_socket,
        pump_reader, redact_bearer, redact_error, redact_message, redact_secret, redact_url,
        safe_upload_filename, send_binary_frame, take_window_sockets, upload_form,
        upload_lost_to_redirect, visible_response_headers, HashMap, HttpReq, HttpUpload, Message,
        ReaderSink, SocketHandle, TransportState,
    };

    /// A registry entry shaped exactly like a live one: a writer task parked on
    /// the channel whose sender the handle owns, which is the thing that leaks
    /// when a handle is never dropped.
    fn socket_handle(owner: &str) -> (SocketHandle, Arc<std::sync::atomic::AtomicBool>) {
        let (tx, mut rx) = super::mpsc::unbounded_channel::<Message>();
        let ended = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = ended.clone();

        let writer = tokio::spawn(async move {
            while rx.recv().await.is_some() {}
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
        });

        (
            SocketHandle {
                tx,
                reader: tokio::spawn(async {}),
                writer,
                owner: owner.to_string(),
            },
            ended,
        )
    }

    /// A tungstenite error of the kind the read loop actually sees after the
    /// handshake — an IO failure — rather than a hand-written string.
    fn io_error(message: &str) -> tokio_tungstenite::tungstenite::Error {
        tokio_tungstenite::tungstenite::Error::Io(std::io::Error::other(message.to_string()))
    }

    /// A [`ReaderSink`] that records instead of emitting, standing in for the
    /// windows `app.emit` would broadcast to.
    #[derive(Default)]
    struct RecordingSink {
        text: Mutex<Vec<String>>,
        binary: Mutex<Vec<Vec<u8>>>,
        pongs: Mutex<usize>,
        errors: Mutex<Vec<String>>,
        closes: Mutex<Vec<(Option<u16>, Option<String>)>>,
    }

    impl RecordingSink {
        fn text(&self) -> Vec<String> {
            self.text.lock().unwrap().clone()
        }

        fn binary(&self) -> Vec<Vec<u8>> {
            self.binary.lock().unwrap().clone()
        }

        fn pongs(&self) -> usize {
            *self.pongs.lock().unwrap()
        }

        fn errors(&self) -> Vec<String> {
            self.errors.lock().unwrap().clone()
        }

        fn closes(&self) -> Vec<(Option<u16>, Option<String>)> {
            self.closes.lock().unwrap().clone()
        }
    }

    impl ReaderSink for RecordingSink {
        fn text(&self, text: String) {
            self.text.lock().unwrap().push(text);
        }

        fn binary(&self, payload: &[u8]) {
            self.binary.lock().unwrap().push(payload.to_vec());
        }

        fn pong(&self, _message: Message) {
            *self.pongs.lock().unwrap() += 1;
        }

        fn error(&self, message: String) {
            self.errors.lock().unwrap().push(message);
        }

        fn close(&self, code: Option<u16>, reason: Option<String>) {
            self.closes.lock().unwrap().push((code, reason));
        }
    }

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

    // ── replaying a 401 after a forced rotation ──────────────────────────────

    /// The mobile bug this exists for: the app comes back from the background,
    /// the access token is past its skew, the forced refresh FAILS because the
    /// refresh token has itself expired, and `gateway_bearer` returns None.
    ///
    /// The replay still has to happen. `clear_native_tokens` has already dropped
    /// the dead session and forgotten the base, so the replay carries no
    /// Authorization header — and only then does the gated middleware stop
    /// short-circuiting on the invalid bearer and read the cookie session it was
    /// refusing to look at. Requiring a Some(_) rotation skipped this replay and
    /// turned a live session into "Session expired — sign in again".
    #[test]
    fn replays_without_a_bearer_when_the_refresh_failed_outright() {
        assert!(bearer_retry_warranted(Some("at-dead"), None));
    }

    /// The ordinary case: the rotation produced a different token, so the replay
    /// carries the new one.
    #[test]
    fn replays_with_the_rotated_bearer_when_one_was_minted() {
        assert!(bearer_retry_warranted(Some("at-old"), Some("at-new")));
    }

    /// The one case that must NOT replay. The gateway just refused this exact
    /// token; sending it again buys a second identical 401 and doubles the
    /// latency of every genuine expiry.
    #[test]
    fn does_not_replay_a_token_the_gateway_already_refused() {
        assert!(!bearer_retry_warranted(Some("at-1"), Some("at-1")));
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

        // …and from the OTHER starting point, which is the one that actually
        // needs the `checked` entry cleared: an origin already answered "no
        // session here", then signed into, then signed out of. Registering
        // alone never records a check, so a sign-out that only dropped the
        // KNOWN half would look fine here and strand that user bearer-less.
        state.note_no_bearer_base("https://gw.example.com");
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
        // `data:` is turned away by the path check before the opaque-origin guard
        // is ever consulted, so it proves nothing about that guard. A `file://`
        // URL reaches it: the path DOES start with `/api/`, and its origin
        // serialises to the string "null", which is not an address a gateway can
        // live at — nor one worth waking the keyring for.
        assert_eq!(state.bearer_base_for_url("file:///api/status"), None);
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
    /// already scrubbed. This drives the LOOP, not the helper: the helper being
    /// correct says nothing about the loop calling it, which was the whole bug.
    #[tokio::test]
    async fn the_read_loop_scrubs_the_error_it_emits() {
        let url = "wss://gw.example.com/api/ws?token=s3cr3t-ws-ticket";
        let sink = RecordingSink::default();

        pump_reader(
            futures_util::stream::iter(vec![Err(io_error(&format!(
                "IO error on {url}: connection reset by peer"
            )))]),
            url,
            &sink,
        )
        .await;

        let errors = sink.errors();
        assert_eq!(errors.len(), 1, "the error arm must emit exactly once");
        assert!(!errors[0].contains("s3cr3t-ws-ticket"), "{}", errors[0]);
        assert!(errors[0].contains("token=***"), "{}", errors[0]);
        // Still says what went wrong: a redaction that eats the diagnosis is
        // how a user ends up with "something failed".
        assert!(
            errors[0].contains("connection reset by peer"),
            "{}",
            errors[0]
        );
    }

    /// The same loop, when the URL comes back in a shape the exact-string test
    /// cannot see. This is what `redact_error` alone could not do.
    #[tokio::test]
    async fn the_read_loop_scrubs_a_token_even_when_the_url_is_not_verbatim() {
        let url = "wss://GW.example.com/api/ws?ticket=s3cr3t-ws-ticket";
        // What a library that parsed our URL hands back — host lowercased, so
        // `message.contains(url)` is false and nothing is replaced wholesale.
        let quoted = "wss://gw.example.com/api/ws?ticket=s3cr3t-ws-ticket";
        let sink = RecordingSink::default();

        pump_reader(
            futures_util::stream::iter(vec![Err(io_error(&format!(
                "Unable to connect to {quoted}"
            )))]),
            url,
            &sink,
        )
        .await;

        let errors = sink.errors();
        assert!(!errors[0].contains("s3cr3t-ws-ticket"), "{}", errors[0]);
        assert!(errors[0].contains("ticket=***"), "{}", errors[0]);
    }

    /// The loop must still announce the close after an error, or a pane that
    /// only listens for `/close` hangs on "connecting" forever.
    #[tokio::test]
    async fn the_read_loop_closes_after_an_error_and_forwards_everything_else() {
        let sink = RecordingSink::default();

        pump_reader(
            futures_util::stream::iter(vec![
                Ok(Message::Text("hello".into())),
                Ok(Message::Binary(vec![1, 2, 3])),
                Ok(Message::Ping(vec![9])),
                Err(io_error("connection reset by peer")),
                // Never reached: the error arm breaks.
                Ok(Message::Text("after".into())),
            ]),
            "wss://gw.example.com/api/ws?ticket=x",
            &sink,
        )
        .await;

        assert_eq!(sink.text(), vec!["hello".to_string()]);
        assert_eq!(sink.binary(), vec![vec![1u8, 2, 3]]);
        assert_eq!(sink.pongs(), 1);
        assert_eq!(sink.errors().len(), 1);
        assert_eq!(sink.closes(), vec![(None, None)]);
    }

    /// A server close carries the code and reason the terminal pane needs; the
    /// error arm never fires.
    #[tokio::test]
    async fn the_read_loop_reports_a_server_close_code_and_reason() {
        use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
        use tokio_tungstenite::tungstenite::protocol::CloseFrame;

        let sink = RecordingSink::default();

        pump_reader(
            futures_util::stream::iter(vec![Ok(Message::Close(Some(CloseFrame {
                code: CloseCode::Library(4404),
                reason: "shell-pty is disabled".into(),
            })))]),
            "wss://gw.example.com/api/ws?ticket=x",
            &sink,
        )
        .await;

        assert!(sink.errors().is_empty());
        assert_eq!(
            sink.closes(),
            vec![(Some(4404), Some("shell-pty is disabled".to_string()))]
        );
    }

    // ── the shape of the scrub, not just one string ──────────────────────────

    /// A hand-typed base URL can carry basic-auth userinfo (`https://me:pw@gw`),
    /// which is how a gateway behind a protected reverse proxy is reached — and
    /// reqwest quotes the WHOLE url, userinfo included, into every error.
    #[test]
    fn redacts_a_password_carried_in_the_userinfo() {
        assert_eq!(
            redact_url("https://me:hunter2pw@gw.example.com/api/ws?token=s3cr3t"),
            "https://me:***@gw.example.com/api/ws?token=***"
        );
        // …and with no query at all, which used to return before the userinfo
        // was ever looked at.
        assert_eq!(
            redact_url("https://me:hunter2pw@gw.example.com/api/status"),
            "https://me:***@gw.example.com/api/status"
        );
        // The username is not a secret and identifies which login failed.
        assert_eq!(
            redact_url("https://me@gw.example.com/api/status"),
            "https://me@gw.example.com/api/status"
        );
    }

    /// The userinfo half of a real message. Swapping the URL wholesale is the ONLY
    /// thing that can reach a basic-auth password: it is not a `key=value` pair,
    /// so the shape pass cannot see it.
    #[test]
    fn scrubs_a_basic_auth_password_a_library_quoted_back_at_us() {
        let url = "https://me:hunter2pw@gw.example.com/api/status";
        let message = redact_error(format!("error sending request for url ({url})"), url);

        assert!(!message.contains("hunter2pw"), "{message}");
        assert!(message.contains("me:***@gw.example.com"), "{message}");
    }

    /// The exact-string test is a strict subset of the real condition: no library
    /// hands our URL back verbatim. reqwest quotes its own normalised parse, so
    /// the URL the message carries differs from the one we passed in — and this
    /// builds that parse with reqwest itself rather than assuming its shape.
    #[test]
    fn scrubs_a_token_the_library_normalised_out_of_recognition() {
        let ours = "http://LOCALHOST:5051/api/x?token=s3cr3t";
        let theirs = reqwest::Url::parse(ours).expect("parses").to_string();

        assert_ne!(theirs, ours, "the premise: the parse is not the input");

        let message = redact_error(format!("error sending request for url ({theirs})"), ours);

        assert!(!message.contains("s3cr3t"), "{message}");
        assert!(message.contains("token=***"), "{message}");
        // The closing paren of reqwest's own wording survives — a terminator set
        // that swallowed it would mangle every message this touched.
        assert!(message.ends_with(')'), "{message}");
    }

    #[test]
    fn scrubs_every_secret_query_key_wherever_it_appears() {
        // No `?` or `&` in front: a library is free to quote a parameter on its
        // own, and that is exactly the case an anchored match misses.
        assert_eq!(
            redact_message("refused ticket=abc123 for api_key=zzz".to_string()),
            "refused ticket=*** for api_key=***"
        );
        // `token=` inside `access_token=` is left to the longer key, so the value
        // is redacted once and the parameter name survives intact.
        assert_eq!(
            redact_message("?access_token=abc&profile=work".to_string()),
            "?access_token=***&profile=work"
        );
    }

    #[test]
    fn leaves_a_field_that_merely_ends_in_a_secret_key_alone() {
        // `mytoken` is not `token`, and shredding unrelated diagnostics is how a
        // redactor stops being read.
        assert_eq!(
            redact_message("mytoken=visible".to_string()),
            "mytoken=visible"
        );
        assert_eq!(
            redact_message("no value here token= and on".to_string()),
            "no value here token= and on"
        );
    }

    #[test]
    fn scrubs_a_bearer_however_the_library_spaced_it() {
        // A tab, or two spaces, is still a header value. Matching on `"bearer "`
        // alone let both through whole.
        assert_eq!(
            redact_bearer("Authorization: Bearer\teyJhbGciOi.J9.sig".to_string()),
            "Authorization: Bearer\t***"
        );
        assert_eq!(
            redact_bearer("Authorization: Bearer  eyJhbGciOi.J9.sig".to_string()),
            "Authorization: Bearer  ***"
        );
        // No separator at all is not a credential — it is a longer word. The run
        // after the marker is deliberately long enough to pass the length test,
        // so only the separator requirement can save it.
        assert_eq!(
            redact_bearer("bearerTokenIsMissing".to_string()),
            "bearerTokenIsMissing"
        );
    }

    /// The gateway session cookie is the credential MJXHRM-354 took out of the
    /// webview; handing it straight back on the response of the login that set it
    /// would undo that on every sign-in.
    #[test]
    fn the_response_headers_the_webview_sees_carry_no_set_cookie() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert("content-type", "application/json".parse().unwrap());
        headers.append(
            "set-cookie",
            "allr_session_rt=s3cr3t; HttpOnly".parse().unwrap(),
        );
        headers.append("Set-Cookie", "allr_session_at=s3cr3t2".parse().unwrap());
        headers.append("set-cookie2", "legacy=s3cr3t3".parse().unwrap());

        let visible = visible_response_headers(&headers);

        assert_eq!(
            visible.get("content-type").map(String::as_str),
            Some("application/json")
        );
        assert!(
            visible
                .keys()
                .all(|name| !name.to_ascii_lowercase().starts_with("set-cookie")),
            "{visible:?}"
        );
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
    ///
    /// Asserted against the sanitised NAME, not against `is_ok()`: a form
    /// carrying an injected header builds exactly as happily as a clean one, so
    /// the old shape of this test passed with the guard deleted.
    #[test]
    fn upload_form_survives_a_hostile_filename() {
        assert_eq!(safe_upload_filename("a\"; x=\"\r\n.txt"), "a_; x=___.txt");
        assert!(upload_form(&upload("a\"; x=\"\r\n.txt", None, "aGk=")).is_ok());
        // An all-whitespace name still produces a part rather than an empty one.
        assert_eq!(safe_upload_filename("   "), "file");
        assert_eq!(safe_upload_filename(""), "file");
        assert!(upload_form(&upload("   ", None, "aGk=")).is_ok());
        // An ordinary name is left exactly as it was.
        assert_eq!(safe_upload_filename("notes.txt"), "notes.txt");
    }

    fn upload_req(url: &str) -> HttpReq {
        HttpReq {
            method: "POST".to_string(),
            url: url.to_string(),
            headers: HashMap::new(),
            body: None,
            upload: Some(upload("a.txt", None, "aGk=")),
            timeout_ms: None,
        }
    }

    /// A 301/302/303 turns the POST into a bodiless GET and follows it, so the
    /// file never leaves — and on the kanban attachment route the GET that lands
    /// instead answers `200 {"attachments": […]}`, which the caller cannot tell
    /// from a completed upload.
    #[test]
    fn an_upload_that_moved_is_a_failure_not_a_result() {
        let req = upload_req("http://gw.local/api/plugins/kanban/tasks/t1/attachments");

        assert!(upload_lost_to_redirect(
            &req,
            &reqwest::Url::parse("https://gw.local/api/plugins/kanban/tasks/t1/attachments")
                .unwrap()
        ));
        assert!(upload_lost_to_redirect(
            &req,
            &reqwest::Url::parse("http://gw.local/api/plugins/kanban/tasks/t1/attachments/")
                .unwrap()
        ));
    }

    #[test]
    fn an_upload_that_stayed_put_is_untouched() {
        let req = upload_req("http://gw.local/api/plugins/kanban/tasks/t1/attachments");

        assert!(!upload_lost_to_redirect(
            &req,
            &reqwest::Url::parse("http://gw.local/api/plugins/kanban/tasks/t1/attachments")
                .unwrap()
        ));
        // Normalisation is not relocation: reqwest hands back the parsed url, so
        // the comparison has to be parsed-to-parsed or every upload would fail.
        let req = upload_req("http://gw.local:80/api/plugins/kanban/x?board=b");

        assert!(!upload_lost_to_redirect(
            &req,
            &reqwest::Url::parse("http://gw.local/api/plugins/kanban/x?board=b").unwrap()
        ));
    }

    /// A JSON body clones, so a 307/308 replays it correctly — a moved url there
    /// is not evidence of loss, and erroring would break FastAPI's own
    /// add-the-trailing-slash redirect.
    #[test]
    fn a_json_body_that_moved_is_left_alone() {
        let mut req = upload_req("http://gw.local/api/sessions");
        req.upload = None;
        req.body = Some(serde_json::json!({ "a": 1 }));

        assert!(!upload_lost_to_redirect(
            &req,
            &reqwest::Url::parse("http://gw.local/api/sessions/").unwrap()
        ));
    }

    /// MJXHRM-405. The read half ending is the ONLY signal for a socket the
    /// server closed — the JS side never calls `ws_close` for one — so the
    /// reader deregisters itself. Without that, every reconnect (gateway client,
    /// terminal, plugin `/events`) left a handle in the map holding a writer task
    /// parked forever on a channel nothing could ever send to.
    #[tokio::test]
    async fn forgetting_a_socket_ends_its_writer_task() {
        let state = TransportState::new();
        let (handle, writer_ended) = socket_handle("main");

        state.sockets.lock().await.insert("s1".into(), handle);

        forget_socket(&state, "s1").await;
        // The writer wakes when the handle's sender is dropped.
        tokio::task::yield_now().await;

        assert!(state.sockets.lock().await.is_empty());
        assert!(
            writer_ended.load(std::sync::atomic::Ordering::SeqCst),
            "dropping the handle must end the writer task, not just free a map entry"
        );
    }

    /// MJXHRM-405. A natively closed window runs no JS teardown, so its sockets
    /// are reaped by owner — and ONLY its own: the surviving windows' sockets
    /// (the main window's gateway stream above all) must not go with it.
    #[tokio::test]
    async fn reaping_a_window_takes_only_that_window_s_sockets() {
        let mut sockets: HashMap<String, SocketHandle> = HashMap::new();

        for (id, owner) in [
            ("gateway", "main"),
            ("tile-ws", "tile-abc"),
            ("tile-plugin-events", "tile-abc"),
        ] {
            sockets.insert(id.to_string(), socket_handle(owner).0);
        }

        let doomed = take_window_sockets(&mut sockets, "tile-abc");

        assert_eq!(doomed.len(), 2);
        assert_eq!(sockets.keys().collect::<Vec<_>>(), vec!["gateway"]);
        // Reaping a window with nothing open is a no-op, not a wipe.
        assert!(take_window_sockets(&mut sockets, "sat-xyz").is_empty());
        assert_eq!(sockets.len(), 1);
    }
}
