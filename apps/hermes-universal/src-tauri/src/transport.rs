//! Generic network transport that runs entirely in Rust (Step 2a).
//!
//! The webview never opens a socket or issues `fetch` itself — it drives this
//! module over IPC. That removes the browser CORS constraint entirely (a native
//! client has no origin policy), so the app can talk to any Hermes/service on
//! the LAN or elsewhere.
//!
//! This is a *thin, generic* pipe on purpose: `http_request` proxies any REST
//! call, and `ws_open`/`ws_send`/`ws_close` proxy a raw WebSocket, forwarding
//! every server frame to the webview as a Tauri event. The JSON-RPC framing and
//! request/response correlation stay in the reused JS `JsonRpcGatewayClient`,
//! which drives this via an IPC-backed `WebSocketLike`.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use reqwest_cookie_store::CookieStoreMutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

const USER_AGENT: &str = concat!("hermes-universal/", env!("CARGO_PKG_VERSION"));

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

    let resp = builder.send().await.map_err(|e| e.to_string())?;
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

/// Open a raw WebSocket. The *client* supplies `id` (a uuid) and subscribes to
/// `ws://{id}/open|message|close|error` BEFORE calling this, so no frame is
/// missed. `origin` is set on the upgrade to whatever the JS caller passes — the
/// gateway client sends `Origin: null` to mirror desktop's file:// renderer (the
/// value Hermes gateways accept for native clients). Sending the gateway's own
/// origin instead is rejected by reverse proxies that guard /api/ws on Origin/Host.
#[tauri::command]
pub async fn ws_open(
    app: AppHandle,
    state: State<'_, TransportState>,
    id: String,
    url: String,
    origin: Option<String>,
) -> Result<(), String> {
    let mut request = url
        .clone()
        .into_client_request()
        .map_err(|e| format!("invalid ws url {url}: {e}"))?;
    if let Some(origin) = origin {
        if let Ok(value) = origin.parse() {
            request.headers_mut().insert("Origin", value);
        }
    }

    let (stream, _resp) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|e| e.to_string())?;
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
                    // Raw byte frames (e.g. the /api/shell-pty terminal's PTY
                    // output) go out on a distinct `/binary` channel as a byte
                    // array — the JSON-RPC gateway client only listens to
                    // `/message` (text), so this never disturbs it; the terminal
                    // socket subscribes to `/binary` and feeds xterm directly.
                    let _ = app_reader.emit(&format!("ws://{id_reader}/binary"), payload.to_vec());
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
#[tauri::command]
pub fn cookies_import(state: State<'_, TransportState>, json: String) -> Result<(), String> {
    let loaded = cookie_store::serde::json::load(json.as_bytes()).map_err(|e| e.to_string())?;
    let mut store = state
        .cookies()
        .lock()
        .map_err(|_| "cookie jar poisoned".to_string())?;
    *store = loaded;
    Ok(())
}
