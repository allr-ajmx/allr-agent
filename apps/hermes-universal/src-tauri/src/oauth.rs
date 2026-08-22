//! Connection-level gateway OAuth (Track D3) — two flows, one command.
//!
//! # RFC 8252 native flow (preferred, MJXHRM-77)
//!
//! When `/api/status` advertises `auth_flows: [... "native_pkce"]` the gateway can
//! broker a real native-app login: client-side PKCE + a loopback redirect, ending in
//! bearer tokens handed to us in a JSON body with no cookie anywhere. That is
//! strictly better than the webview flow below:
//!
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
//! ## Where the user types their password (the platform split)
//!
//! **Neither platform uses the system browser.** They differ only in WHICH webview
//! hosts the login: desktop builds a window beside the app, mobile takes over the
//! calling webview. Both then answer the same loopback listener, which is a plain
//! TCP socket and does not care which process connects to it.
//!
//! Both arms used to hand the authorize URL to the SYSTEM BROWSER, and the return
//! leg is why neither does now.
//!
//! On MOBILE it could never work: an app that opens Safari is backgrounded, and iOS
//! then SUSPENDS it — there is no `UIBackgroundModes`, no `beginBackgroundTask` and
//! `background.rs` is `cfg(desktop)`. A suspended process cannot accept on its own
//! loopback listener, so the redirect the browser makes to `127.0.0.1:<port>` hangs
//! until Safari gives up on an error page.
//!
//! On DESKTOP it worked on paper — we are never suspended, so the listener stays
//! live — but in practice the hop from the browser back to `127.0.0.1:<port>` is at
//! the mercy of things we do not control: a browser that refuses a plaintext
//! loopback navigation out of an https page, a proxy that eats the 302, an
//! extension. Hosting the login in our own window costs nothing (PKCE, the code
//! exchange and the keyring result are all unchanged) and removes that entire class
//! of failure.
//!
//! When the return leg does fail there is nothing to fall back on: there is no
//! deep-link plugin, no `CFBundleURLTypes` and no `BROWSABLE` intent-filter anywhere
//! in this project, and `callback_response` can only ask the user to switch back by
//! hand. The token never reached the keyring and the user was left signed in inside
//! a browser we cannot read.
//!
//! A custom-scheme redirect would fix the return leg, but the gateway will not take
//! one: `_validate_loopback_redirect_uri` (`routes.py`) accepts ONLY
//! `http://127.0.0.1[:port]/…` / `http://[::1][:port]/…` and rejects even `localhost`.
//! So `ASWebAuthenticationSession` (which needs a custom callback scheme) is out
//! without a server change.
//!
//! What a webview CAN do is load our own loopback URL. So both arms point a webview
//! at the authorize URL, let the gateway 302 it to `http://127.0.0.1:<port>/callback`
//! and answer that from the listener we already bound. The gateway's
//! `allr_session_pkce` broker cookie round-trips inside that webview for both hops,
//! so nothing extra has to be plumbed.
//!
//!   * DESKTOP builds a dedicated `OAUTH_WINDOW_LABEL` window beside the app, waits
//!     on the listener, and closes the window. The app's own UI is never disturbed,
//!     so closing that window is also the cancel gesture — see
//!     `await_loopback_code_in_window`.
//!   * MOBILE navigates the CALLING webview, because neither phone can host a
//!     dismissable second window, then navigates back — the same navigate-away
//!     contract the cookie cascade below and `cloud.rs::portal_login` already use,
//!     one-shot resume marker included.
//!
//! # Legacy webview-cookie flow (fallback)
//!
//! Mirrors Allr desktop (Electron), which binds an OAuth `BrowserWindow` to a
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
//! cookies (`allr_session_at`/`_rt` — or `hermes_session_*` from a gateway deployed
//! before the rename; `is_session_cookie` takes either — HttpOnly) in the WEBVIEW's
//! cookie jar, then:
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
/// rebuilt) across attempts so a stale window never lingers. Only BUILT on desktop —
/// mobile drives the login through the calling webview instead of a second window —
/// but the constant is unconditional because `lib.rs`'s credential gate has to
/// recognise the label on every platform it compiles for.
pub(crate) const OAUTH_WINDOW_LABEL: &str = "hermes-oauth";

/// How long to wait for the interactive login before giving up (desktop: the app UI
/// stays put behind the sign-in window, so a generous window is fine).
#[cfg(desktop)]
const OAUTH_TIMEOUT_SECS: u64 = 300;

/// Mobile runs the login in the calling webview, which replaces the entire app UI for the
/// duration, so this is also how long the user can be stranded on a login page.
///
/// It was 120s, and that was too tight in the one case that matters: a real sign-in with an
/// emailed one-time code means leaving for Mail, copying it and coming back. On iOS the app
/// is BACKGROUNDED for that detour while the monotonic clock keeps running, so the whole
/// detour is charged here. A premature timeout is indistinguishable to the user from the
/// sign-in being broken. The abandon watcher in `native_login_after_navigate` is what makes
/// a budget this long safe to carry — backing out of the login is noticed in ~2s rather
/// than at the deadline.
#[cfg(mobile)]
const OAUTH_TIMEOUT_SECS_MOBILE: u64 = 240;

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

// ── One interactive sign-in at a time, per webview ───────────────────────────

/// Webviews with an interactive sign-in already in flight.
///
/// The lock has to live HERE, in Rust, and not in the frontend: on mobile a sign-in
/// destroys the JS context that would be holding it, so anything JS-side is released by
/// the very act it is meant to guard.
///
/// It exists because three independent callers can drive a sign-in — the connect
/// pre-flight, the connect reauth-retry, and the background reconnect supervisor — and
/// nothing serialised them. Two overlapping on mobile is not merely wasteful: they share
/// one webview, so the second reads `webview.url()` after the first has already navigated
/// and captures the LOGIN PAGE as its "come back here afterwards" target. Whichever
/// finishes last then restores the app to a login page, stranding the user with no way
/// home. Observed on device (two `oauth_login` calls 122 ms apart), which is what this
/// and `is_on_sign_in_page` below exist to make impossible.
///
/// Keyed by webview label rather than global: two windows signing in to two gateways is
/// legitimate on desktop. Shared with `cloud.rs::portal_login`, which drives the same
/// webview and so collides just as readily.
static SIGN_IN_IN_FLIGHT: std::sync::Mutex<std::collections::BTreeSet<String>> =
    std::sync::Mutex::new(std::collections::BTreeSet::new());

/// Holds one webview's sign-in slot until dropped.
///
/// RAII rather than an explicit release: `oauth_login` has a dozen early returns across
/// two platform arms, and a slot leaked on any one of them would wedge sign-in for the
/// rest of the process with no way back.
pub(crate) struct SignInLease(String);

impl Drop for SignInLease {
    fn drop(&mut self) {
        if let Ok(mut in_flight) = SIGN_IN_IN_FLIGHT.lock() {
            in_flight.remove(&self.0);
        }
    }
}

/// Is any interactive sign-in running right now?
///
/// Asked by the credential gate in `lib.rs`, which locks the keyring whenever the app
/// loses focus. Opening the sign-in window IS the app losing focus, so without this the
/// gate slammed shut at the exact moment the flow needs it open, and every gated read
/// for the rest of the sign-in failed. The lease is the right signal rather than a
/// window-label check alone: it spans the whole command, including the desktop system
/// browser arm, where no window of ours is involved at all and the app is defocused by
/// Safari.
pub(crate) fn sign_in_active() -> bool {
    SIGN_IN_IN_FLIGHT
        .lock()
        // A poisoned registry says nothing about whether a sign-in is running, and
        // guessing "no" here would re-introduce the lock this exists to prevent.
        .map(|in_flight| !in_flight.is_empty())
        .unwrap_or(true)
}

/// Claim `label`'s sign-in slot, or report that one is already running.
pub(crate) fn claim_sign_in(label: &str) -> Result<SignInLease, String> {
    let mut in_flight = SIGN_IN_IN_FLIGHT
        .lock()
        .map_err(|_| "the sign-in registry is unusable".to_string())?;

    if !in_flight.insert(label.to_string()) {
        log::warn!("[oauth] refusing a second sign-in for webview {label:?}");

        return Err(
            "A sign-in is already in progress. Finish or cancel it before starting another."
                .to_string(),
        );
    }

    Ok(SignInLease(label.to_string()))
}

/// Is the webview already sitting on the sign-in host?
///
/// Then the URL we are about to capture as "where to return to" is a login page rather
/// than the app, and restoring to it would strand the user there.
///
/// `claim_sign_in` normally prevents this from arising at all. This closes the gap it
/// cannot: `navigate` only QUEUES a load, so a flow can release its lease while its
/// navigation back to the app is still in flight and the URL still reads as the login
/// page. Cheap, and it makes the observed failure impossible regardless of caller.
#[cfg(mobile)]
pub(crate) fn is_on_sign_in_page(current: &Url, target: &Url) -> bool {
    native::same_origin(current, target)
}

/// What `is_on_sign_in_page` reports when it refuses.
#[cfg(mobile)]
pub(crate) fn already_on_sign_in_page() -> String {
    "The sign-in page is already open. Finish it, or go back, before signing in again.".to_string()
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

    /// Are these two URLs the same origin (RFC 6454: scheme, host AND port)?
    ///
    /// The abandon watcher's whole safety argument. It fires when the sign-in webview
    /// comes back to the APP's origin, which must never be confused with the loopback
    /// callback page we serve ourselves: the app is `tauri://localhost` (iOS) or
    /// `http://tauri.localhost` (Android), the callback is `http://127.0.0.1:<port>`,
    /// and the gateway cannot redirect to the app scheme. Port is part of the test
    /// because in dev the app is served from the Vite port on the same host a
    /// loopback callback could use.
    pub fn same_origin(a: &tauri::Url, b: &tauri::Url) -> bool {
        a.scheme() == b.scheme()
            && a.host_str() == b.host_str()
            && a.port_or_known_default() == b.port_or_known_default()
    }

    /// The one-page reply shown after the redirect. It must never contain the code —
    /// the client has it in its address bar already, but the page itself is the thing
    /// screen-shared or left open.
    ///
    /// `in_app` is the mobile case, where the requester is our OWN webview and we
    /// navigate it back a moment later. Telling that user to "close this tab" would be
    /// a lie — there is no tab, and they are not the one who closes it.
    pub fn callback_response(ok: bool, in_app: bool) -> String {
        let body = match (ok, in_app) {
            (true, true) => "<h1>Signed in</h1><p>Returning to Allr…</p>",
            (true, false) => "<h1>Signed in</h1><p>You can close this tab and return to Allr.</p>",
            (false, true) => "<h1>Sign-in failed</h1><p>Returning to Allr…</p>",
            (false, false) => "<h1>Sign-in failed</h1><p>Return to Allr and try again.</p>",
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
        fn the_browser_reply_never_echoes_the_authorization_code() {
            // Every variant, not just the desktop one: the in-app copy is rendered in
            // our OWN webview, where a leaked code would sit in the app's page cache.
            for (ok, in_app) in [(true, true), (true, false), (false, true), (false, false)] {
                let page = callback_response(ok, in_app);

                assert!(page.contains("Content-Length:"), "{page}");
                assert!(!page.contains("code="), "{page}");
            }
        }

        #[test]
        fn the_in_app_reply_does_not_tell_the_user_to_close_a_tab() {
            // On mobile the requester is the app's own webview and we navigate it back
            // ourselves; "close this tab" would be an instruction nobody can follow.
            assert!(!callback_response(true, true).contains("close this tab"));
            assert!(callback_response(true, false).contains("close this tab"));
        }

        #[test]
        fn the_app_origin_and_the_loopback_callback_are_never_the_same_origin() {
            // The abandon watcher cancels the sign-in when the webview returns to the
            // app. If it could not tell the app from our own callback page it would
            // cancel every successful login at the last step.
            let parse = |s: &str| tauri::Url::parse(s).unwrap();

            assert!(!same_origin(
                &parse("tauri://localhost/"),
                &parse("http://127.0.0.1:51234/callback")
            ));
            assert!(!same_origin(
                &parse("http://tauri.localhost/"),
                &parse("http://127.0.0.1:51234/callback")
            ));
            // The gateway's own pages are not the app either.
            assert!(!same_origin(
                &parse("tauri://localhost/"),
                &parse("https://gw.example.com/auth/login")
            ));
        }

        #[test]
        fn same_origin_ignores_the_path_and_fragment_but_not_the_port() {
            let parse = |s: &str| tauri::Url::parse(s).unwrap();

            // The app is a HashRouter, so the route rides in the fragment and the URL we
            // compare against is never character-identical to the one we left from.
            assert!(same_origin(
                &parse("http://192.168.1.5:5176/"),
                &parse("http://192.168.1.5:5176/index.html#/settings")
            ));
            // In dev the app and a loopback callback can share a host; only the port
            // separates them.
            assert!(!same_origin(
                &parse("http://127.0.0.1:5176/"),
                &parse("http://127.0.0.1:51234/callback")
            ));
        }
    }
}

// ── RFC 8252 native flow: the I/O half ───────────────────────────────────────

/// How long the loopback listener waits for the browser redirect, on DESKTOP. The
/// user is in a browser tab, possibly signing in with a second factor, and the app
/// window is still there to cancel from — be generous, but never wait forever: an
/// abandoned login must not pin a socket for the session.
#[cfg(desktop)]
const NATIVE_LOGIN_TIMEOUT_SECS: u64 = 300;

/// The same budget on mobile, where the sign-in has taken over the app's only webview.
///
/// Shorter than desktop's 300s because this is also how long the user can be stranded
/// on a page that is not Allr, and longer than the 120s this file used to carry
/// everywhere because an emailed one-time code means a trip to Mail that is charged
/// against it (see `OAUTH_TIMEOUT_SECS_MOBILE`). It must also stay comfortably under
/// the gateway's own `_PENDING_TTL_SECONDS = 600` (`native_flow.py`), or we would sit
/// waiting on a broker state the server has already dropped.
#[cfg(mobile)]
const MOBILE_NATIVE_TIMEOUT_SECS: u64 = 240;

/// How long ONE loopback socket gets to send its request line.
///
/// Per-socket, not per-flow. A client that opens a speculative connection and never
/// writes must not be able to hold a task (or, before the restructure below, the whole
/// listener) for the entire login budget.
const LOOPBACK_SOCKET_READ_SECS: u64 = 10;

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Persist a token set, reporting whether it actually landed.
///
/// The `Result` still matters on EVERY platform, and a caller that discards it is
/// claiming a session it does not have. `cache_bearer_tokens` keeps the set alive
/// for THIS run only — it is a read-through cache, not storage. A write that fails
/// leaves a session that dies at the next launch, which is exactly the failure the
/// `Result` exists to report, so it is still wrong to swallow.
///
/// This doc used to say there was "no in-memory fallback anywhere in this module",
/// and that every later read went `gateway_bearer` → `ensure_native_tokens` →
/// `load_native_tokens` → the keyring. That was true and it was the bug: on macOS a
/// keyring read is an ACL check, so a build whose code signature the ACL cannot
/// match (an ad-hoc signed one) raised a password dialog PER REQUEST. The cache
/// below is keyed on the token's own `expires_at` via `native::needs_refresh`, so it
/// cannot serve a set the gateway would reject for age, and `force_refresh` skips it
/// entirely. Note this is a different thing from the storage fallback that
/// `secrets/store.rs` still correctly forbids: that one would have DIVERTED
/// credentials away from the OS store; this one only remembers what the OS store
/// already told us.
fn store_native_tokens(
    _app: &AppHandle,
    state: &TransportState,
    base: &str,
    tokens: &native::NativeTokenSet,
) -> Result<(), String> {
    // Cached even when the keyring write below fails: the token set is live for
    // this run either way, and the transport has to know to attach it.
    state.cache_bearer_tokens(base, tokens.clone());

    let json = serde_json::to_string(tokens)
        .map_err(|e| format!("could not serialize the token set: {e}"))?;

    // Never log or quote the payload — it IS the session. The error alone is enough.
    crate::secrets::write_owned(crate::secrets::OwnedKey::NativeAuth, base, &json)
        .map_err(|e| e.message)?;

    Ok(())
}

/// The stored token set for `base`, or `None` when there is not one.
///
/// A keyring that REFUSES the read is not the same as one that has nothing, and the two
/// used to be indistinguishable here (`.ok()??`). They still return the same `None` — the
/// caller has nothing better to do either way — but the refusal now says so, because
/// "signed out" caused by a broken credential store is exactly the failure this module
/// has no other way to report.
fn load_native_tokens(_app: &AppHandle, base: &str) -> Option<native::NativeTokenSet> {
    let json = match crate::secrets::read_owned(crate::secrets::OwnedKey::NativeAuth, base) {
        Ok(found) => found?,
        Err(e) => {
            log::warn!("[oauth] could not read the stored session: {}", e.message);

            return None;
        }
    };

    serde_json::from_str(&json).ok()
}

fn clear_native_tokens(_app: &AppHandle, state: &TransportState, base: &str) {
    state.forget_bearer_base(base);

    let _ = crate::secrets::remove_owned(crate::secrets::OwnedKey::NativeAuth, base);
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

/// Answer one loopback socket: read its request line, reply, and report whether it
/// carried the authorization code.
///
/// Only the request line is read — the code is in the target, and reading further
/// would mean parsing a body we have no use for. The reply is a static page: the
/// client must never be handed anything that echoes the code back.
///
/// `None` means "not the callback" (a probe), and the caller keeps waiting.
async fn serve_loopback_socket(
    stream: tokio::net::TcpStream,
    expected_state: &str,
    in_app: bool,
) -> Option<Result<String, String>> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let mut reader = BufReader::new(stream);
    let mut line = String::new();

    // A socket that connects and never speaks gets its own short deadline; without one
    // it would hold this task for the whole login budget.
    let read = tokio::time::timeout(
        std::time::Duration::from_secs(LOOPBACK_SOCKET_READ_SECS),
        reader.read_line(&mut line),
    )
    .await;

    if !matches!(read, Ok(Ok(_))) {
        return None;
    }

    // "GET /callback?code=…&state=… HTTP/1.1"
    let target = line.split_whitespace().nth(1).unwrap_or("").to_string();
    let is_callback = target.starts_with(native::CALLBACK_PATH);

    // Clients cheerfully probe /favicon.ico on the same origin; that is not the
    // callback and must not resolve the wait.
    let outcome = is_callback.then(|| native::parse_callback_target(&target, expected_state));

    let mut stream = reader.into_inner();
    let _ = stream
        .write_all(native::callback_response(matches!(outcome, Some(Ok(_))), in_app).as_bytes())
        .await;
    // Flush and half-close before dropping. The reply is the only thing the user sees
    // in the moment before we navigate the webview back, so it must actually leave.
    let _ = stream.flush().await;
    let _ = stream.shutdown().await;

    outcome
}

/// Serve the loopback listener until the authorization code arrives.
///
/// Sockets are accepted and served CONCURRENTLY, which is not incidental. The
/// original shape accepted one connection and then awaited its request line before
/// accepting the next — so a client that opened a speculative connection and sent
/// nothing on it stalled the real callback in the accept backlog for the entire
/// budget, and the login died of a timeout with the code sitting unread in the
/// kernel. Both a browser and a webview preconnect, and the webview does it while
/// making the very top-level navigation we are waiting on.
///
/// The first socket to reach a verdict decides it, Ok or Err — the same one-shot
/// policy as before; only the serialization is gone. Probes resolve nothing and the
/// wait continues.
async fn await_loopback_code(
    listener: tokio::net::TcpListener,
    expected_state: &str,
    timeout_secs: u64,
    in_app: bool,
) -> Result<String, String> {
    let accept = async {
        let mut sockets = tokio::task::JoinSet::new();

        loop {
            tokio::select! {
                incoming = listener.accept() => {
                    let (stream, _) = incoming
                        .map_err(|e| format!("loopback listener failed: {e}"))?;
                    let expected = expected_state.to_string();

                    sockets.spawn(async move {
                        serve_loopback_socket(stream, &expected, in_app).await
                    });
                }
                // Guarded: `join_next` on an empty set answers `None` immediately, and
                // an unguarded non-matching branch would spin this loop.
                Some(done) = sockets.join_next(), if !sockets.is_empty() => {
                    // A probe (`None`) or a panicked task resolves nothing; keep waiting.
                    if let Ok(Some(verdict)) = done {
                        return verdict;
                    }
                }
            }
        }
    };

    match tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), accept).await {
        Ok(inner) => inner,
        Err(_) => Err("Sign-in timed out before completing".to_string()),
    }
}

/// Build the interactive sign-in window at `url` (desktop).
///
/// On the main thread because gtk/WKWebView require it, with a `oneshot` carrying
/// the build result back so a failure surfaces here instead of as a dead wait on a
/// listener nothing will ever reach. Any stale window from a previous attempt is
/// dropped first — `OAUTH_WINDOW_LABEL` is a single reused label, and building over
/// a live one fails.
///
/// The same shape the cookie cascade in `oauth_login` uses; both run through here.
#[cfg(desktop)]
async fn open_sign_in_window(app: &AppHandle, url: Url) -> Result<(), String> {
    let (build_tx, build_rx) = oneshot::channel::<Result<(), String>>();
    let app_build = app.clone();

    app.run_on_main_thread(move || {
        if let Some(existing) = app_build.get_webview_window(OAUTH_WINDOW_LABEL) {
            let _ = existing.close();
        }

        let build =
            WebviewWindowBuilder::new(&app_build, OAUTH_WINDOW_LABEL, WebviewUrl::External(url))
                .title("Sign in to Allr")
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
        .map_err(|_| "failed to open sign-in window".to_string())?
}

/// Drop the interactive sign-in window if it is still up (desktop).
#[cfg(desktop)]
fn close_sign_in_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(OAUTH_WINDOW_LABEL) {
        let _ = win.close();
    }
}

/// Wait for the loopback code, giving up as soon as the user closes the window.
///
/// The close watch is what keeps an abandoned sign-in from pinning the flow for the
/// whole budget. It polls rather than subscribing to a window event because the
/// window is torn down from the main thread and `get_webview_window` going `None` is
/// the one signal that is true for every way it can die — closed by the user,
/// closed by us, or destroyed by the platform. 500 ms matches the cookie cascade's
/// poll, and the cost is a hashmap lookup.
///
/// The wait itself is unchanged (`await_loopback_code`); this only adds a second way
/// out of it.
#[cfg(desktop)]
async fn await_loopback_code_in_window(
    app: &AppHandle,
    listener: tokio::net::TcpListener,
    expected_state: &str,
    timeout_secs: u64,
) -> Result<String, NativeLoginError> {
    let closed = async {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;

            if app.get_webview_window(OAUTH_WINDOW_LABEL).is_none() {
                return;
            }
        }
    };

    tokio::select! {
        // Biased so a code that landed in the same tick as the close wins: the
        // window is closed BY the callback arriving, and reporting that as a
        // cancellation would throw away a completed sign-in.
        biased;
        // A timeout or listener failure keeps `navigated: false` (via `From<String>`)
        // so a gateway with broken native routes still falls through to the cookie
        // cascade — that fallback is the whole compatibility story.
        code = await_loopback_code(listener, expected_state, timeout_secs, true) => {
            code.map_err(NativeLoginError::from)
        }
        // A cancel is different in kind: the user dismissed the sign-in on purpose,
        // and answering that by opening a second sign-in window would be the exact
        // "I ended up on some other login screen" behaviour this flag exists to stop.
        () = closed => Err(NativeLoginError {
            message: "Sign-in window was closed before completing".to_string(),
            navigated: true,
        }),
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

/// Why a native login failed, and whether falling back would help or just repeat it.
///
/// `navigated` is the entire reason this is a struct and not a `String`. On mobile the
/// login runs in the app's ONLY webview, so a failure after the hand-off leaves the
/// user looking at a page that is not Allr. Falling back to the cookie cascade from
/// there does not recover anything — it navigates them away a second time, to a
/// different login page — which is precisely the "I ended up on some other login
/// screen" this flow was reported for. See the match in `oauth_login`.
struct NativeLoginError {
    message: String,
    /// "The user has already been put in front of a sign-in surface, and showing them
    /// another one is not a recovery." Both platforms set it; they just reach it
    /// differently.
    ///
    /// MOBILE sets it once the hand-off has been ISSUED, which is not the same as the
    /// webview having moved — a refused navigation counts too. That is deliberate: the
    /// cookie cascade would ask the same webview for a page on the same unreachable
    /// host and be refused identically, so falling back there buys a second failure
    /// and a second wait.
    ///
    /// DESKTOP sets it only when the user CLOSED the sign-in window, i.e. cancelled.
    /// A desktop timeout or transport failure deliberately leaves it false and does
    /// fall through: that is the compatibility path for a gateway whose native routes
    /// are broken. But answering a cancel by immediately opening a second sign-in
    /// window is the one thing that is never right.
    navigated: bool,
}

impl From<String> for NativeLoginError {
    /// Everything that can fail before the hand-off converts this way, so the shared
    /// prologue below keeps using `?`. Anything that fails AFTER it has to say
    /// `navigated: true` explicitly.
    fn from(message: String) -> Self {
        Self {
            message,
            navigated: false,
        }
    }
}

/// A mobile native login that failed after the hand-off was issued.
///
/// The extra bit is not the same question `NativeLoginError::navigated` answers.
/// That one asks "may the cookie cascade run?" (no, in every case here). This one
/// asks "is there anything to restore?" — and a navigation the platform REFUSED left
/// the app exactly where it was, with its JS context alive and holding the connect
/// screen that is about to render this error. Reloading it would throw that away and
/// replace a nameable failure with a blank picker.
#[cfg(mobile)]
struct MobileNativeFailure {
    message: String,
    left_the_app: bool,
}

#[cfg(mobile)]
impl From<String> for MobileNativeFailure {
    /// The default is "we left", because everything that fails via `?` after the
    /// hand-off — the loopback wait, the token POST, the keyring write — can only be
    /// reached once the webview is already on the sign-in page.
    fn from(message: String) -> Self {
        Self {
            message,
            left_the_app: true,
        }
    }
}

/// Run the RFC 8252 login end to end: bind loopback, get the user to the authorize
/// URL, catch the redirect, exchange the code, persist the tokens.
///
/// The prologue — PKCE, CSRF state, the loopback bind, the authorize URL — is shared,
/// and every part of it fails before anything visible has happened. The platforms
/// split only on *how the user reaches that URL and how they get back*: desktop hands
/// it to the system browser, mobile drives the calling webview (see the module note
/// for why mobile cannot use the browser).
async fn run_native_login(
    app: &AppHandle,
    webview: &WebviewWindow,
    state: &TransportState,
    base: &str,
    provider: &str,
) -> Result<native::NativeTokenSet, NativeLoginError> {
    let pkce = native::generate_pkce()?;
    let csrf_state = native::generate_state()?;

    // Bind BEFORE handing off: the redirect_uri has to name a port we are already
    // listening on, or a fast IDP can beat us to the callback.
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

    #[cfg(desktop)]
    {
        // The login runs in OUR OWN window, not the system browser.
        //
        // It used to be the browser (that is what RFC 8252 §8.1 asks for), and on
        // paper desktop can host that shape: unlike a phone we are never suspended,
        // so the loopback listener stays live while the user is in another app. In
        // practice the return leg is at the mercy of whatever is between the browser
        // and `127.0.0.1:<port>` — a default browser that refuses a plaintext
        // loopback hop out of an https page, a gateway or proxy that drops the 302,
        // an extension. When it fails there is NOTHING to fall back on: this project
        // has no deep-link plugin, no `CFBundleURLTypes` and no `BROWSABLE`
        // intent-filter, so the socket is the only door home and the user is left
        // signed in inside a browser we cannot read.
        //
        // Hosting the same flow in a webview we own removes that whole class of
        // failure without giving anything up: the listener is a plain TCP socket on
        // loopback and does not care which process connects, so PKCE, the one-shot
        // code exchange and the bearer-in-the-keyring result are all unchanged. The
        // mobile arm below already drives exactly this authorize -> loopback redirect
        // through a Tauri webview; this is the same trick with a window beside the
        // app instead of the app's own webview.
        //
        // The webview is a plain external-URL window with no IPC: `hermes-oauth` is
        // deliberately outside the `windows` globs in capabilities/default.json.
        let _ = webview;

        let authorize_url =
            Url::parse(&authorize).map_err(|e| format!("invalid authorize URL: {e}"))?;

        log::info!(
            "[oauth] native sign-in: loopback on 127.0.0.1:{port}, opening the sign-in window"
        );

        open_sign_in_window(app, authorize_url).await?;

        // `in_app: true` — the callback page is rendered inside the window we are
        // about to close, so it says "Returning to Allr…" rather than telling the
        // user to close a tab that is not theirs.
        //
        // Raced against the window going away so that closing it cancels the sign-in
        // immediately. Without that race an abandoned login pins the flow for the
        // full NATIVE_LOGIN_TIMEOUT_SECS with no UI to explain itself, which is
        // indistinguishable from the app having hung.
        let code =
            await_loopback_code_in_window(app, listener, &csrf_state, NATIVE_LOGIN_TIMEOUT_SECS)
                .await;

        // Close the window on every exit, exactly as the cookie cascade does.
        close_sign_in_window(app);

        let code = code?;

        let tokens = post_native_tokens(
            state,
            base,
            "/auth/native/token",
            serde_json::json!({ "code": code, "code_verifier": pkce.verifier }),
        )
        .await?;

        // NOT survivable, despite how this read for a long time. A token set that did
        // not reach the keyring cannot be read back by `ensure_native_tokens`, so
        // returning `Ok` here hands the caller a signed-in answer for a session that is
        // already dead — the user completes a sign-in in the window above and the app
        // says signed out. Fail instead.
        //
        // Failing is also the gentler option, which is why it is safe to do here: this
        // converts with `navigated: false`, so `oauth_login` drops through to the cookie
        // cascade rather than dead-ending. A machine whose keyring genuinely does not
        // work (a Linux box with no Secret Service) therefore degrades to the flow that
        // predates this one, which keeps its session in the reqwest jar and needs no
        // keyring at all.
        store_native_tokens(app, state, base, &tokens)
            .map_err(|e| format!("Signed in, but the credential could not be saved: {e}"))?;

        log::info!("[oauth] native sign-in complete for base={base}");

        Ok(tokens)
    }

    #[cfg(mobile)]
    {
        let label = webview.label().to_string();
        let return_url = webview
            .url()
            .map_err(|e| format!("could not read current app URL: {e}"))?;
        let authorize_url =
            Url::parse(&authorize).map_err(|e| format!("invalid authorize URL: {e}"))?;

        // What we just captured has to be the APP, not a login page — see
        // `is_on_sign_in_page`.
        if is_on_sign_in_page(&return_url, &authorize_url) {
            log::warn!(
                "[oauth] webview {label:?} is already at {return_url}; not signing in again"
            );

            return Err(already_on_sign_in_page().into());
        }

        log::info!(
            "[oauth] native sign-in: loopback on 127.0.0.1:{port}; navigating webview {label:?} \
             to authorize; will return to {return_url}"
        );

        // A navigate that fails to even queue has not moved anything.
        webview
            .navigate(authorize_url.clone())
            .map_err(|e| format!("could not open the sign-in page: {e}"))?;

        // Past this line the app's UI is gone, so every exit runs through the single
        // restore below and reports `navigated: true`.
        let outcome = native_login_after_navigate(
            app,
            state,
            base,
            webview,
            &return_url,
            &authorize_url,
            listener,
            &csrf_state,
            &pkce.verifier,
        )
        .await;

        // Restore the app — unless the navigation was refused, in which case we never
        // left and the SPA is still live (the same call the cookie cascade and
        // `cloud.rs::portal_login` skip for that case). On success the tokens are
        // already in the keyring, which the reload this triggers is about to read.
        let restore = match outcome.as_ref() {
            Ok(_) => true,
            Err(failure) => failure.left_the_app,
        };

        if restore {
            let _ = webview.navigate(return_url);
        }

        outcome.map_err(|failure| NativeLoginError {
            message: failure.message,
            navigated: true,
        })
    }
}

/// Why the sign-in webview stopped being somewhere useful.
#[cfg(mobile)]
enum Departure {
    /// It never left the app at all — the platform refused the load.
    Refused,
    /// It left, and then came back to the app on its own: the user backed out.
    Abandoned,
}

/// Resolve only when the sign-in is no longer reachable, so the caller can stop
/// waiting on a callback that is not coming.
///
/// Two distinct cases, and both used to cost the entire budget. A refusal is the
/// existing `navigation_committed` check. An abandon is new and is what makes a
/// four-minute budget tolerable: Android's hardware back pops the webview's history,
/// which lands it back on the app's own origin, and there is no other way to cancel
/// while the app UI is away.
///
/// Two consecutive readings before calling it, so a transient unreadable `url()`
/// cannot cancel a live sign-in.
#[cfg(mobile)]
async fn watch_for_departure(webview: &WebviewWindow, app_url: &Url) -> Departure {
    if !navigation_committed(webview, app_url).await {
        return Departure::Refused;
    }

    let mut back_home = 0u8;

    loop {
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;

        match webview.url() {
            Ok(now) if native::same_origin(&now, app_url) => {
                back_home += 1;

                if back_home >= 2 {
                    return Departure::Abandoned;
                }
            }
            _ => back_home = 0,
        }
    }
}

/// The half of the mobile native login that runs while the app's UI is away.
///
/// Split out so `run_native_login` has exactly one place that decides whether to
/// restore the app, no matter which of these steps failed.
#[cfg(mobile)]
#[allow(clippy::too_many_arguments)]
async fn native_login_after_navigate(
    app: &AppHandle,
    state: &TransportState,
    base: &str,
    webview: &WebviewWindow,
    return_url: &Url,
    authorize_url: &Url,
    listener: tokio::net::TcpListener,
    csrf_state: &str,
    verifier: &str,
) -> Result<native::NativeTokenSet, MobileNativeFailure> {
    let wait = await_loopback_code(listener, csrf_state, MOBILE_NATIVE_TIMEOUT_SECS, true);
    tokio::pin!(wait);

    // The watcher only ever resolves on a dead end, so a sign-in that completes in two
    // seconds is still noticed in two seconds.
    let code = tokio::select! {
        result = &mut wait => result?,
        departure = watch_for_departure(webview, return_url) => {
            return Err(match departure {
                Departure::Refused => {
                    log::warn!(
                        "[oauth] authorize navigation to {authorize_url} never committed; giving up"
                    );

                    // The one case with nothing to restore.
                    MobileNativeFailure {
                        message: navigation_refused(authorize_url),
                        left_the_app: false,
                    }
                }
                Departure::Abandoned => {
                    log::info!("[oauth] the sign-in page was left before completing; cancelling");

                    "Sign-in was cancelled".to_string().into()
                }
            });
        }
    };

    let tokens = post_native_tokens(
        state,
        base,
        "/auth/native/token",
        serde_json::json!({ "code": code, "code_verifier": verifier }),
    )
    .await?;

    // Written BEFORE the caller navigates back, and a failure here fails the sign-in.
    // The restore reloads the SPA, whose boot calls `oauth_status` — i.e. reads this
    // exact keyring entry — within a tick or two. A write that has not landed, or that
    // silently did not happen, reads as "signed out" and drops the user on the connect
    // screen holding a login they just completed.
    store_native_tokens(app, state, base, &tokens)
        .map_err(|e| format!("Signed in, but the credential could not be saved: {e}"))?;

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
    // The cached set first, so a live token costs no keyring round trip at all.
    // `force_refresh` MUST skip the cache: that path exists because the gateway
    // just answered 401 to this very token, and serving it again from memory
    // would turn one rejected request into an infinite loop of them.
    let cached = if force_refresh {
        None
    } else {
        state.cached_bearer_tokens(base)
    };

    let tokens = match cached {
        Some(tokens) => tokens,
        None => {
            let Some(tokens) = load_native_tokens(app, base) else {
                // Stops `bearer_base_for_url`'s origin fallback re-reading the
                // keyring on every single request to a gateway that has no
                // native session.
                state.note_no_bearer_base(base);

                return None;
            };

            tokens
        }
    };

    state.cache_bearer_tokens(base, tokens.clone());

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
            // A rotation that cannot be written back is survivable: the set we just
            // received is live in memory for this run, and the next launch simply signs
            // in again. Unlike a fresh login (see `run_native_login`), nothing is about
            // to reload and read the keyring back.
            if let Err(e) = store_native_tokens(app, state, base, &rotated) {
                log::warn!("[oauth] could not persist rotated native tokens: {e}");
            }

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
///
/// BOTH spellings count. The cookie name is an on-wire contract with whatever gateway
/// the user typed a URL for, and that gateway is deployed on its own schedule: a
/// pre-rebrand build sets `hermes_session_*`, a current one sets `allr_session_*`, and
/// this client has to sign in to either. Recognising only the current spelling is what
/// broke sign-in against every already-deployed gateway — the login completed, WebKit
/// stored the cookie, and `poll_session_cookies` below spent its whole 300s budget
/// failing to see it, so the sign-in window never closed.
fn is_session_cookie(name: &str) -> bool {
    const SUFFIXES: [&str; 4] = [
        "allr_session_at",
        "allr_session_rt",
        // Pre-rebrand gateways. Not dead weight — see above.
        "hermes_session_at", // rebrand:keep
        "hermes_session_rt", // rebrand:keep
    ];

    SUFFIXES.iter().any(|suffix| name.ends_with(suffix))
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
/// `document.cookie`). It is not `WebviewWindow::cookies_for_url` directly: that one
/// answers an IP-addressed gateway with an empty list on macOS/iOS, which stranded every
/// sign-in against a Tailscale or LAN address here until the whole budget ran out (see
/// `webview_cookies`).
///
/// This doc used to claim the read was "safe from this async (off-main) context". It was
/// not, and that sentence is why the bug survived review: being off-main is precisely what
/// routes the call through the event loop into a tao user callback, where wry's nested
/// runloop aborts the process. `webview_cookies` now does the iOS read without blocking.
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
            let Ok(cookies) = crate::webview_cookies::cookies_for_base(&win, base_url).await else {
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

/// Run the interactive gateway OAuth flow — the RFC 8252 native flow when the gateway
/// brokers one, the webview-cookie cascade otherwise.
///
/// Note the fall-through rule between them. A native attempt that failed WITHOUT
/// touching the app UI drops through to the cascade, because a user who cannot sign in
/// at all is worse than one who signs in the old way. A native attempt that already
/// took the app's webview to a sign-in page does NOT: running the cascade after it
/// would navigate away a second time, to a second login page, which is the failure this
/// is supposed to prevent rather than a recovery from it.
///
/// ## The cookie cascade
///
/// The webview completes the whole login; we then copy its session cookies into the
/// shared reqwest jar so the caller (JS) can connect the gateway normally and the
/// ws-ticket mint is authenticated.
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
    // Before anything else, and held for the whole command: three callers can drive a
    // sign-in and none of them coordinate. See `SIGN_IN_IN_FLIGHT`.
    let _lease = claim_sign_in(webview.label())?;

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

        match run_native_login(&app, &webview, state.inner(), &base, &provider).await {
            Ok(_) => return Ok(()),
            // The app's own webview was sent to the sign-in page and brought back for
            // this attempt. Falling back now would send it away AGAIN, to a different
            // login page — which is not a recovery, it is the bug: the user completes a
            // sign-in and finds themselves looking at another login screen. Report the
            // real reason instead, from inside the app.
            Err(e) if e.navigated => {
                log::warn!(
                    "[oauth] native sign-in failed after the webview round-trip; \
                     not falling back: {}",
                    e.message
                );

                return Err(e.message);
            }
            // Nothing was disturbed (a bind/PKCE/URL failure, or desktop, where the
            // login lives in another app entirely). Fall through rather than fail: the
            // cookie flow still works, and a user who cannot sign in at all is a worse
            // outcome than one who signs in the old way.
            Err(e) => log::warn!(
                "[oauth] native sign-in failed, falling back to the webview flow: {}",
                e.message
            ),
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
        // The caller hosts the login only on mobile; here we build our own window —
        // the same one the native flow above uses, via the same helper, so the two
        // cannot drift apart in title, size, or stale-window handling.
        let _ = webview;

        open_sign_in_window(&app, login_url).await?;

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
        close_sign_in_window(&app);

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
        let nav_target = login_url.clone();

        // What we just captured has to be the APP, not a login page — see
        // `is_on_sign_in_page`.
        if is_on_sign_in_page(&return_url, &nav_target) {
            log::warn!(
                "[oauth] webview {label:?} is already at {return_url}; not signing in again"
            );

            return Err(already_on_sign_in_page());
        }

        log::info!(
            "[oauth] cookie cascade: navigating webview {label:?} to sign-in; \
             will return to {return_url}"
        );
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

    // ── Session-cookie detection ─────────────────────────────────────────────
    //
    // Untested until now, which is exactly how the rebrand sweep renamed the cookie
    // out from under the sign-in with every suite still green.

    #[test]
    fn both_gateway_spellings_count_as_a_session() {
        // The current gateway...
        assert!(is_session_cookie("allr_session_at"));
        assert!(is_session_cookie("allr_session_rt"));
        // ...and every gateway deployed before the rename. A client that only knew the
        // first pair completed the login and then never saw the cookie, so the sign-in
        // window sat open until it timed out.
        assert!(is_session_cookie("hermes_session_at"));
        assert!(is_session_cookie("hermes_session_rt"));
    }

    #[test]
    fn the_host_and_secure_prefixes_still_match() {
        // The gateway picks the prefix from the request shape (HTTPS + path prefix), so
        // the reader cannot know which variant fired — hence suffix matching.
        for prefix in ["", "__Host-", "__Secure-"] {
            for bare in [
                "allr_session_at",
                "allr_session_rt",
                "hermes_session_at",
                "hermes_session_rt",
            ] {
                let name = format!("{prefix}{bare}");

                assert!(is_session_cookie(&name), "{name}");
            }
        }
    }

    #[test]
    fn unrelated_cookies_are_not_a_session() {
        // Suffix matching is deliberately loose; it must still not fire on the PKCE
        // broker cookie, the provider hint, or a portal cookie sharing the jar.
        assert!(!is_session_cookie("allr_session_pkce"));
        assert!(!is_session_cookie("allr_session_provider"));
        assert!(!is_session_cookie("hermes_session_pkce"));
        assert!(!is_session_cookie("hermes_sso_attempt"));
        assert!(!is_session_cookie("privy-token"));
        assert!(!is_session_cookie(""));
    }

    // ── The sign-in lease ────────────────────────────────────────────────────
    //
    // Labels here are test-unique on purpose: the registry is a process-wide static and
    // the test harness runs these concurrently.

    #[test]
    fn a_second_sign_in_for_the_same_webview_is_refused() {
        let first = claim_sign_in("lease-test-main").expect("the first claim wins");

        // The regression this exists for: two flows driving one webview, the second
        // capturing the first's login page as its return target.
        assert!(claim_sign_in("lease-test-main").is_err());

        drop(first);

        // And the slot is usable again afterwards — a lease that leaked on any of
        // `oauth_login`'s early returns would wedge sign-in for the whole process.
        assert!(claim_sign_in("lease-test-main").is_ok());
    }

    #[test]
    fn a_different_webview_has_its_own_slot() {
        // Desktop can legitimately sign two windows in to two gateways at once, so the
        // lease must not be global.
        let _a = claim_sign_in("lease-test-alpha").expect("alpha");
        let _b = claim_sign_in("lease-test-beta").expect("beta is a separate webview");
    }

    #[test]
    fn a_lease_marks_a_sign_in_as_active() {
        // What the credential gate in lib.rs reads. Before this, opening the sign-in
        // window defocused `main`, the gate locked, and every gated secret read for
        // the rest of the flow failed.
        let lease = claim_sign_in("lease-test-active").expect("claim");

        assert!(sign_in_active());

        drop(lease);
    }

    // ── The loopback listener ────────────────────────────────────────────────
    //
    // Reachable without a browser, a webview or a gateway: it is a TCP server, and a
    // `TcpStream` is a perfectly good client. Worth testing directly, because this is
    // the one part of the native flow whose failures are indistinguishable from "the
    // user did not finish signing in".

    async fn bound_listener() -> (tokio::net::TcpListener, u16) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();

        (listener, port)
    }

    /// Connect and send one request line, exactly as a browser or webview would. The
    /// listener is already bound, so this lands in the accept backlog whether or not
    /// `await_loopback_code` is polling yet.
    async fn request(port: u16, target: &str) {
        use tokio::io::AsyncWriteExt;

        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();

        stream
            .write_all(format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").as_bytes())
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn a_favicon_probe_does_not_resolve_the_wait() {
        let (listener, port) = bound_listener().await;

        request(port, "/favicon.ico").await;
        request(port, "/callback?code=abc123&state=xyz").await;

        let code = await_loopback_code(listener, "xyz", 10, false)
            .await
            .unwrap();

        assert_eq!(code, "abc123");
    }

    /// The head-of-line regression, and the reason this listener serves sockets
    /// concurrently.
    ///
    /// A client that opens a connection and sends nothing on it is ordinary — both
    /// browsers and webviews preconnect, and a webview does it while making the very
    /// navigation whose callback we are waiting for. Serving sockets one at a time
    /// meant that socket pinned the listener, the real callback sat unread in the
    /// backlog, and the login died of a timeout with the code already delivered.
    #[tokio::test]
    async fn a_silent_socket_cannot_stall_the_real_callback() {
        let (listener, port) = bound_listener().await;

        // Connected first, so it is first in the backlog. Held open for the duration.
        let _silent = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        request(port, "/callback?code=abc123&state=xyz").await;

        // The assertion is the deadline, not the value: a serial listener would still
        // answer eventually (once the per-socket read deadline lapsed), just far too
        // late to be a sign-in.
        let code = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            await_loopback_code(listener, "xyz", 60, true),
        )
        .await
        .expect("a silent socket must not delay the callback")
        .unwrap();

        assert_eq!(code, "abc123");
    }

    #[tokio::test]
    async fn a_callback_whose_state_does_not_match_is_refused() {
        // The CSRF boundary still decides per socket, so concurrency did not widen it.
        let (listener, port) = bound_listener().await;

        request(port, "/callback?code=abc123&state=someone-elses").await;

        assert!(await_loopback_code(listener, "xyz", 10, false)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn the_wait_gives_up_rather_than_pinning_the_socket_forever() {
        let (listener, _port) = bound_listener().await;

        let err = await_loopback_code(listener, "xyz", 1, false)
            .await
            .unwrap_err();

        assert!(err.contains("timed out"), "{err}");
    }
}
