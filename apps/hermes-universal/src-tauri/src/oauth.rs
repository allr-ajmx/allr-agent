//! Connection-level gateway OAuth (Track D3) — two flows, one command.
//!
//! # RFC 8252 native flow (preferred, MJXHRM-77)
//!
//! When `/api/status` advertises `auth_flows: [... "native_pkce"]` the gateway can
//! broker a real native-app login: system browser + client-side PKCE + a loopback
//! redirect, ending in bearer tokens handed to us in a JSON body with no cookie
//! anywhere. That is strictly better than the webview flow below:
//!
//!   * **No second webview.** The system browser is a separate app, so mobile —
//!     which cannot open a usable second webview window at all — needs no
//!     navigate-away hack and no pending-marker resume for this path.
//!   * **No cookie plumbing.** Nothing has to be scraped out of a webview jar and
//!     replayed into reqwest; the gated middleware accepts
//!     `Authorization: Bearer` on every non-public route, ws-ticket included.
//!   * **The credential is ours.** We hold and rotate the refresh token
//!     (`/auth/native/refresh`) instead of depending on transparent cookie
//!     rotation we cannot see.
//!
//! Server side: `hermes_cli/dashboard_auth/routes.py` (`/auth/native/authorize`,
//! `/auth/native/token`, `/auth/native/refresh`) plus `native_flow.py`. The pure
//! half of the client — PKCE, state, URL building, callback parsing, token
//! parsing, refresh math — lives in [`native`] and is unit-tested; only the
//! socket/browser/HTTP I/O sits out here.
//!
//! # Legacy webview-cookie flow (fallback)
//!
//! Mirrors Hermes desktop (Electron), which binds an OAuth `BrowserWindow` to a
//! persistent session partition, runs the WHOLE login there, and polls that jar
//! for the session cookie. Tauri doesn't auto-share cookies between a webview and
//! reqwest, and the gateway's `redirect_uri` is always a same-origin
//! `{base}/auth/callback` https URL (never a custom scheme), so a deep-link
//! callback is impossible — and intercepting the callback to replay it via reqwest
//! is fragile on WebKitGTK (the redirect chain doesn't reliably fire
//! `on_navigation`/`on_page_load`).
//!
//! So we let the interactive webview complete the ENTIRE cascade itself
//! (`/auth/login` → IDP → `/auth/callback` → dashboard), which lands the session
//! cookies (`hermes_session_at`/`_rt`, HttpOnly) in the WEBVIEW's cookie jar, then:
//!
//!   1. Open a `WebviewWindow` at `{base}/auth/login?provider=X` (sets the
//!      webview's own PKCE cookie and goes straight to the provider).
//!   2. Poll the webview's cookie jar for `{base}` (`webview_cookies::cookies_for_base`)
//!      — on WebKitGTK this reads the libsoup/WebKit cookie manager (HttpOnly cookies
//!      included, unlike `document.cookie`) — until the session cookie appears.
//!   3. Import those cookies into the SHARED reqwest jar via `insert_raw`, so the
//!      ws-ticket mint (driven from JS via `http_request`) is authenticated. Then
//!      close the window.
//!
//! A timeout backstops the poll so a missed / abandoned login can't hang connect().
//!
//! The fallback is not dead weight: a gateway with only a password provider, or
//! any build older than the native routes, advertises no `native_pkce` and keeps
//! working exactly as before.

use serde::Serialize;
use tauri::{AppHandle, Manager, State, Url, WebviewWindow};
// Desktop opens a dedicated sign-in window; mobile reuses the CALLING webview
// (see `oauth_login`), so these are only referenced on desktop.
#[cfg(desktop)]
use tauri::{WebviewUrl, WebviewWindowBuilder};
#[cfg(desktop)]
use tokio::sync::oneshot;

use crate::transport::TransportState;

/// The single label for the interactive sign-in window (desktop). Reused (closed +
/// rebuilt) across attempts so a stale window never lingers. Not used on mobile, which
/// drives the login through the calling webview instead of a second window.
#[cfg(desktop)]
const OAUTH_WINDOW_LABEL: &str = "hermes-oauth";

/// How long to wait for the interactive login before giving up (desktop: the app UI
/// stays put behind the sign-in window, so a generous window is fine).
#[cfg(desktop)]
const OAUTH_TIMEOUT_SECS: u64 = 300;

/// Mobile runs the login in the calling webview, which replaces the entire app UI for the
/// duration (no in-app cancel until this elapses), so keep the wait tighter than desktop.
#[cfg(mobile)]
const OAUTH_TIMEOUT_SECS_MOBILE: u64 = 120;

fn normalize_base(raw: &str) -> String {
    raw.trim().trim_end_matches('/').to_string()
}

/// How long a mobile sign-in navigation gets to at least *commit* before we call it
/// refused.
///
/// Generous on purpose. The check below is a false-positive risk, not a false-negative
/// one: a slow gateway that simply hasn't answered yet must never be reported as
/// blocked. Ten seconds is far longer than any reachable host needs to commit a
/// navigation, and still turns a dead sign-in from a two-minute silence into an
/// immediate, nameable error.
#[cfg(mobile)]
const NAVIGATION_SETTLE_SECS: u64 = 10;

/// Did the webview actually leave the app for the sign-in page?
///
/// A refused navigation is otherwise completely silent. `WebviewWindow::navigate`
/// returns `Ok(())` as soon as the message is queued — the load result never comes back
/// to the caller, and the only trace is a `log::error!` from inside wry's event loop.
/// So a login the platform refused outright looks exactly like a login the user simply
/// hasn't finished, and the flow spends its whole timeout polling for a cookie that can
/// never arrive.
///
/// The concrete case this was written for: iOS App Transport Security silently refuses
/// every cleartext `http://` load in WKWebView, which is most self-hosted gateways
/// (a LAN address, a Tailscale IP). `Info.ios.plist` now carries the
/// `NSAllowsArbitraryLoadsInWebContent` exception, so that specific cause is fixed —
/// this stays because "the webview would not go there" has other causes (an untrusted
/// certificate, a host that never answers) and all of them presented identically.
///
/// Answers "did it move", not "did it load". Both platforms set the webview URL when a
/// navigation *commits*, well before the page finishes, and a page that commits and then
/// fails is a normal failure the poll handles. Only a URL that never changed at all
/// means the navigation was rejected before it began.
#[cfg(mobile)]
pub(crate) async fn navigation_committed(webview: &tauri::WebviewWindow, from: &Url) -> bool {
    tokio::time::sleep(std::time::Duration::from_secs(NAVIGATION_SETTLE_SECS)).await;

    // An unreadable URL is not evidence of a refusal — say "committed" and let the
    // normal poll and its timeout have the final word.
    webview.url().map(|now| now != *from).unwrap_or(true)
}

/// The error a refused navigation reports, in place of a bare timeout.
#[cfg(mobile)]
pub(crate) fn navigation_refused(url: &Url) -> String {
    format!(
        "The sign-in page at {url} could not be opened. The system webview refused to \
         load it — most often an untrusted certificate, or a host that cannot be reached \
         from this device."
    )
}

/// The pure half of the RFC 8252 native flow: everything that is a decision or a
/// transformation rather than I/O. Split out precisely so it can be tested —
/// `oauth_login` itself needs a webview, a socket and a browser, and none of the
/// subtle parts (S256 derivation, the `state` check, single-line HTTP target
/// parsing, refresh-window math) should be reachable only through that.
pub mod native {
    use base64::Engine as _;
    use sha2::{Digest, Sha256};

    /// The capability token `/api/status` advertises in `auth_flows` when the
    /// gateway can broker a native-app login (`hermes_cli/web_server.py`).
    pub const NATIVE_FLOW_ID: &str = "native_pkce";

    /// Path our loopback listener answers on. Any path is legal (the gateway only
    /// pins the host), but a fixed one keeps the callback parser honest.
    pub const CALLBACK_PATH: &str = "/callback";

    /// Refresh this long before the access token actually expires, so a request in
    /// flight can't land on the far side of the boundary.
    pub const REFRESH_SKEW_SECS: i64 = 60;

    fn b64url(bytes: &[u8]) -> String {
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
    }

    /// An RFC 7636 PKCE pair. Only S256 is produced — the gateway rejects `plain`
    /// outright (`routes.py::auth_native_authorize`), and so should we.
    #[derive(Clone, Debug, PartialEq, Eq)]
    pub struct PkcePair {
        pub verifier: String,
        pub challenge: String,
    }

    /// Derive a pair from caller-supplied entropy. Split from [`generate_pkce`] so
    /// the derivation can be tested against a fixed seed rather than "it ran".
    pub fn pkce_from_entropy(entropy: &[u8]) -> PkcePair {
        let verifier = b64url(entropy);
        let challenge = b64url(&Sha256::digest(verifier.as_bytes()));

        PkcePair {
            verifier,
            challenge,
        }
    }

    fn random_bytes(len: usize) -> Result<Vec<u8>, String> {
        let mut buf = vec![0u8; len];
        getrandom::getrandom(&mut buf)
            .map_err(|e| format!("no secure randomness available: {e}"))?;

        Ok(buf)
    }

    /// 32 bytes of entropy → a 43-char verifier, the RFC 7636 minimum length and
    /// the same width desktop's `native-oauth.ts` uses.
    pub fn generate_pkce() -> Result<PkcePair, String> {
        Ok(pkce_from_entropy(&random_bytes(32)?))
    }

    /// CSRF `state`. Distinct from the verifier: it round-trips through the browser
    /// in the clear, so it must carry no relationship to the PKCE secret.
    pub fn generate_state() -> Result<String, String> {
        Ok(b64url(&random_bytes(24)?))
    }

    /// Does this `/api/status` body advertise the native flow? Absent or malformed
    /// ⇒ `false` ⇒ the caller falls back to the webview-cookie flow, which is how
    /// an older gateway keeps working without a version check.
    pub fn supports_native_flow(status: &serde_json::Value) -> bool {
        status
            .get("auth_flows")
            .and_then(|v| v.as_array())
            .is_some_and(|flows| flows.iter().any(|f| f.as_str() == Some(NATIVE_FLOW_ID)))
    }

    /// The loopback `redirect_uri` for a bound port. Deliberately the IP literal,
    /// never `localhost`: the gateway rejects the name (RFC 8252 §8.3 — it can
    /// resolve off-loopback via hosts file or a hostile resolver) and treats this
    /// as a security boundary, not ergonomics.
    pub fn loopback_redirect_uri(port: u16) -> String {
        format!("http://127.0.0.1:{port}{CALLBACK_PATH}")
    }

    fn encode_query_value(raw: &str) -> String {
        let mut out = String::with_capacity(raw.len());

        for byte in raw.bytes() {
            match byte {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                    out.push(byte as char)
                }
                _ => out.push_str(&format!("%{byte:02X}")),
            }
        }

        out
    }

    /// Build the `/auth/native/authorize` URL opened in the system browser.
    /// `provider` may be empty — the gateway auto-selects when exactly one session
    /// provider is registered, so we do not have to hardcode a name.
    pub fn build_authorize_url(
        base: &str,
        challenge: &str,
        redirect_uri: &str,
        state: &str,
        provider: &str,
    ) -> String {
        let mut url = format!(
            "{}/auth/native/authorize?code_challenge={}&code_challenge_method=S256&redirect_uri={}&state={}",
            base.trim_end_matches('/'),
            encode_query_value(challenge),
            encode_query_value(redirect_uri),
            encode_query_value(state)
        );

        if !provider.is_empty() {
            url.push_str(&format!("&provider={}", encode_query_value(provider)));
        }

        url
    }

    fn percent_decode(raw: &str) -> String {
        let bytes = raw.as_bytes();
        let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
        let mut i = 0;

        while i < bytes.len() {
            match bytes[i] {
                b'%' if i + 2 < bytes.len() => {
                    let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");

                    match u8::from_str_radix(hex, 16) {
                        Ok(byte) => {
                            out.push(byte);
                            i += 3;
                        }
                        Err(_) => {
                            out.push(bytes[i]);
                            i += 1;
                        }
                    }
                }
                b'+' => {
                    out.push(b' ');
                    i += 1;
                }
                byte => {
                    out.push(byte);
                    i += 1;
                }
            }
        }

        String::from_utf8_lossy(&out).into_owned()
    }

    /// Parse the request target of the browser's callback hit
    /// (`/callback?code=…&state=…`) and return the authorization code.
    ///
    /// The `state` comparison is the whole point of this function: without it any
    /// process that can reach our loopback port could feed us a code minted for a
    /// different login. A gateway-side `?error=` is surfaced as-is.
    pub fn parse_callback_target(target: &str, expected_state: &str) -> Result<String, String> {
        let query = target.split_once('?').map(|(_, q)| q).unwrap_or("");
        let mut code = String::new();
        let mut state = String::new();
        let mut error = String::new();

        for pair in query.split('&').filter(|p| !p.is_empty()) {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));

            match key {
                "code" => code = percent_decode(value),
                "state" => state = percent_decode(value),
                "error" => error = percent_decode(value),
                _ => {}
            }
        }

        if !error.is_empty() {
            return Err(format!("sign-in was refused: {error}"));
        }

        // Constant-ish comparison is overkill here (the state is single-use and
        // lives for one login), but an empty expected state must never match.
        if expected_state.is_empty() || state != expected_state {
            return Err("sign-in callback did not match this request".to_string());
        }

        if code.is_empty() {
            return Err("sign-in callback carried no authorization code".to_string());
        }

        Ok(code)
    }

    /// Bearer credentials for one gateway, as `/auth/native/token` returns them.
    /// Serialized into the OS keyring; `expires_at` is a UNIX timestamp in seconds.
    #[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
    pub struct NativeTokenSet {
        pub access_token: String,
        pub refresh_token: String,
        pub expires_at: i64,
        #[serde(default)]
        pub provider: String,
        #[serde(default)]
        pub user_id: String,
    }

    /// Read a `/auth/native/token` (or `/auth/native/refresh`) body. Both routes
    /// return the same shape. A response without an access token is an error
    /// rather than a half-populated set we would later present as a live session.
    pub fn parse_token_response(body: &serde_json::Value) -> Result<NativeTokenSet, String> {
        let string = |key: &str| {
            body.get(key)
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string()
        };

        let access_token = string("access_token");

        if access_token.is_empty() {
            return Err("token response carried no access_token".to_string());
        }

        Ok(NativeTokenSet {
            access_token,
            refresh_token: string("refresh_token"),
            expires_at: body.get("expires_at").and_then(|v| v.as_i64()).unwrap_or(0),
            provider: string("provider"),
            user_id: string("user_id"),
        })
    }

    /// Is the access token close enough to expiry to rotate first? An unknown
    /// (`0`) expiry counts as "needs refresh" — we would rather spend a refresh
    /// round trip than hand a dead bearer to the ws-ticket mint.
    pub fn needs_refresh(tokens: &NativeTokenSet, now_secs: i64) -> bool {
        tokens.expires_at <= now_secs + REFRESH_SKEW_SECS
    }

    /// Keyring account name for one gateway's tokens. Namespaced so it can never
    /// collide with the existing `token` / `cookies` / `sshKey` entries the JS
    /// side writes under the same service, and keyed by base URL so two gateways
    /// keep separate sessions.
    pub fn keyring_account(base: &str) -> String {
        format!("nativeAuth:{}", base.trim_end_matches('/'))
    }

    /// The one-page reply the browser shows after the redirect. It must never
    /// contain the code — the browser has it in its address bar already, but the
    /// page itself is the thing screen-shared or left open.
    pub fn callback_response(ok: bool) -> String {
        let body = if ok {
            "<h1>Signed in</h1><p>You can close this tab and return to Hermes.</p>"
        } else {
            "<h1>Sign-in failed</h1><p>Return to Hermes and try again.</p>"
        };

        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        )
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn derives_the_s256_challenge_from_the_verifier() {
            // RFC 7636 appendix B's vector: the verifier below hashes to the
            // published challenge. Pinning it proves we hash the ASCII VERIFIER,
            // not the raw entropy — the classic way to get PKCE subtly wrong.
            let pair = pkce_from_entropy(&[
                116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22,
                212, 37, 77, 105, 214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121,
            ]);

            assert_eq!(pair.verifier, "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
            assert_eq!(
                pair.challenge,
                "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
            );
        }

        #[test]
        fn a_generated_verifier_is_the_rfc_minimum_length_and_url_safe() {
            let pair = generate_pkce().expect("entropy");

            assert_eq!(pair.verifier.len(), 43);
            assert!(pair
                .verifier
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
            assert_ne!(pair.verifier, pair.challenge);
        }

        #[test]
        fn two_states_never_repeat() {
            assert_ne!(generate_state().unwrap(), generate_state().unwrap());
        }

        #[test]
        fn native_support_is_read_off_auth_flows() {
            let yes = serde_json::json!({ "auth_flows": ["cookie", "native_pkce"] });
            let cookie_only = serde_json::json!({ "auth_flows": ["cookie"] });
            let older = serde_json::json!({ "auth_required": true });

            assert!(supports_native_flow(&yes));
            assert!(!supports_native_flow(&cookie_only));
            // An older gateway never says native_pkce — falling back is the point.
            assert!(!supports_native_flow(&older));
            assert!(!supports_native_flow(
                &serde_json::json!({ "auth_flows": "native_pkce" })
            ));
        }

        #[test]
        fn the_redirect_uri_is_a_loopback_ip_literal_never_localhost() {
            // The gateway rejects `localhost` outright (RFC 8252 §8.3).
            assert_eq!(
                loopback_redirect_uri(51234),
                "http://127.0.0.1:51234/callback"
            );
        }

        #[test]
        fn the_authorize_url_pins_s256_and_escapes_its_parameters() {
            let url = build_authorize_url(
                "https://gw.example.com/",
                "chal+lenge/=",
                "http://127.0.0.1:5123/callback",
                "st ate",
                "nous",
            );

            assert!(url.starts_with("https://gw.example.com/auth/native/authorize?"));
            assert!(url.contains("code_challenge_method=S256"));
            assert!(url.contains("code_challenge=chal%2Blenge%2F%3D"));
            assert!(url.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A5123%2Fcallback"));
            assert!(url.contains("state=st%20ate"));
            assert!(url.contains("provider=nous"));
        }

        #[test]
        fn an_empty_provider_is_omitted_so_the_gateway_can_auto_select() {
            let url =
                build_authorize_url("https://gw", "c", "http://127.0.0.1:1/callback", "s", "");

            assert!(!url.contains("provider="));
        }

        #[test]
        fn the_callback_yields_its_code_when_the_state_matches() {
            let code = parse_callback_target("/callback?code=abc123&state=xyz", "xyz").unwrap();

            assert_eq!(code, "abc123");
        }

        #[test]
        fn a_mismatched_or_missing_state_is_refused() {
            // This is the CSRF boundary: anything that can reach the loopback port
            // could otherwise inject a code minted for someone else's login.
            assert!(parse_callback_target("/callback?code=abc&state=other", "xyz").is_err());
            assert!(parse_callback_target("/callback?code=abc", "xyz").is_err());
            // An empty expected state must never match an empty callback state.
            assert!(parse_callback_target("/callback?code=abc&state=", "").is_err());
        }

        #[test]
        fn a_gateway_error_redirect_is_surfaced_rather_than_swallowed() {
            let err = parse_callback_target("/callback?error=access_denied&state=xyz", "xyz")
                .unwrap_err();

            assert!(err.contains("access_denied"));
        }

        #[test]
        fn a_state_match_with_no_code_is_still_an_error() {
            assert!(parse_callback_target("/callback?state=xyz", "xyz").is_err());
        }

        #[test]
        fn percent_escapes_in_the_callback_are_decoded() {
            let code =
                parse_callback_target("/callback?code=a%2Fb%2Bc&state=x%20y", "x y").unwrap();

            assert_eq!(code, "a/b+c");
        }

        #[test]
        fn parses_the_token_response_the_gateway_documents() {
            let set = parse_token_response(&serde_json::json!({
                "access_token": "at",
                "refresh_token": "rt",
                "token_type": "Bearer",
                "expires_at": 1_800_000_000i64,
                "provider": "nous",
                "user_id": "u1"
            }))
            .unwrap();

            assert_eq!(set.access_token, "at");
            assert_eq!(set.refresh_token, "rt");
            assert_eq!(set.expires_at, 1_800_000_000);
            assert_eq!(set.provider, "nous");
        }

        #[test]
        fn a_token_response_without_an_access_token_is_rejected() {
            assert!(parse_token_response(&serde_json::json!({ "refresh_token": "rt" })).is_err());
            assert!(parse_token_response(&serde_json::Value::Null).is_err());
        }

        #[test]
        fn refresh_fires_inside_the_skew_window_and_on_an_unknown_expiry() {
            let set = |expires_at| NativeTokenSet {
                access_token: "at".into(),
                refresh_token: "rt".into(),
                expires_at,
                provider: String::new(),
                user_id: String::new(),
            };

            assert!(!needs_refresh(&set(1_000 + REFRESH_SKEW_SECS + 1), 1_000));
            assert!(needs_refresh(&set(1_000 + REFRESH_SKEW_SECS), 1_000));
            assert!(needs_refresh(&set(500), 1_000));
            // A response with no expires_at must not read as "valid forever".
            assert!(needs_refresh(&set(0), 1_000));
        }

        #[test]
        fn keyring_accounts_are_namespaced_and_per_gateway() {
            assert_eq!(
                keyring_account("https://a.example/"),
                "nativeAuth:https://a.example"
            );
            assert_ne!(
                keyring_account("https://a.example"),
                keyring_account("https://b.example")
            );
            // Must not collide with the JS-side entries under the same service.
            assert_ne!(keyring_account("https://a.example"), "cookies");
        }

        #[test]
        fn the_browser_reply_never_echoes_the_authorization_code() {
            let page = callback_response(true);

            assert!(page.contains("Content-Length:"));
            assert!(!page.contains("code="));
        }
    }
}

// ── RFC 8252 native flow: the I/O half ───────────────────────────────────────

/// How long the loopback listener waits for the browser redirect. The user is in
/// a browser tab, possibly signing in with a second factor — be generous, but
/// never wait forever: an abandoned login must not pin a socket for the session.
const NATIVE_LOGIN_TIMEOUT_SECS: u64 = 300;

/// The keyring service the JS side already uses (`src/lib/secure-store.ts`).
/// Shared deliberately: one service, one OS credential group the user can revoke.
const KEYRING_SERVICE: &str = "hermes";

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// The keyring is initialized lazily by whichever side touches it first, so every
/// Rust-side access re-asserts the service name. `initialize_service` is idempotent.
fn keyring_ready(app: &AppHandle) -> bool {
    use tauri_plugin_keyring::KeyringExt;

    app.keyring()
        .initialize_service(KEYRING_SERVICE.to_string())
        .is_ok()
}

fn store_native_tokens(
    app: &AppHandle,
    state: &TransportState,
    base: &str,
    tokens: &native::NativeTokenSet,
) {
    use tauri_plugin_keyring::{CredentialType, CredentialValue, KeyringExt};

    // Registered even when the keyring write below fails: the token set is live
    // for this run either way, and the transport has to know to attach it.
    state.register_bearer_base(base);

    if !keyring_ready(app) {
        log::warn!("[oauth] keyring unavailable; native session will not survive restart");
        return;
    }

    let Ok(json) = serde_json::to_string(tokens) else {
        return;
    };

    if let Err(e) = app.keyring().set(
        &native::keyring_account(base),
        CredentialType::Password,
        CredentialValue::Password(json),
    ) {
        // Never log the payload — it IS the session. The error alone is enough.
        log::warn!("[oauth] could not persist native tokens: {e}");
    }
}

fn load_native_tokens(app: &AppHandle, base: &str) -> Option<native::NativeTokenSet> {
    use tauri_plugin_keyring::{CredentialType, CredentialValue, KeyringExt};

    if !keyring_ready(app) {
        return None;
    }

    let value = app
        .keyring()
        .get(&native::keyring_account(base), CredentialType::Password)
        .ok()?;

    let CredentialValue::Password(json) = value else {
        return None;
    };

    serde_json::from_str(&json).ok()
}

fn clear_native_tokens(app: &AppHandle, state: &TransportState, base: &str) {
    use tauri_plugin_keyring::{CredentialType, KeyringExt};

    state.forget_bearer_base(base);

    if keyring_ready(app) {
        let _ = app
            .keyring()
            .delete(&native::keyring_account(base), CredentialType::Password);
    }
}

/// Does this gateway advertise the native flow? A probe failure answers "no" —
/// falling back to the webview flow is always safe, whereas guessing "yes" on a
/// gateway that cannot broker would strand the user in a browser tab.
async fn advertises_native_flow(state: &TransportState, base: &str) -> bool {
    let Ok(resp) = state
        .client()
        .get(format!("{base}/api/status"))
        .send()
        .await
    else {
        return false;
    };

    if !resp.status().is_success() {
        return false;
    }

    resp.json::<serde_json::Value>()
        .await
        .map(|body| native::supports_native_flow(&body))
        .unwrap_or(false)
}

/// Serve exactly one loopback request and return its authorization code.
///
/// Only the request line is read — the code is in the target, and reading further
/// would mean parsing a body we have no use for. The reply is a static page: the
/// browser must never be handed anything that echoes the code back.
async fn await_loopback_code(
    listener: tokio::net::TcpListener,
    expected_state: &str,
) -> Result<String, String> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let accept = async {
        loop {
            let (stream, _) = listener
                .accept()
                .await
                .map_err(|e| format!("loopback listener failed: {e}"))?;

            let mut reader = BufReader::new(stream);
            let mut line = String::new();

            if reader.read_line(&mut line).await.is_err() {
                continue;
            }

            // "GET /callback?code=…&state=… HTTP/1.1"
            let target = line.split_whitespace().nth(1).unwrap_or("").to_string();

            // Browsers cheerfully probe /favicon.ico on the same origin; that is
            // not the callback and must not consume the one-shot listener.
            if !target.starts_with(native::CALLBACK_PATH) {
                let _ = reader
                    .into_inner()
                    .write_all(native::callback_response(false).as_bytes())
                    .await;
                continue;
            }

            let outcome = native::parse_callback_target(&target, expected_state);
            let _ = reader
                .into_inner()
                .write_all(native::callback_response(outcome.is_ok()).as_bytes())
                .await;

            return outcome;
        }
    };

    match tokio::time::timeout(
        std::time::Duration::from_secs(NATIVE_LOGIN_TIMEOUT_SECS),
        accept,
    )
    .await
    {
        Ok(inner) => inner,
        Err(_) => Err("Sign-in timed out before completing".to_string()),
    }
}

/// POST a native-auth endpoint and parse the token set out of it.
///
/// The secret (code + verifier, or the refresh token) is in the BODY, which
/// reqwest never puts in an error — but reqwest does embed the request URL, and a
/// base URL can carry userinfo or query material, so the URL is swapped for its
/// redacted form the way `transport.rs` does (MJXHRM-217, PR #103).
async fn post_native_tokens(
    state: &TransportState,
    base: &str,
    path: &str,
    body: serde_json::Value,
) -> Result<native::NativeTokenSet, String> {
    let url = format!("{base}{path}");
    // The refresh token rides in the body, so it is scrubbed out of any error
    // too — reqwest has no reason to quote a body back at us, but this error
    // reaches a log line and the token is the session (MJXHRM-354).
    let secret = body
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let resp = state
        .client()
        .post(&url)
        .header(reqwest::header::ORIGIN, base)
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            format!(
                "{path} request failed: {}",
                crate::transport::redact_secret(
                    crate::transport::redact_error(e.to_string(), &url),
                    &secret
                )
            )
        })?;

    let status = resp.status();

    if !status.is_success() {
        // The gateway keeps these deliberately generic (no verifier oracle); pass
        // the status through and nothing else.
        return Err(format!("{path} rejected the request (HTTP {status})"));
    }

    // reqwest appends ` for url (…)` to a decode error too, so this one carries
    // the request URL exactly like the send failure above does.
    let parsed: serde_json::Value = resp.json().await.map_err(|e| {
        format!(
            "{path} returned an unreadable body: {}",
            crate::transport::redact_error(e.to_string(), &url)
        )
    })?;

    native::parse_token_response(&parsed)
}

/// Run the RFC 8252 login end to end: bind loopback, open the system browser,
/// catch the redirect, exchange the code, persist the tokens.
async fn run_native_login(
    app: &AppHandle,
    state: &TransportState,
    base: &str,
    provider: &str,
) -> Result<native::NativeTokenSet, String> {
    use tauri_plugin_opener::OpenerExt;

    let pkce = native::generate_pkce()?;
    let csrf_state = native::generate_state()?;

    // Bind BEFORE opening the browser: the redirect_uri has to name a port we are
    // already listening on, or a fast IDP can beat us to the callback.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("could not open a loopback listener for sign-in: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("could not read the loopback port: {e}"))?
        .port();
    let redirect_uri = native::loopback_redirect_uri(port);

    let authorize =
        native::build_authorize_url(base, &pkce.challenge, &redirect_uri, &csrf_state, provider);

    log::info!("[oauth] native sign-in: loopback on 127.0.0.1:{port}, opening system browser");

    // The opener plugin's Rust API, not the JS one: a Rust-internal call is not
    // gated by the opener ACL/scope (same reason `open_external` in lib.rs uses it).
    app.opener()
        .open_url(authorize, None::<&str>)
        .map_err(|e| format!("could not open the system browser: {e}"))?;

    let code = await_loopback_code(listener, &csrf_state).await?;

    let tokens = post_native_tokens(
        state,
        base,
        "/auth/native/token",
        serde_json::json!({ "code": code, "code_verifier": pkce.verifier }),
    )
    .await?;

    store_native_tokens(app, state, base, &tokens);
    log::info!("[oauth] native sign-in complete for base={base}");

    Ok(tokens)
}

/// The live token set for this gateway, refreshing first when the stored access
/// token is at or inside the skew window (or when `force_refresh` says the
/// gateway just rejected it). `None` means "no native session" — the caller falls
/// back to the cookie jar, exactly as before.
///
/// A refusal from `/auth/native/refresh` clears the stored set: a refresh token
/// the gateway will not rotate is dead, and keeping it would make every later call
/// spend a doomed round trip.
async fn ensure_native_tokens(
    app: &AppHandle,
    state: &TransportState,
    base: &str,
    force_refresh: bool,
) -> Option<native::NativeTokenSet> {
    let Some(tokens) = load_native_tokens(app, base) else {
        // Stops `bearer_base_for_url`'s origin fallback re-reading the keyring
        // on every single request to a gateway that has no native session.
        state.note_no_bearer_base(base);

        return None;
    };

    state.register_bearer_base(base);

    if !force_refresh && !native::needs_refresh(&tokens, now_secs()) {
        return Some(tokens);
    }

    if tokens.refresh_token.is_empty() {
        clear_native_tokens(app, state, base);

        return None;
    }

    match post_native_tokens(
        state,
        base,
        "/auth/native/refresh",
        serde_json::json!({ "refresh_token": tokens.refresh_token, "provider": tokens.provider }),
    )
    .await
    {
        Ok(rotated) => {
            store_native_tokens(app, state, base, &rotated);

            Some(rotated)
        }
        Err(e) => {
            log::info!("[oauth] native refresh failed, dropping the stored session: {e}");
            clear_native_tokens(app, state, base);

            None
        }
    }
}

/// The `Authorization: Bearer` value for one gateway, read from the OS keyring at
/// request time.
///
/// This is the ONLY way the bearer leaves this module, and it goes to
/// `transport.rs` — never across IPC (MJXHRM-354). `force_refresh` is how the
/// transport turns a 401 into a rotation: the stored access token can be revoked
/// or rotated between the keyring read and the send.
pub(crate) async fn gateway_bearer(
    app: &AppHandle,
    state: &TransportState,
    base: &str,
    force_refresh: bool,
) -> Option<String> {
    ensure_native_tokens(app, state, base, force_refresh)
        .await
        .map(|tokens| tokens.access_token)
}

/// A completed gateway login is signalled by the presence of the access- or
/// refresh-token session cookie. The gateway may prefix it (`__Host-`/`__Secure-`),
/// so match by suffix — mirrors desktop's AT/RT cookie variants.
fn is_session_cookie(name: &str) -> bool {
    name.ends_with("hermes_session_at") || name.ends_with("hermes_session_rt")
}

/// Poll `label`'s webview cookie jar until a live gateway session lands: import the
/// session cookies into the shared reqwest jar and confirm with `/api/auth/me`.
///
/// Returns `Ok(())` on a confirmed-live session, or `Err` on timeout. When the polled
/// window disappears mid-flow this is an error only if `treat_missing_window_as_error`
/// (desktop: the user closed the sign-in window; mobile: the calling webview outlives
/// the navigation, so a transient miss just retries).
///
/// `cookies_for_base` reads the platform cookie store (HttpOnly cookies included, unlike
/// `document.cookie`) and is safe from this async (off-main) context. It is not
/// `WebviewWindow::cookies_for_url` directly: that one answers an IP-addressed gateway
/// with an empty list on macOS/iOS, which stranded every sign-in against a Tailscale or
/// LAN address here until the whole budget ran out (see `webview_cookies`).
async fn poll_session_cookies(
    app: &AppHandle,
    state: &TransportState,
    base: &str,
    base_url: &Url,
    label: &str,
    timeout_secs: u64,
    treat_missing_window_as_error: bool,
) -> Result<(), String> {
    let outcome = tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), async {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;

            let Some(win) = app.get_webview_window(label) else {
                if treat_missing_window_as_error {
                    return Err("Sign-in window was closed before completing".to_string());
                }
                continue;
            };

            // Transient errors just retry on the next tick.
            let Ok(cookies) = crate::webview_cookies::cookies_for_base(&win, base_url) else {
                continue;
            };
            if !cookies
                .iter()
                .any(|c| is_session_cookie(c.name()) && !c.value().is_empty())
            {
                continue;
            }
            log::info!("[oauth] session cookie present; probing /api/auth/me");

            // Merge the gateway's cookies (AT/RT/CSRF) into the shared reqwest jar so
            // the ws-ticket mint is authenticated. base_url is http(s), so HttpOnly
            // cookies insert cleanly.
            {
                let mut store = state
                    .cookies()
                    .lock()
                    .map_err(|_| "cookie jar poisoned".to_string())?;
                for cookie in &cookies {
                    let _ = store.insert_raw(cookie, base_url);
                }
            }

            // Confirm the imported session is actually live server-side before we
            // declare success — the webview jar can hold a STALE cookie from a prior
            // login (sign-out only clears the reqwest jar), which we must ignore and
            // keep waiting past. `/api/auth/me` is the same probe oauth_status uses.
            let me = state
                .client()
                .get(format!("{base}/api/auth/me"))
                .header(reqwest::header::ORIGIN, base)
                .send()
                .await;
            match &me {
                Ok(resp) => log::info!("[oauth] /api/auth/me -> {}", resp.status()),
                Err(e) => log::info!("[oauth] /api/auth/me request error: {e}"),
            }
            if matches!(me, Ok(ref resp) if resp.status().is_success()) {
                return Ok(());
            }
        }
    })
    .await;

    match outcome {
        Ok(inner) => inner,
        Err(_) => Err("Sign-in timed out before completing".to_string()),
    }
}

/// Run the interactive gateway OAuth flow. The webview completes the whole login;
/// we then copy its session cookies into the shared reqwest jar so the caller (JS)
/// can connect the gateway normally and the ws-ticket mint is authenticated.
///
/// Desktop opens a dedicated sign-in `WebviewWindow` that floats over the app. Neither
/// mobile OS can use one. On Android wry attaches its webview via `setContentView` (an
/// Activity has one content view) and has no `Drop` to remove it, so a second window
/// would replace the app and never close. On iOS tao builds the window as a `UIWindow`
/// whose frame is the requested `inner_size` pinned to the screen's top-left, so it
/// rendered as a partial overlay with no chrome to dismiss (see `cloud.rs`). Instead, on
/// mobile we navigate the CALLING webview to the login, poll the same cookies, then
/// navigate it back — the SPA reload resumes the connect via a one-shot marker the
/// frontend persisted before we navigated away.
///
/// `webview` is the caller, injected by Tauri. It matters on Android: the windowable
/// surfaces (Settings, Command Center, …) run in their own native activity on a webview
/// labelled `screen` (see `window.rs`), so driving a hardcoded `main` would load the login
/// into a BACKGROUNDED activity — invisible to the user, and dead on arrival. On iOS those
/// surfaces are in-app overlays on `main`, so the same read is simply always correct.
#[tauri::command]
pub async fn oauth_login(
    app: AppHandle,
    webview: WebviewWindow,
    state: State<'_, TransportState>,
    base: String,
    provider: Option<String>,
) -> Result<(), String> {
    let base = normalize_base(&base);
    let provider = provider.unwrap_or_else(|| "nous".to_string());
    let base_url = Url::parse(&base).map_err(|e| format!("invalid gateway URL {base:?}: {e}"))?;

    // RFC 8252 first when the gateway can broker it. This is the whole point of
    // the capability probe: a gateway that never says `native_pkce` (older build,
    // or password-only) drops through to the webview cascade with no version check
    // and no behaviour change.
    if advertises_native_flow(state.inner(), &base).await {
        log::info!(
            "[oauth] gateway advertises {}; taking the native flow",
            native::NATIVE_FLOW_ID
        );

        match run_native_login(&app, state.inner(), &base, &provider).await {
            Ok(_) => return Ok(()),
            // Fall through rather than fail: the cookie flow still works, and a
            // user who cannot sign in at all is a worse outcome than one who signs
            // in the old way. The reason is logged, never surfaced as a dead end.
            Err(e) => {
                log::warn!("[oauth] native sign-in failed, falling back to the webview flow: {e}")
            }
        }
    }

    // Load the gateway's own login entry point in the webview (not the IDP
    // directly): it sets the webview's PKCE cookie and 302s straight to the
    // provider, then runs the full cascade back to the dashboard — all inside the
    // webview's cookie jar.
    let login_url = format!("{base}/auth/login?provider={provider}");
    let login_url =
        Url::parse(&login_url).map_err(|e| format!("invalid login URL {login_url:?}: {e}"))?;

    #[cfg(desktop)]
    {
        // The caller hosts the login only on mobile; here we build our own window.
        let _ = webview;

        // Build the window on the main thread (gtk/WKWebView requirement). A oneshot
        // carries the build result back so a failure surfaces instead of a dead poll.
        let (build_tx, build_rx) = oneshot::channel::<Result<(), String>>();
        let app_build = app.clone();
        app.run_on_main_thread(move || {
            // Drop any stale window from a previous attempt first.
            if let Some(existing) = app_build.get_webview_window(OAUTH_WINDOW_LABEL) {
                let _ = existing.close();
            }
            let build = WebviewWindowBuilder::new(
                &app_build,
                OAUTH_WINDOW_LABEL,
                WebviewUrl::External(login_url),
            )
            .title("Sign in to Hermes")
            .inner_size(520.0, 720.0)
            .build();
            let _ = build_tx.send(
                build
                    .map(|_| ())
                    .map_err(|e| format!("could not open sign-in window: {e}")),
            );
        })
        .map_err(|e| format!("failed to schedule sign-in window: {e}"))?;

        build_rx
            .await
            .map_err(|_| "failed to open sign-in window".to_string())??;

        log::info!("[oauth] sign-in window opened; polling cookies for base={base}");

        let outcome = poll_session_cookies(
            &app,
            state.inner(),
            &base,
            &base_url,
            OAUTH_WINDOW_LABEL,
            OAUTH_TIMEOUT_SECS,
            true,
        )
        .await;

        // Close the interactive window either way.
        if let Some(win) = app.get_webview_window(OAUTH_WINDOW_LABEL) {
            let _ = win.close();
        }

        outcome
    }

    #[cfg(mobile)]
    {
        // Capture the app's current URL so we can return to it (dev serves from the Vite
        // dev server, prod from http://tauri.localhost/ on Android and tauri://localhost/
        // on iOS — never hardcode; and the app is a HashRouter, so the fragment carries
        // the route — an Android activity screen `?win=activity#/settings`, an iOS
        // in-app overlay `#/settings` — which is how the user gets back to the page they
        // started from). navigate/url are safe (and required) off the main thread;
        // wrapping url() on the main thread would deadlock the round-trip it makes
        // internally (Android's MainPipe, the wry message loop on iOS).
        let label = webview.label().to_string();
        let return_url = webview
            .url()
            .map_err(|e| format!("could not read current app URL: {e}"))?;
        log::info!("[oauth] navigating webview {label:?} to sign-in; will return to {return_url}");
        let nav_target = login_url.clone();
        webview
            .navigate(login_url)
            .map_err(|e| format!("could not open sign-in page: {e}"))?;

        let poll = poll_session_cookies(
            &app,
            state.inner(),
            &base,
            &base_url,
            &label,
            OAUTH_TIMEOUT_SECS_MOBILE,
            false,
        );
        tokio::pin!(poll);

        // Race the poll against "did we even get there". The guard only ever resolves on
        // a refusal — when the navigation did commit it parks forever and the poll runs
        // its normal course, so the happy path is completely unaffected.
        let outcome = tokio::select! {
            result = &mut poll => result,
            () = async {
                if navigation_committed(&webview, &return_url).await {
                    std::future::pending::<()>().await
                }
            } => {
                // We never left the app, so there is nothing to restore and the SPA is
                // still live — return the real reason instead of spending the remaining
                // ~110s polling for a cookie that cannot arrive.
                log::warn!("[oauth] navigation to {nav_target} never committed; giving up");

                return Err(navigation_refused(&nav_target));
            }
        };

        // Restore the app regardless of outcome: the SPA reload auto-resumes the connect
        // (on success) or lands on the connect screen (on cancel/timeout).
        let _ = webview.navigate(return_url);

        outcome
    }
}

/// How a live gateway session authenticates.
///
/// This is what the webview is told *instead of* the credential: the two kinds
/// behave differently (a native session survives a restart in the OS keyring and
/// has no cookie at all; a cookie session is the shared reqwest jar), and the UI
/// has to be able to say which one you have — but neither answer requires the
/// material behind it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionKind {
    /// RFC 8252 bearer, held in the OS keyring and attached by `transport.rs`.
    Native,
    /// Gateway session cookie, held in the shared reqwest jar.
    Cookie,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OauthStatus {
    signed_in: bool,
    email: Option<String>,
    display_name: Option<String>,
    /// Which credential backs the live session, or `None` when signed out.
    ///
    /// This field replaced `native_access_token` (MJXHRM-354). The old shape
    /// handed the bearer itself to JS, which undid the reason the cookie jar,
    /// the ws-ticket mint and the reqwest client all live in Rust in the first
    /// place.
    session_kind: Option<SessionKind>,
}

impl OauthStatus {
    fn signed_out() -> Self {
        Self {
            signed_in: false,
            email: None,
            display_name: None,
            session_kind: None,
        }
    }

    /// The reply for a live session.
    ///
    /// It takes the token set rather than a `bool` deliberately: the credential
    /// enters this function and must not come out the other side, and
    /// `the_status_reply_never_carries_the_bearer` below pins exactly that. A
    /// future edit that puts the token back on the wire has to walk past a
    /// failing test to do it.
    fn live(body: &serde_json::Value, tokens: Option<&native::NativeTokenSet>) -> Self {
        let string = |key: &str| body.get(key).and_then(|v| v.as_str()).map(str::to_string);

        Self {
            signed_in: true,
            email: string("email"),
            display_name: string("display_name"),
            session_kind: Some(match tokens {
                Some(_) => SessionKind::Native,
                None => SessionKind::Cookie,
            }),
        }
    }
}

/// Whether a live gateway session exists — native bearer OR cookie jar, in that
/// order. Used on connect to decide between a silent reconnect and an interactive
/// sign-in.
///
/// The order matters: after a native login there is no cookie at all, so a
/// cookie-only probe would report "signed out" and loop the user back through the
/// browser on every connect. Mirrors desktop's `oauthSessionIsLive`.
#[tauri::command]
pub async fn oauth_status(
    app: AppHandle,
    state: State<'_, TransportState>,
    base: String,
) -> Result<OauthStatus, String> {
    let base = normalize_base(&base);
    let tokens = ensure_native_tokens(&app, state.inner(), &base, false).await;

    let url = format!("{base}/api/auth/me");
    let mut request = state
        .client()
        .get(&url)
        .header(reqwest::header::ORIGIN, &base);

    if let Some(set) = tokens.as_ref() {
        request = request.bearer_auth(&set.access_token);
    }

    // `redact_error` and not `redact_bearer` alone: reqwest quotes the request
    // URL back at us, and a hand-typed base can carry a basic-auth password in
    // its userinfo. This string is rendered on the connect screen.
    let resp = request.send().await.map_err(|e| {
        format!(
            "auth/me request failed: {}",
            crate::transport::redact_error(e.to_string(), &url)
        )
    })?;

    if !resp.status().is_success() {
        // A bearer the gateway rejects is dead (the middleware answers a bad
        // bearer with 401 rather than falling through to the cookie), so drop it
        // instead of re-presenting it on every probe.
        if tokens.is_some() {
            clear_native_tokens(&app, state.inner(), &base);
        }

        return Ok(OauthStatus::signed_out());
    }

    let body: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);

    Ok(OauthStatus::live(&body, tokens.as_ref()))
}

/// Sign out of the gateway session. `POST /auth/logout` revokes the refresh token
/// server-side and responds with max-age=0 Set-Cookie headers, which reqwest's
/// shared cookie jar applies — clearing the local session in the same round trip.
///
/// The stored native token set is dropped FIRST and unconditionally: a sign-out
/// that left a usable bearer in the keyring would silently sign the user back in
/// on the next connect, and that is worse than a logout POST that failed.
#[tauri::command]
pub async fn oauth_logout(
    app: AppHandle,
    state: State<'_, TransportState>,
    base: String,
) -> Result<(), String> {
    let base = normalize_base(&base);
    let bearer = load_native_tokens(&app, &base).map(|t| t.access_token);
    clear_native_tokens(&app, state.inner(), &base);

    // redirects OFF: the logout 302 -> /login is irrelevant; we only need the
    // clearing Set-Cookie on the 302 response itself.
    let url = format!("{base}/auth/logout");
    let mut request = state
        .no_redirect_client()
        .post(&url)
        .header(reqwest::header::ORIGIN, &base);

    // Present the bearer so the gateway can revoke the refresh token server-side
    // too; without it a native sign-out would only be local.
    if let Some(token) = bearer.as_deref() {
        request = request.bearer_auth(token);
    }

    request.send().await.map_err(|e| {
        format!(
            "auth/logout request failed: {}",
            crate::transport::redact_error(e.to_string(), &url)
        )
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn token_set() -> native::NativeTokenSet {
        native::NativeTokenSet {
            access_token: "at-live-and-secret".to_string(),
            refresh_token: "rt-live-and-secret".to_string(),
            expires_at: 1_800_000_000,
            provider: "nous".to_string(),
            user_id: "u1".to_string(),
        }
    }

    fn me_body() -> serde_json::Value {
        serde_json::json!({ "email": "a@example.com", "display_name": "A" })
    }

    /// The regression guard this whole change exists for. `oauth_status` used to
    /// return `native_access_token`, putting a long-lived bearer inside the
    /// webview; the reply now carries the session KIND and nothing else.
    #[test]
    fn the_status_reply_never_carries_the_bearer() {
        let tokens = token_set();
        let json = serde_json::to_string(&OauthStatus::live(&me_body(), Some(&tokens))).unwrap();

        assert!(!json.contains(&tokens.access_token), "{json}");
        assert!(!json.contains(&tokens.refresh_token), "{json}");
        assert!(!json.to_ascii_lowercase().contains("token"), "{json}");
        // The useful half still crosses: who you are, and how you signed in.
        assert!(json.contains("\"sessionKind\":\"native\""), "{json}");
        assert!(json.contains("a@example.com"), "{json}");
    }

    #[test]
    fn a_session_with_no_bearer_reports_the_cookie_kind() {
        let json = serde_json::to_string(&OauthStatus::live(&me_body(), None)).unwrap();

        assert!(json.contains("\"sessionKind\":\"cookie\""), "{json}");
        assert!(json.contains("\"signedIn\":true"), "{json}");
    }

    #[test]
    fn a_signed_out_reply_names_no_session_kind() {
        let json = serde_json::to_string(&OauthStatus::signed_out()).unwrap();

        assert!(json.contains("\"signedIn\":false"), "{json}");
        assert!(json.contains("\"sessionKind\":null"), "{json}");
    }

    #[test]
    fn a_missing_me_body_still_yields_a_signed_in_reply() {
        // `/api/auth/me` bodies vary by provider; a 200 with nothing useful in it
        // is still a live session, not a crash and not a sign-out.
        let status = OauthStatus::live(&serde_json::Value::Null, Some(&token_set()));

        assert!(status.signed_in);
        assert_eq!(status.email, None);
        assert_eq!(status.session_kind, Some(SessionKind::Native));
    }
}
