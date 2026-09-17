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
//!     `SignInSurface::race`.
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
/// sign-in being broken. The abandon watcher in `SignInSurface::race` is what makes
/// a budget this long safe to carry — backing out of the login is noticed in ~2s rather
/// than at the deadline.
#[cfg(mobile)]
const OAUTH_TIMEOUT_SECS_MOBILE: u64 = 240;

pub(crate) fn normalize_base(raw: &str) -> String {
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
/// legitimate on desktop — as far as the CALLER is concerned. The desktop sign-in window
/// itself is one global label, so it is a second key in the same registry; see
/// [`claim_surface`]. Shared with `cloud.rs::portal_login`, which drives the same webview
/// and so collides just as readily (it never touches `OAUTH_WINDOW_LABEL`: its own window
/// is `cloud::PORTAL_WINDOW_LABEL`).
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

/// Claim `label`'s sign-in slot. `None` means one is already running.
///
/// `None` and not `Err`, because losing this race is a NORMAL outcome, not a
/// failure: it means a sign-in the user asked for is already under way and this
/// caller should simply defer to it. Reporting it as an error had a consequence
/// far worse than the noise — `beginOAuthLogin` treats a rejection as proof that
/// it never navigated, and clears the one-shot resume marker. Since that marker is
/// global, the LOSER was deleting the WINNER's. The user completed a sign-in, the
/// SPA reloaded, found no marker, and dropped them on the connect screen holding a
/// login they had just finished.
pub(crate) fn claim_sign_in(label: &str) -> Option<SignInLease> {
    // A poisoned registry is recovered, not propagated: the guarded value is a set
    // of labels with no invariant to corrupt, and refusing every sign-in for the
    // rest of the process is a far worse outcome than the panic that poisoned it.
    let mut in_flight = match SIGN_IN_IN_FLIGHT.lock() {
        Ok(in_flight) => in_flight,
        Err(poisoned) => poisoned.into_inner(),
    };

    if !in_flight.insert(label.to_string()) {
        log::info!("[oauth] a sign-in already owns webview {label:?}; deferring to it");

        return None;
    }

    Some(SignInLease(label.to_string()))
}

/// The right to put an interactive sign-in on screen.
///
/// DESKTOP: ownership of the ONE sign-in window, `OAUTH_WINDOW_LABEL`, held in the same
/// registry as the per-caller slots. The caller slot alone did not cover it: two windows
/// each held their own slot, and `open_sign_in_window` closes whatever `hermes-oauth`
/// window exists before building its own — so a second sign-in silently took the first's
/// window away, and the first then waited out its whole budget on a listener nobody could
/// reach before closing the second's window on its way out. Every user of that window
/// needs this, and the only ways to reach the window ([`open_sign_in_window`],
/// [`SignInSurface::new`]) take it as an argument, so the rule is enforced by the types
/// rather than remembered at each call site.
///
/// MOBILE: nothing global to own — the surface is the calling webview, which the caller
/// slot already covers — so the claim always succeeds.
pub(crate) struct SurfaceLease {
    #[cfg(desktop)]
    _window: SignInLease,
    #[cfg(mobile)]
    _private: (),
}

/// Claim the sign-in surface. `None` (desktop only) means another sign-in owns the window,
/// which is a busy reply exactly like losing [`claim_sign_in`].
pub(crate) fn claim_surface() -> Option<SurfaceLease> {
    #[cfg(desktop)]
    {
        claim_sign_in(OAUTH_WINDOW_LABEL).map(|window| SurfaceLease { _window: window })
    }

    #[cfg(mobile)]
    {
        Some(SurfaceLease { _private: () })
    }
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

    /// Why a callback hit did not yield a code, kept typed so a caller that has to NAME
    /// the failure (the Allr Work sign-in's error kinds) does not parse a message for it.
    /// `Display` is the exact text [`parse_callback_target`] has always returned.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub enum CallbackRejection {
        /// The gateway redirected back with `?error=<value>`.
        Refused(String),
        /// The callback's `state` is not this request's.
        StateMismatch,
        /// The state matched but no code came with it.
        NoCode,
    }

    impl std::fmt::Display for CallbackRejection {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            match self {
                Self::Refused(error) => write!(f, "sign-in was refused: {error}"),
                Self::StateMismatch => f.write_str("sign-in callback did not match this request"),
                Self::NoCode => f.write_str("sign-in callback carried no authorization code"),
            }
        }
    }

    /// Parse the request target of the browser's callback hit
    /// (`/callback?code=…&state=…`) and return the authorization code.
    ///
    /// The `state` comparison is the whole point of this function: without it any
    /// process that can reach our loopback port could feed us a code minted for a
    /// different login. A gateway-side `?error=` is surfaced as-is.
    ///
    /// The loopback listener now uses [`parse_callback`], which keeps the failure typed;
    /// this string form is what the callback tests below pin, message for message.
    #[cfg_attr(
        not(test),
        allow(
            dead_code,
            reason = "the String form of `parse_callback`, pinned by tests"
        )
    )]
    pub fn parse_callback_target(target: &str, expected_state: &str) -> Result<String, String> {
        parse_callback(target, expected_state).map_err(|rejection| rejection.to_string())
    }

    /// [`parse_callback_target`] with the failure left typed. Same checks, same order.
    pub fn parse_callback(target: &str, expected_state: &str) -> Result<String, CallbackRejection> {
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
            return Err(CallbackRejection::Refused(error));
        }

        // Constant-ish comparison is overkill here (the state is single-use and
        // lives for one login), but an empty expected state must never match.
        if expected_state.is_empty() || state != expected_state {
            return Err(CallbackRejection::StateMismatch);
        }

        if code.is_empty() {
            return Err(CallbackRejection::NoCode);
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
        loopback_page(match (ok, in_app) {
            (true, true) => "<h1>Signed in</h1><p>Returning to Allr…</p>",
            (true, false) => "<h1>Signed in</h1><p>You can close this tab and return to Allr.</p>",
            (false, true) => FAILED_IN_APP,
            (false, false) => FAILED_IN_BROWSER,
        })
    }

    const FAILED_IN_APP: &str = "<h1>Sign-in failed</h1><p>Returning to Allr…</p>";
    const FAILED_IN_BROWSER: &str = "<h1>Sign-in failed</h1><p>Return to Allr and try again.</p>";

    /// Which page a loopback listener answers a hit with. Only the SUCCESS page differs
    /// between listeners; a failure — or a probe — always gets the sign-in-failed page.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum CallbackPage {
        /// The RFC 8252 code callback ([`callback_response`]).
        SignedIn,
        /// The Allr Work hand-back ([`workspace_found_response`]): the sign-in is only
        /// half done, and the same surface is about to move on to the workspace.
        WorkspaceFound,
    }

    /// The reply for `page`, `ok` saying whether the hit carried a verdict we accept.
    pub fn loopback_response(page: CallbackPage, ok: bool, in_app: bool) -> String {
        match page {
            CallbackPage::SignedIn => callback_response(ok, in_app),
            CallbackPage::WorkspaceFound => workspace_found_response(ok, in_app),
        }
    }

    /// The Allr Work hop-1 reply. Same rules as [`callback_response`]: static text, no
    /// external resources, and nothing from the request echoed — not the workspace, and
    /// above all not the state.
    pub fn workspace_found_response(ok: bool, in_app: bool) -> String {
        loopback_page(match (ok, in_app) {
            (true, true) => "<h1>Workspace found</h1><p>Opening your workspace…</p>",
            (true, false) => "<h1>Workspace found</h1><p>Return to Allr to finish signing in.</p>",
            (false, true) => FAILED_IN_APP,
            (false, false) => FAILED_IN_BROWSER,
        })
    }

    fn loopback_page(body: &str) -> String {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        )
    }

    /// Which provider each flow asks for, given what the caller requested.
    ///
    /// Returns `(native, cascade)`. The two flows default differently, and sharing one
    /// default was a bug: `run_oauth_login` used to turn `None` into `"nous"` for BOTH,
    /// which sent `&provider=nous` to `/auth/native/authorize` and got `404 Unknown
    /// provider` from every gateway without a Nous provider. The native route auto-picks
    /// when the provider is absent and exactly one session provider is registered
    /// (`routes.py`), so the native flow sends nothing (`""`, which
    /// [`build_authorize_url`] omits). The cookie cascade has no such fallback on the
    /// server, so it keeps `"nous"`.
    ///
    /// A non-empty request is passed through to both unchanged.
    pub fn providers_for_flows(requested: Option<String>) -> (String, String) {
        match requested.filter(|provider| !provider.is_empty()) {
            Some(provider) => (provider.clone(), provider),
            None => (String::new(), "nous".to_string()),
        }
    }

    /// What one `/api/auth/me` answer says about the session.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub enum AuthMeVerdict {
        /// The gateway answered for a live session.
        Live,
        /// No session. `clear_tokens` when the gateway refused a bearer we presented,
        /// which is therefore dead and must not be presented again.
        SignedOut { clear_tokens: bool },
        /// Could not tell (reason attached): the caller retries, never signs in again.
        Unknown(String),
    }

    /// Where a redirected `/api/auth/me` was sent, relative to the gateway it was asked of.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub enum RedirectTarget {
        /// A different host: an edge sending the request to sign in (Pomerium's
        /// `authenticate.*`, Dex, an SSO proxy).
        OtherHost,
        /// The same host under a different scheme, port or path — the gateway's own
        /// address moved (typically `http://` upgraded to `https://`). Carries the new
        /// address as `scheme://host[:port]/path`: no userinfo, no query, no fragment.
        SameHost(String),
        /// No `Location`, or one that does not resolve to a URL with a host.
        Unreadable,
    }

    /// Resolve a redirect's `Location` against the URL that was requested, and say whether
    /// it leaves the host. Relative locations resolve as a browser would.
    pub fn redirect_target(requested: &tauri::Url, location: Option<&str>) -> RedirectTarget {
        let Some(location) = location.map(str::trim).filter(|l| !l.is_empty()) else {
            return RedirectTarget::Unreadable;
        };

        let Ok(to) = requested.join(location) else {
            return RedirectTarget::Unreadable;
        };

        match (to.host_str(), requested.host_str()) {
            (Some(to_host), Some(from_host)) if to_host.eq_ignore_ascii_case(from_host) => {
                RedirectTarget::SameHost(format!(
                    "{}{}",
                    to.origin().ascii_serialization(),
                    to.path()
                ))
            }
            (Some(_), _) => RedirectTarget::OtherHost,
            _ => RedirectTarget::Unreadable,
        }
    }

    /// Classify `/api/auth/me`, asked with redirects OFF. `redirect` is
    /// [`redirect_target`] for a 3xx (ignored otherwise; `None` reads as `Unreadable`).
    ///
    /// | status  | bearer sent | redirect            | JSON object body | verdict                             |
    /// |---------|-------------|---------------------|------------------|-------------------------------------|
    /// | 2xx     | –           | –                   | yes              | `Live`                              |
    /// | 2xx     | –           | –                   | no               | `Unknown`                           |
    /// | 401/403 | yes / no    | –                   | –                | `SignedOut { clear_tokens: had }`   |
    /// | 3xx     | yes         | any                 | –                | `Unknown`                           |
    /// | 3xx     | no          | other host          | –                | `SignedOut { clear_tokens: false }` |
    /// | 3xx     | no          | missing / unreadable| –                | `SignedOut { clear_tokens: false }` |
    /// | 3xx     | no          | same host           | –                | `Unknown` (names the new address)   |
    /// | other   | –           | –                   | –                | `Unknown`                           |
    ///
    /// The 3xx and non-JSON rows are the fix. A gateway's `/api/auth/me` has no
    /// legitimate redirect, but an EDGE in front of it does: behind Pomerium an
    /// unauthenticated request is 302'd to sign-in, and the redirect-following client
    /// used to walk that chain to Dex's HTML login page, read a `200`, parse the body to
    /// `Null`, and report "signed in (cookie)" for a workspace we hold no credential
    /// for. Without a bearer, a redirect is the edge saying "not signed in". WITH one it
    /// is not evidence the bearer is dead (the edge may simply not route bearer
    /// requests directly), so the token set is kept and the answer is "unknown".
    ///
    /// Only a redirect that LEAVES the host is that edge. A same-host redirect is the
    /// gateway's own address having moved — a cookie gateway saved as `http://` behind an
    /// edge that upgrades to https — and "signed out" would send that user round an
    /// interactive sign-in that ends in the same redirect. It is reported as unknown,
    /// naming the new address so the user can fix the saved one.
    ///
    /// A 3xx with no usable `Location` stays "signed out": a gateway never answers
    /// `/api/auth/me` that way, so it is an edge, and every edge redirect we know of is a
    /// sign-in redirect. Reporting it as unknown would put the user in a retry loop that
    /// cannot end, where "signed out" at worst offers a sign-in.
    pub fn classify_auth_me(
        status: u16,
        had_bearer: bool,
        body_is_json_object: bool,
        redirect: Option<&RedirectTarget>,
    ) -> AuthMeVerdict {
        match status {
            200..=299 if body_is_json_object => AuthMeVerdict::Live,
            200..=299 => AuthMeVerdict::Unknown(format!(
                "auth/me answered HTTP {status} without a JSON body"
            )),
            401 | 403 => AuthMeVerdict::SignedOut {
                clear_tokens: had_bearer,
            },
            300..=399 if had_bearer => AuthMeVerdict::Unknown(format!(
                "auth/me was redirected (HTTP {status}) although a credential was presented"
            )),
            300..=399 => match redirect {
                Some(RedirectTarget::SameHost(to)) => AuthMeVerdict::Unknown(format!(
                    "the gateway address redirects to {to} (HTTP {status}); update the saved \
                     address"
                )),
                _ => AuthMeVerdict::SignedOut {
                    clear_tokens: false,
                },
            },
            _ => AuthMeVerdict::Unknown(format!("auth/me answered HTTP {status}")),
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn native_provider_is_empty_when_unrequested_cascade_keeps_nous() {
            // `&provider=nous` on the native route is a 404 from every gateway without a
            // Nous provider — including every Allr Work workspace.
            assert_eq!(
                providers_for_flows(None),
                (String::new(), "nous".to_string())
            );
            assert_eq!(
                providers_for_flows(Some(String::new())),
                (String::new(), "nous".to_string())
            );
            // An explicit choice is honoured by both flows.
            assert_eq!(
                providers_for_flows(Some("self-hosted".to_string())),
                ("self-hosted".to_string(), "self-hosted".to_string())
            );
            assert_eq!(
                providers_for_flows(Some("nous".to_string())),
                ("nous".to_string(), "nous".to_string())
            );
            // And the empty native provider really is left off the authorize URL.
            let (native, _) = providers_for_flows(None);
            assert!(!build_authorize_url(
                "https://gw",
                "c",
                "http://127.0.0.1:1/callback",
                "s",
                &native
            )
            .contains("provider="));
        }

        #[test]
        fn json_200_is_live() {
            assert_eq!(classify_auth_me(200, true, true, None), AuthMeVerdict::Live);
            assert_eq!(
                classify_auth_me(200, false, true, None),
                AuthMeVerdict::Live
            );
        }

        #[test]
        fn html_200_is_unknown_not_live() {
            // Dex's login page at the end of a followed redirect chain was read as a live
            // cookie session. A 2xx that is not a JSON object is not the gateway talking.
            for had_bearer in [true, false] {
                assert!(
                    matches!(
                        classify_auth_me(200, had_bearer, false, None),
                        AuthMeVerdict::Unknown(_)
                    ),
                    "bearer={had_bearer}"
                );
            }
        }

        #[test]
        fn redirect_without_bearer_is_signed_out() {
            for status in [301, 302, 303, 307, 308] {
                assert_eq!(
                    classify_auth_me(status, false, false, Some(&RedirectTarget::OtherHost)),
                    AuthMeVerdict::SignedOut {
                        clear_tokens: false
                    },
                    "{status}"
                );
            }
        }

        #[test]
        fn redirect_with_bearer_is_unknown() {
            // Not proof the bearer is dead, so it must neither be cleared nor reported as
            // signed out (which would push the user through an interactive sign-in).
            for status in [302, 307] {
                for redirect in [
                    None,
                    Some(RedirectTarget::OtherHost),
                    Some(RedirectTarget::SameHost(
                        "https://gw.example.com/api/auth/me".into(),
                    )),
                    Some(RedirectTarget::Unreadable),
                ] {
                    assert!(
                        matches!(
                            classify_auth_me(status, true, false, redirect.as_ref()),
                            AuthMeVerdict::Unknown(_)
                        ),
                        "{status} {redirect:?}"
                    );
                }
            }
        }

        fn requested() -> tauri::Url {
            tauri::Url::parse("http://gw.example.com/api/auth/me").unwrap()
        }

        #[test]
        fn a_redirect_to_another_host_is_the_edge() {
            for location in [
                "https://authenticate.dev.allr.work/.pomerium/sign_in?pomerium_redirect_uri=x",
                "https://auth.allr.work/auth?client_id=dash",
                "//sso.example.com/login",
            ] {
                assert_eq!(
                    redirect_target(&requested(), Some(location)),
                    RedirectTarget::OtherHost,
                    "{location}"
                );
            }
        }

        #[test]
        fn a_redirect_on_the_same_host_names_the_new_address_without_its_query() {
            assert_eq!(
                redirect_target(
                    &requested(),
                    Some("https://GW.example.com/api/auth/me?token=secret#frag")
                ),
                RedirectTarget::SameHost("https://gw.example.com/api/auth/me".into())
            );
            // A relative location stays on the host; so does a port or path change.
            assert_eq!(
                redirect_target(&requested(), Some("/hermes/api/auth/me")),
                RedirectTarget::SameHost("http://gw.example.com/hermes/api/auth/me".into())
            );
            assert_eq!(
                redirect_target(&requested(), Some("http://gw.example.com:8443/api/auth/me")),
                RedirectTarget::SameHost("http://gw.example.com:8443/api/auth/me".into())
            );
            // Userinfo in the Location is never repeated.
            assert_eq!(
                redirect_target(&requested(), Some("https://me:pw@gw.example.com/")),
                RedirectTarget::SameHost("https://gw.example.com/".into())
            );
        }

        #[test]
        fn a_missing_or_garbage_location_is_unreadable() {
            for location in [
                None,
                Some(""),
                Some("   "),
                Some("http://[::1"),
                Some("mailto:x@y"),
            ] {
                assert_eq!(
                    redirect_target(&requested(), location),
                    RedirectTarget::Unreadable,
                    "{location:?}"
                );
            }
        }

        #[test]
        fn without_a_bearer_only_a_same_host_redirect_is_unknown() {
            let same = RedirectTarget::SameHost("https://gw.example.com/api/auth/me".into());

            match classify_auth_me(301, false, false, Some(&same)) {
                AuthMeVerdict::Unknown(reason) => {
                    assert!(
                        reason.contains("https://gw.example.com/api/auth/me"),
                        "{reason}"
                    );
                    assert!(reason.contains("update the saved address"), "{reason}");
                }
                other => panic!("a moved gateway address is not a sign-out: {other:?}"),
            }

            // The edge, and an edge that did not say where: signed out, nothing cleared.
            for redirect in [
                None,
                Some(RedirectTarget::OtherHost),
                Some(RedirectTarget::Unreadable),
            ] {
                assert_eq!(
                    classify_auth_me(302, false, false, redirect.as_ref()),
                    AuthMeVerdict::SignedOut {
                        clear_tokens: false
                    },
                    "{redirect:?}"
                );
            }
        }

        #[test]
        fn status_401_with_bearer_clears() {
            for status in [401, 403] {
                assert_eq!(
                    classify_auth_me(status, true, true, None),
                    AuthMeVerdict::SignedOut { clear_tokens: true },
                    "{status}"
                );
                // Nothing presented, nothing to clear.
                assert_eq!(
                    classify_auth_me(status, false, true, None),
                    AuthMeVerdict::SignedOut {
                        clear_tokens: false
                    },
                    "{status}"
                );
            }
        }

        #[test]
        fn server_errors_are_unknown_never_signed_out() {
            // A gateway still booting, a proxy 502, or the gateway's 503 for a bad token
            // (ALLR-51 §2.2 7d): none of them may cost the user a sign-in.
            for status in [404, 429, 500, 502, 503, 504] {
                for had_bearer in [true, false] {
                    assert!(
                        matches!(
                            classify_auth_me(status, had_bearer, true, None),
                            AuthMeVerdict::Unknown(_)
                        ),
                        "{status} bearer={had_bearer}"
                    );
                }
            }
        }

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

/// Answer one loopback socket: read its request line, hand the target to `parse`,
/// reply, and report the verdict.
///
/// Only the request line is read — everything a listener needs is in the target, and
/// reading further would mean parsing a body we have no use for. The reply is a static
/// page: the client must never be handed anything that echoes the request back (the
/// code, the state, the workspace).
///
/// `parse` answers `None` for "not ours" (a probe), and the caller keeps waiting. A probe
/// gets the failure page, exactly as it always has.
async fn serve_loopback_socket<T, E, P>(
    stream: tokio::net::TcpStream,
    parse: &P,
    page: native::CallbackPage,
    in_app: bool,
) -> Option<Result<T, E>>
where
    P: Fn(&str) -> Option<Result<T, E>>,
{
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

    // Clients cheerfully probe /favicon.ico on the same origin; that is not the
    // callback and must not resolve the wait. Which paths count is the parser's call.
    let outcome = parse(&target);

    let mut stream = reader.into_inner();
    let _ = stream
        .write_all(
            native::loopback_response(page, matches!(outcome, Some(Ok(_))), in_app).as_bytes(),
        )
        .await;
    // Flush and half-close before dropping. The reply is the only thing the user sees
    // in the moment before we navigate the webview on, so it must actually leave.
    let _ = stream.flush().await;
    let _ = stream.shutdown().await;

    outcome
}

/// Why a loopback wait ended without any hit reaching a verdict.
#[derive(Debug)]
pub(crate) enum LoopbackFailure {
    /// The budget ran out.
    TimedOut,
    /// `accept` itself failed (the message is already user-facing).
    Listener(String),
}

/// The RFC 8252 `/callback` parser: only that path is a verdict, and the verdict is
/// [`native::parse_callback`].
fn callback_parser(
    expected_state: String,
) -> impl Fn(&str) -> Option<Result<String, native::CallbackRejection>> + Send + Sync + 'static {
    move |target| {
        target
            .starts_with(native::CALLBACK_PATH)
            .then(|| native::parse_callback(target, &expected_state))
    }
}

/// Serve a loopback listener until some hit yields a verdict.
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
///
/// Generic over what a hit means, because two listeners share this loop: the RFC 8252
/// code callback ([`callback_parser`], [`native::CallbackPage::SignedIn`]) and the Allr
/// Work hand-back (`allr_work::decide::parse_handoff_target`,
/// [`native::CallbackPage::WorkspaceFound`]). Everything that made the first one
/// robust — concurrency, per-socket deadlines, first-verdict-wins — is what the second
/// needs too, so it is shared rather than copied.
pub(crate) async fn await_loopback<T, E, P>(
    listener: tokio::net::TcpListener,
    parse: P,
    page: native::CallbackPage,
    timeout_secs: u64,
    in_app: bool,
) -> Result<Result<T, E>, LoopbackFailure>
where
    P: Fn(&str) -> Option<Result<T, E>> + Send + Sync + 'static,
    T: Send + 'static,
    E: Send + 'static,
{
    let parse = std::sync::Arc::new(parse);

    let accept = async {
        let mut sockets = tokio::task::JoinSet::new();

        loop {
            tokio::select! {
                incoming = listener.accept() => {
                    let (stream, _) = incoming.map_err(|e| {
                        LoopbackFailure::Listener(format!("loopback listener failed: {e}"))
                    })?;
                    let parse = parse.clone();

                    sockets.spawn(async move {
                        serve_loopback_socket(stream, parse.as_ref(), page, in_app).await
                    });
                }
                // Guarded: `join_next` on an empty set answers `None` immediately, and
                // an unguarded non-matching branch would spin this loop.
                Some(done) = sockets.join_next(), if !sockets.is_empty() => {
                    // A probe (`None`) or a panicked task resolves nothing; keep waiting.
                    if let Ok(Some(verdict)) = done {
                        return Ok(verdict);
                    }
                }
            }
        }
    };

    match tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), accept).await {
        Ok(inner) => inner,
        Err(_) => Err(LoopbackFailure::TimedOut),
    }
}

/// Serve the loopback listener until the authorization code arrives, with every failure
/// flattened to the message `oauth_login` reports.
///
/// Test-only: production goes through [`native_login_on_surface`], which needs the
/// failure typed. It is the same [`await_loopback`] + [`callback_parser`] pair, so the
/// listener tests below exercise exactly the production path.
#[cfg(test)]
async fn await_loopback_code(
    listener: tokio::net::TcpListener,
    expected_state: &str,
    timeout_secs: u64,
    in_app: bool,
) -> Result<String, String> {
    match await_loopback(
        listener,
        callback_parser(expected_state.to_string()),
        native::CallbackPage::SignedIn,
        timeout_secs,
        in_app,
    )
    .await
    {
        Ok(verdict) => verdict.map_err(|rejection| rejection.to_string()),
        Err(LoopbackFailure::TimedOut) => Err(SIGN_IN_TIMED_OUT.to_string()),
        Err(LoopbackFailure::Listener(message)) => Err(message),
    }
}

/// What a sign-in that ran out of budget reports.
const SIGN_IN_TIMED_OUT: &str = "Sign-in timed out before completing";

/// Build the interactive sign-in window at `url` (desktop).
///
/// On the main thread because gtk/WKWebView require it, with a `oneshot` carrying
/// the build result back so a failure surfaces here instead of as a dead wait on a
/// listener nothing will ever reach. Any stale window from a previous attempt is
/// dropped first — `OAUTH_WINDOW_LABEL` is a single reused label, and building over
/// a live one fails.
///
/// The same shape the cookie cascade in `oauth_login` uses; both run through here.
///
/// `_lease` is the proof this flow owns the window: closing "any stale window" is only
/// safe when no other live flow can be the one that built it. See [`SurfaceLease`].
#[cfg(desktop)]
async fn open_sign_in_window(
    app: &AppHandle,
    url: Url,
    _lease: &SurfaceLease,
) -> Result<(), String> {
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

/// POST a native-auth endpoint and parse the token set out of it.
///
/// The secret (code + verifier, or the refresh token) is in the BODY, which
/// reqwest never puts in an error — but reqwest does embed the request URL, and a
/// base URL can carry userinfo or query material, so the URL is swapped for its
/// redacted form the way `transport.rs` does (MJXHRM-217, PR #103).
/// Why a token POST failed, and — the part that matters — whether the credential
/// it carried is actually dead.
///
/// `status` is `Some(code)` when the gateway ANSWERED and refused. It is `None`
/// when the request never got an answer at all: DNS, connection refused, TLS,
/// timeout. Collapsing those two into one `String` is what let a flaky network
/// delete a perfectly good session: `ensure_native_tokens` cleared the keyring on
/// any `Err`, so one unreachable moment cost the user an interactive sign-in.
#[derive(Debug)]
struct TokenPostError {
    message: String,
    /// The HTTP status the gateway answered with, or `None` if it never answered.
    status: Option<u16>,
    /// Whether the gateway answered at all. True for a refusal AND for a 2xx whose body
    /// could not be read — `status` is `None` for the latter so it never reaches
    /// `credential_rejected`, but it is still not a network failure, and a sign-in that
    /// has to name the failure (Allr Work) must not call it "unreachable".
    answered: bool,
}

impl TokenPostError {
    fn unreachable(message: String) -> Self {
        Self {
            message,
            status: None,
            answered: false,
        }
    }

    /// Answered 2xx, but with a body that is not a token set.
    fn unreadable(message: String) -> Self {
        Self {
            message,
            status: None,
            answered: true,
        }
    }

    /// True only when the gateway answered and rejected the credential itself.
    ///
    /// 401 is the refusal the auth gate emits for a dead bearer or a refresh token
    /// it will not rotate; 403 covers a grant that still parses but is no longer
    /// entitled. Everything else — 5xx from a restarting gateway, 502 from a proxy,
    /// 429 — says nothing about the credential and must leave it alone.
    fn credential_rejected(&self) -> bool {
        matches!(self.status, Some(401) | Some(403))
    }

    /// How a sign-in on a surface names this failure.
    fn surface_failure(&self) -> SurfaceLoginFailure {
        if self.answered {
            SurfaceLoginFailure::TokenRejected
        } else {
            SurfaceLoginFailure::TokenUnreachable
        }
    }
}

impl From<TokenPostError> for String {
    fn from(err: TokenPostError) -> Self {
        err.message
    }
}

impl std::fmt::Display for TokenPostError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

async fn post_native_tokens(
    state: &TransportState,
    base: &str,
    path: &str,
    body: serde_json::Value,
) -> Result<native::NativeTokenSet, TokenPostError> {
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
            TokenPostError::unreachable(format!(
                "{path} request failed: {}",
                crate::transport::redact_secret(
                    crate::transport::redact_error(e.to_string(), &url),
                    &secret
                )
            ))
        })?;

    let status = resp.status();

    if !status.is_success() {
        // The gateway keeps these deliberately generic (no verifier oracle); pass
        // the status through and nothing else.
        return Err(TokenPostError {
            message: format!("{path} rejected the request (HTTP {status})"),
            status: Some(status.as_u16()),
            answered: true,
        });
    }

    // reqwest appends ` for url (…)` to a decode error too, so this one carries
    // the request URL exactly like the send failure above does.
    //
    // Answered-but-unreadable is NOT a credential refusal: the gateway took the
    // token and replied 2xx, so the fault is the body, not the grant. It keeps
    // `status: None` so it never reaches `credential_rejected`.
    let parsed: serde_json::Value = resp.json().await.map_err(|e| {
        TokenPostError::unreadable(format!(
            "{path} returned an unreadable body: {}",
            crate::transport::redact_error(e.to_string(), &url)
        ))
    })?;

    native::parse_token_response(&parsed).map_err(TokenPostError::unreadable)
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
    /// differently — see [`SurfaceLoginFailure::navigated`].
    navigated: bool,
}

// ── The sign-in surface ──────────────────────────────────────────────────────

/// Why a sign-in on a [`SignInSurface`] did not produce a token set.
///
/// One variant per thing a caller has to say differently. `oauth_login` only needs the
/// message and the fall-back decision ([`Self::navigated`]); the Allr Work sign-in maps
/// every variant to its own error kind (`allr_work::hop2_error`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SurfaceLoginFailure {
    /// Failed before anything was shown: randomness, the loopback bind, the URL.
    Setup,
    /// Mobile: the app URL we would return to is already the sign-in origin.
    #[cfg_attr(
        not(mobile),
        allow(dead_code, reason = "only the mobile surface refuses")
    )]
    AlreadyOnSignInPage,
    /// The surface could not be put on the page at all: the window would not build, or
    /// the navigation would not even queue.
    SurfaceUnavailable,
    /// The user closed the sign-in window (desktop) or backed out to the app (mobile).
    Cancelled,
    /// Mobile: the webview never committed the navigation.
    NavigationRefused,
    /// The hop's budget ran out.
    TimedOut,
    /// The loopback listener itself failed.
    Listener,
    /// The callback carried someone else's state.
    StateMismatch,
    /// The gateway redirected back with `error=`, or with no code.
    CallbackRefused,
    /// The gateway answered the code exchange, and not with a token set.
    TokenRejected,
    /// The code exchange got no answer.
    TokenUnreachable,
    /// Signed in, but the token set could not be written to the keyring.
    NotSaved,
}

impl SurfaceLoginFailure {
    /// `NativeLoginError::navigated` for this failure — i.e. must `oauth_login` NOT fall
    /// back to the cookie cascade?
    ///
    /// DESKTOP says yes only when the user CLOSED the sign-in window. A desktop timeout or
    /// transport failure deliberately falls through: that is the compatibility path for a
    /// gateway whose native routes are broken, and a machine with no working keyring
    /// degrades to the cascade, which keeps its session in the reqwest jar. But answering
    /// a cancel by immediately opening a second sign-in window is the one thing that is
    /// never right.
    ///
    /// MOBILE says yes for everything once the hand-off has been ISSUED, which is not the
    /// same as the webview having moved — a refused navigation counts too: the cascade
    /// would ask the same webview for a page on the same unreachable host and be refused
    /// identically. Only a failure before the navigation (setup, the already-on-sign-in
    /// refusal, a navigate that would not queue) leaves the cascade available.
    fn navigated(self, desktop: bool) -> bool {
        if desktop {
            matches!(self, Self::Cancelled)
        } else {
            !matches!(
                self,
                Self::Setup | Self::AlreadyOnSignInPage | Self::SurfaceUnavailable
            )
        }
    }
}

/// A [`SurfaceLoginFailure`] with the message `oauth_login` reports for it.
///
/// The message is for `oauth_login`, and it is NOT always safe to show elsewhere: a
/// refused mobile navigation quotes the authorize URL, state included. Callers that
/// must never quote a state (Allr Work) build their own text from `failure`.
#[derive(Debug)]
pub(crate) struct SurfaceLoginError {
    pub(crate) failure: SurfaceLoginFailure,
    pub(crate) message: String,
}

impl SurfaceLoginError {
    fn new(failure: SurfaceLoginFailure, message: impl Into<String>) -> Self {
        Self {
            failure,
            message: message.into(),
        }
    }
}

/// Why [`SignInSurface::race`] stopped before its work finished.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SurfaceStop {
    /// The user closed the window (desktop) or came back to the app (mobile).
    Cancelled,
    /// Mobile: the navigation never committed.
    #[cfg_attr(
        not(mobile),
        allow(dead_code, reason = "only a mobile webview can refuse")
    )]
    Refused,
    /// The caller's watch predicate matched the surface's current URL.
    Watched,
}

/// A predicate over the sign-in surface's current URL, polled while a hop waits.
pub(crate) type SurfaceWatch = dyn Fn(&Url) -> bool + Send + Sync;

/// Where the calling webview came from, for a sign-in that takes it away (mobile).
///
/// The pure half of [`SignInSurface`]'s mobile arm. The whole point is that the app URL
/// is captured ONCE, before the first hop, and every later check is made against it.
/// A multi-hop sign-in (Allr Work: portal, then workspace) starts its second hop from
/// our own loopback page, and re-reading `webview.url()` there would capture
/// `http://127.0.0.1:<port>/workspace?…` as "home": the back-out watcher would then
/// never see the user return to the app, and the restore would navigate to a listener
/// that has already closed.
///
/// Compiled everywhere so the rules are unit-tested on the desktop host; only the mobile
/// surface uses it.
/// Why [`AppReturn::begin_hop`] will not start a hop.
#[cfg_attr(
    not(mobile),
    allow(dead_code, reason = "used by the mobile sign-in surface only")
)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HopRefusal {
    /// The app URL is already the sign-in origin.
    OnSignInPage,
    /// The user is back on the app between hops.
    BackHome,
}

#[cfg_attr(
    not(mobile),
    allow(dead_code, reason = "used by the mobile sign-in surface only")
)]
#[derive(Debug, Clone)]
pub(crate) struct AppReturn {
    app_url: Url,
    /// Has any hop taken the app's UI away? False until a hop settles without being
    /// refused; a refused FIRST hop is the one case with nothing to restore.
    left_app: bool,
}

#[cfg_attr(
    not(mobile),
    allow(dead_code, reason = "used by the mobile sign-in surface only")
)]
impl AppReturn {
    pub(crate) fn capture(app_url: Url) -> Self {
        Self {
            app_url,
            left_app: false,
        }
    }

    /// Where to bring the webview back to. Always the first capture.
    pub(crate) fn app_url(&self) -> &Url {
        &self.app_url
    }

    /// Start a hop toward `target`, given what the webview reads right now (`None` when
    /// it cannot be read).
    ///
    /// Refused with [`HopRefusal::BackHome`] when an earlier hop took the app away and the
    /// webview is ALREADY back on it: the user backed out between hops (nothing watches
    /// for that while, say, the Allr Work preflight runs), and the SPA has reloaded. Going
    /// on would navigate them away from an app they just returned to, from a flow whose
    /// resume state that reload has already consumed. The hop also stops counting as
    /// "left the app": the webview is home, so there is nothing to restore — a restore
    /// would only reload the SPA a second time — and nothing to park for a resume that
    /// has already run.
    ///
    /// Refused with [`HopRefusal::OnSignInPage`] when the app URL is already the sign-in
    /// origin, so the "come back here" target is a login page (see `is_on_sign_in_page`).
    ///
    /// Otherwise `Ok(nav_from)` is the URL this hop's "did the navigation commit" check
    /// compares against — the page the webview is leaving, which on a later hop is the
    /// loopback page and not the app.
    pub(crate) fn begin_hop(
        &mut self,
        current: Option<&Url>,
        target: &Url,
    ) -> Result<Url, HopRefusal> {
        if self.left_app && current.is_some_and(|now| self.is_home(now)) {
            self.left_app = false;

            return Err(HopRefusal::BackHome);
        }

        if native::same_origin(&self.app_url, target) {
            return Err(HopRefusal::OnSignInPage);
        }

        Ok(current.cloned().unwrap_or_else(|| self.app_url.clone()))
    }

    /// Is the webview back on the app — i.e. did the user back out of the sign-in?
    pub(crate) fn is_home(&self, now: &Url) -> bool {
        native::same_origin(now, &self.app_url)
    }

    /// A hop's wait is over. Anything but a refusal means the app's UI was taken away.
    pub(crate) fn hop_settled(&mut self, refused: bool) {
        if !refused {
            self.left_app = true;
        }
    }

    /// Must the webview be navigated back to [`Self::app_url`]?
    pub(crate) fn must_restore(&self) -> bool {
        self.left_app
    }
}

/// Where an interactive sign-in is shown, across however many hops it takes.
///
/// DESKTOP: the `OAUTH_WINDOW_LABEL` window. Built on the first [`Self::show`],
/// `navigate`d on every later one, and closed on every way out — [`Self::close`],
/// [`Self::finish`], or dropping the surface — so a sign-in that fails between hops
/// never leaves a window behind. Reusing one window between hops is also what carries
/// the Dex session from the first hop to the second (no `data_directory`, so it shares
/// the default store).
///
/// MOBILE: the calling webview, plus where to bring it back to ([`AppReturn`]), captured
/// on the first [`Self::show`] and never re-read.
pub(crate) struct SignInSurface<'a> {
    app: &'a AppHandle,
    /// Borrowed for the surface's whole life, so the window cannot outlive its ownership.
    #[cfg_attr(
        mobile,
        allow(
            dead_code,
            reason = "held, not read: a mobile surface has no window to guard"
        )
    )]
    lease: &'a SurfaceLease,
    #[cfg(desktop)]
    window_open: bool,
    #[cfg(mobile)]
    webview: &'a WebviewWindow,
    #[cfg(mobile)]
    home: Option<AppReturn>,
    /// The page the webview was on when the current hop navigated.
    #[cfg(mobile)]
    nav_from: Option<Url>,
}

impl<'a> SignInSurface<'a> {
    /// The surface for a sign-in `webview` asked for. Nothing is shown yet.
    pub(crate) fn new(
        app: &'a AppHandle,
        webview: &'a WebviewWindow,
        lease: &'a SurfaceLease,
    ) -> Self {
        #[cfg(desktop)]
        {
            // The login runs in OUR OWN window beside the app, never the caller's.
            let _ = webview;

            Self {
                app,
                lease,
                window_open: false,
            }
        }

        #[cfg(mobile)]
        {
            Self {
                app,
                lease,
                webview,
                home: None,
                nav_from: None,
            }
        }
    }

    /// How long one hop may wait on its loopback listener on this platform.
    pub(crate) fn hop_timeout_secs(&self) -> u64 {
        #[cfg(desktop)]
        {
            NATIVE_LOGIN_TIMEOUT_SECS
        }

        #[cfg(mobile)]
        {
            MOBILE_NATIVE_TIMEOUT_SECS
        }
    }

    /// Put `target` on the surface.
    ///
    /// Desktop builds the window the first time and navigates it after; a window the
    /// user closed in between is a cancel. Mobile captures the app URL the first time,
    /// refuses when that is already the sign-in origin, and navigates the webview.
    pub(crate) async fn show(&mut self, target: &Url) -> Result<(), SurfaceLoginError> {
        #[cfg(desktop)]
        {
            if !self.window_open {
                open_sign_in_window(self.app, target.clone(), self.lease)
                    .await
                    .map_err(|message| {
                        SurfaceLoginError::new(SurfaceLoginFailure::SurfaceUnavailable, message)
                    })?;
                self.window_open = true;

                return Ok(());
            }

            let Some(window) = self.app.get_webview_window(OAUTH_WINDOW_LABEL) else {
                self.window_open = false;

                return Err(SurfaceLoginError::new(
                    SurfaceLoginFailure::Cancelled,
                    SIGN_IN_WINDOW_CLOSED,
                ));
            };

            window.navigate(target.clone()).map_err(|e| {
                SurfaceLoginError::new(
                    SurfaceLoginFailure::SurfaceUnavailable,
                    format!("could not open the sign-in page: {e}"),
                )
            })
        }

        #[cfg(mobile)]
        {
            // navigate/url are safe (and required) off the main thread; wrapping url()
            // on the main thread would deadlock the round-trip it makes internally
            // (Android's MainPipe, the wry message loop on iOS).
            let label = self.webview.label().to_string();
            let current = self.webview.url();

            // Captured on the FIRST hop only. A later hop reads `current` too, but only
            // as the page it is leaving — see `AppReturn`.
            let mut home = match self.home.take() {
                Some(home) => home,
                None => AppReturn::capture(
                    current
                        .as_ref()
                        .map_err(|e| {
                            SurfaceLoginError::new(
                                SurfaceLoginFailure::SurfaceUnavailable,
                                format!("could not read current app URL: {e}"),
                            )
                        })?
                        .clone(),
                ),
            };
            let begun = home.begin_hop(current.as_ref().ok(), target);
            let app_url = home.app_url().clone();

            self.home = Some(home);

            let nav_from = match begun {
                Ok(nav_from) => nav_from,
                Err(HopRefusal::BackHome) => {
                    log::info!(
                        "[oauth] webview {label:?} came back to the app between sign-in hops; \
                         cancelling"
                    );

                    return Err(SurfaceLoginError::new(
                        SurfaceLoginFailure::Cancelled,
                        cancelled_message(),
                    ));
                }
                // What we captured has to be the APP, not a login page — see
                // `is_on_sign_in_page`.
                Err(HopRefusal::OnSignInPage) => {
                    log::warn!(
                        "[oauth] webview {label:?} is already at {app_url}; not signing in again"
                    );

                    return Err(SurfaceLoginError::new(
                        SurfaceLoginFailure::AlreadyOnSignInPage,
                        already_on_sign_in_page(),
                    ));
                }
            };

            log::info!(
                "[oauth] navigating webview {label:?} to the sign-in page; will return to {app_url}"
            );

            // A navigate that fails to even queue has not moved anything.
            self.webview.navigate(target.clone()).map_err(|e| {
                SurfaceLoginError::new(
                    SurfaceLoginFailure::SurfaceUnavailable,
                    format!("could not open the sign-in page: {e}"),
                )
            })?;
            self.nav_from = Some(nav_from);

            Ok(())
        }
    }

    /// Wait for `work`, giving up as soon as the surface stops being somewhere useful —
    /// or, when `watch` is given, as soon as the surface's URL satisfies it.
    ///
    /// DESKTOP polls the window every 500 ms. It polls rather than subscribing to a
    /// window event because the window is torn down from the main thread and
    /// `get_webview_window` going `None` is the one signal that is true for every way it
    /// can die — closed by the user, closed by us, or destroyed by the platform. The race
    /// is biased toward `work`: the window is closed BY the callback arriving, and
    /// reporting that as a cancellation would throw away a completed sign-in. The URL
    /// watch reads `url()` on the same tick rather than relying on navigation events,
    /// which WebKitGTK does not reliably fire through a redirect chain.
    ///
    /// MOBILE races `watch_for_departure` (a refused navigation, or the user backing out
    /// to the app) and polls the URL watch every second. Settling the hop is recorded on
    /// the [`AppReturn`], which is how [`Self::finish`] knows whether to restore.
    pub(crate) async fn race<W>(
        &mut self,
        work: W,
        watch: Option<&SurfaceWatch>,
    ) -> Result<W::Output, SurfaceStop>
    where
        W: std::future::Future,
    {
        #[cfg(desktop)]
        {
            let app = self.app;
            let stop = async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

                    let Some(window) = app.get_webview_window(OAUTH_WINDOW_LABEL) else {
                        return SurfaceStop::Cancelled;
                    };

                    if let Some(watch) = watch {
                        if window.url().is_ok_and(|now| watch(&now)) {
                            return SurfaceStop::Watched;
                        }
                    }
                }
            };

            tokio::select! {
                biased;
                out = work => Ok(out),
                stop = stop => {
                    if stop == SurfaceStop::Cancelled {
                        self.window_open = false;
                    }

                    Err(stop)
                }
            }
        }

        #[cfg(mobile)]
        {
            let (Some(home), Some(nav_from)) = (self.home.clone(), self.nav_from.clone()) else {
                // Nothing was shown, so there is nothing to watch.
                return Ok(work.await);
            };
            let webview = self.webview;

            let watched = async move {
                let Some(watch) = watch else {
                    return std::future::pending::<()>().await;
                };

                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;

                    if webview.url().is_ok_and(|now| watch(&now)) {
                        return;
                    }
                }
            };

            // The watcher only ever resolves on a dead end, so a sign-in that completes in
            // two seconds is still noticed in two seconds.
            let outcome = tokio::select! {
                out = work => Ok(out),
                departure = watch_for_departure(webview, &nav_from, &home) => Err(match departure {
                    Departure::Refused => {
                        log::warn!("[oauth] the sign-in navigation never committed; giving up");

                        SurfaceStop::Refused
                    }
                    Departure::Abandoned => {
                        log::info!("[oauth] the sign-in page was left before completing; cancelling");

                        SurfaceStop::Cancelled
                    }
                }),
                () = watched => Err(SurfaceStop::Watched),
            };

            if let Some(home) = self.home.as_mut() {
                home.hop_settled(matches!(outcome, Err(SurfaceStop::Refused)));
            }

            outcome
        }
    }

    /// Close the sign-in window now, if this surface opened it (desktop).
    #[cfg(desktop)]
    pub(crate) fn close(&mut self) {
        if std::mem::take(&mut self.window_open) {
            close_sign_in_window(self.app);
        }
    }

    /// Has the sign-in taken the app's UI away (mobile)? Then the JS context that asked
    /// for it is gone, and only the restore — and whatever it reloads into — is left.
    #[cfg(mobile)]
    pub(crate) fn left_app(&self) -> bool {
        self.home.as_ref().is_some_and(AppReturn::must_restore)
    }

    /// End the sign-in. Desktop closes the window. Mobile navigates the webview back to
    /// the app — unless it never left, in which case the SPA is still live and a reload
    /// would throw away the screen about to render the error. Idempotent.
    pub(crate) fn finish(&mut self) {
        #[cfg(desktop)]
        self.close();

        #[cfg(mobile)]
        {
            if let Some(home) = self.home.take().filter(AppReturn::must_restore) {
                let _ = self.webview.navigate(home.app_url().clone());
            }
        }
    }
}

/// Whatever path out of a desktop sign-in was taken — a `?` between hops included — the
/// window does not outlive it.
#[cfg(desktop)]
impl Drop for SignInSurface<'_> {
    fn drop(&mut self) {
        self.close();
    }
}

/// What a desktop sign-in window closed by the user reports.
#[cfg(desktop)]
const SIGN_IN_WINDOW_CLOSED: &str = "Sign-in window was closed before completing";

/// Run the RFC 8252 login on `surface`: PKCE, state, the loopback bind and the authorize
/// URL; then show it, catch the redirect, exchange the code and persist the tokens.
///
/// Every step before [`SignInSurface::show`] fails before anything visible has happened.
/// This does not restore a mobile webview — that is the caller's [`SignInSurface::finish`],
/// because a multi-hop caller has more to do first — but it does close the desktop window
/// as soon as the wait is over, before the token POST, exactly as the single-hop flow
/// always has.
pub(crate) async fn native_login_on_surface(
    surface: &mut SignInSurface<'_>,
    state: &TransportState,
    base: &str,
    provider: &str,
) -> Result<native::NativeTokenSet, SurfaceLoginError> {
    use SurfaceLoginFailure as Failure;

    let setup = |message: String| SurfaceLoginError::new(Failure::Setup, message);

    let pkce = native::generate_pkce().map_err(setup)?;
    let csrf_state = native::generate_state().map_err(setup)?;

    // Bind BEFORE handing off: the redirect_uri has to name a port we are already
    // listening on, or a fast IDP can beat us to the callback.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| {
            setup(format!(
                "could not open a loopback listener for sign-in: {e}"
            ))
        })?;
    let port = listener
        .local_addr()
        .map_err(|e| setup(format!("could not read the loopback port: {e}")))?
        .port();
    let redirect_uri = native::loopback_redirect_uri(port);

    let authorize =
        native::build_authorize_url(base, &pkce.challenge, &redirect_uri, &csrf_state, provider);
    let authorize_url =
        Url::parse(&authorize).map_err(|e| setup(format!("invalid authorize URL: {e}")))?;

    log::info!("[oauth] native sign-in: loopback on 127.0.0.1:{port}, opening the sign-in page");

    surface.show(&authorize_url).await?;

    // `in_app: true` — the callback page is rendered inside our own surface, so it says
    // "Returning to Allr…" rather than telling the user to close a tab that is not theirs.
    let wait = await_loopback(
        listener,
        callback_parser(csrf_state),
        native::CallbackPage::SignedIn,
        surface.hop_timeout_secs(),
        true,
    );
    let verdict = surface.race(wait, None).await;

    // Close the window on every exit from the wait, exactly as the cookie cascade does.
    #[cfg(desktop)]
    surface.close();

    let code = match verdict {
        Ok(Ok(Ok(code))) => code,
        Ok(Ok(Err(rejection))) => {
            let failure = match rejection {
                native::CallbackRejection::StateMismatch => Failure::StateMismatch,
                native::CallbackRejection::Refused(_) | native::CallbackRejection::NoCode => {
                    Failure::CallbackRefused
                }
            };

            return Err(SurfaceLoginError::new(failure, rejection.to_string()));
        }
        Ok(Err(LoopbackFailure::TimedOut)) => {
            return Err(SurfaceLoginError::new(Failure::TimedOut, SIGN_IN_TIMED_OUT));
        }
        Ok(Err(LoopbackFailure::Listener(message))) => {
            return Err(SurfaceLoginError::new(Failure::Listener, message));
        }
        Err(SurfaceStop::Refused) => {
            return Err(SurfaceLoginError::new(
                Failure::NavigationRefused,
                refused_navigation_message(&authorize_url),
            ));
        }
        // No watch was set, so `Watched` cannot happen; it is still a stop, not a success.
        Err(SurfaceStop::Cancelled | SurfaceStop::Watched) => {
            return Err(SurfaceLoginError::new(
                Failure::Cancelled,
                cancelled_message(),
            ));
        }
    };

    let tokens = post_native_tokens(
        state,
        base,
        "/auth/native/token",
        serde_json::json!({ "code": code, "code_verifier": pkce.verifier }),
    )
    .await
    .map_err(|e| SurfaceLoginError::new(e.surface_failure(), e.message))?;

    // NOT survivable, on either platform. A token set that did not reach the keyring
    // cannot be read back by `ensure_native_tokens`, so returning `Ok` here hands the
    // caller a signed-in answer for a session that is already dead. On mobile the write
    // also has to land BEFORE the caller navigates back: the restore reloads the SPA,
    // whose boot calls `oauth_status` — i.e. reads this exact keyring entry — within a
    // tick or two.
    //
    // Failing is also the gentler option on desktop: `oauth_login` then drops through to
    // the cookie cascade (see `SurfaceLoginFailure::navigated`), so a machine whose
    // keyring genuinely does not work (a Linux box with no Secret Service) degrades to
    // the flow that predates this one instead of dead-ending.
    store_native_tokens(surface.app, state, base, &tokens).map_err(|e| {
        SurfaceLoginError::new(
            Failure::NotSaved,
            format!("Signed in, but the credential could not be saved: {e}"),
        )
    })?;

    log::info!("[oauth] native sign-in complete for base={base}");

    Ok(tokens)
}

/// What a cancelled hop reports on this platform.
fn cancelled_message() -> String {
    #[cfg(desktop)]
    {
        SIGN_IN_WINDOW_CLOSED.to_string()
    }

    #[cfg(mobile)]
    {
        "Sign-in was cancelled".to_string()
    }
}

/// What a refused navigation reports. Only mobile can detect one.
fn refused_navigation_message(url: &Url) -> String {
    #[cfg(desktop)]
    {
        format!(
            "The sign-in page at {} could not be opened.",
            url.origin().ascii_serialization()
        )
    }

    #[cfg(mobile)]
    {
        navigation_refused(url)
    }
}

/// Run the RFC 8252 login end to end for `oauth_login`: one hop on the caller's surface,
/// then put the surface away.
///
/// The platforms split only on *how the user reaches the authorize URL and how they get
/// back* — desktop in our own window, mobile in the calling webview (see the module note
/// for why neither uses the system browser) — and that split lives in [`SignInSurface`].
async fn run_native_login(
    app: &AppHandle,
    webview: &WebviewWindow,
    surface_lease: &SurfaceLease,
    state: &TransportState,
    base: &str,
    provider: &str,
) -> Result<native::NativeTokenSet, NativeLoginError> {
    let mut surface = SignInSurface::new(app, webview, surface_lease);
    let outcome = native_login_on_surface(&mut surface, state, base, provider).await;

    // Restore the app — unless the navigation was refused (or never issued), in which
    // case we never left and the SPA is still live (the same call the cookie cascade and
    // `cloud.rs::portal_login` skip for that case). On success the tokens are already in
    // the keyring, which the reload this triggers is about to read. Desktop: the window
    // is already closed, and this is a no-op.
    surface.finish();

    outcome.map_err(|e| NativeLoginError {
        navigated: e.failure.navigated(cfg!(desktop)),
        message: e.message,
    })
}

/// Why the sign-in webview stopped being somewhere useful.
#[cfg(mobile)]
enum Departure {
    /// It never left the page it was on — the platform refused the load.
    Refused,
    /// It left, and then came back to the app on its own: the user backed out.
    Abandoned,
}

/// Resolve only when the sign-in is no longer reachable, so the caller can stop
/// waiting on a callback that is not coming.
///
/// Two distinct cases, and both used to cost the entire budget. A refusal is the
/// existing `navigation_committed` check, measured from the page this hop left
/// (`nav_from`). An abandon is what makes a four-minute budget tolerable: Android's
/// hardware back pops the webview's history, which lands it back on the app's own
/// origin, and there is no other way to cancel while the app UI is away. It is measured
/// against the app ([`AppReturn::is_home`]) — never against the page this hop left,
/// which on a second hop is our own loopback page.
///
/// Two consecutive readings before calling it, so a transient unreadable `url()`
/// cannot cancel a live sign-in.
#[cfg(mobile)]
async fn watch_for_departure(
    webview: &WebviewWindow,
    nav_from: &Url,
    home: &AppReturn,
) -> Departure {
    if !navigation_committed(webview, nav_from).await {
        return Departure::Refused;
    }

    let mut back_home = 0u8;

    loop {
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;

        match webview.url() {
            Ok(now) if home.is_home(&now) => {
                back_home += 1;

                if back_home >= 2 {
                    return Departure::Abandoned;
                }
            }
            _ => back_home = 0,
        }
    }
}

/// One refresh at a time, per gateway.
///
/// Nothing used to serialise `ensure_native_tokens`, and on boot several callers
/// reach it at once — `oauth_status`, every `transport::http_request`, every
/// `files.rs` transfer. Each loaded the SAME refresh token and POSTed it. The
/// gateway rotates refresh tokens with reuse detection, so the first rotation
/// invalidated the token the others were already presenting: every loser got a
/// 401 and (before this change) deleted the winner's freshly stored rotation.
/// The user then had to sign in interactively on every single launch, which is
/// exactly what the device log shows — a refresh 401 as line one, every time.
///
/// Keyed by base because two gateways have two unrelated grants. A `tokio` mutex,
/// not a `std` one: it is held across the refresh `.await`.
static REFRESH_GATES: std::sync::Mutex<
    std::collections::BTreeMap<String, std::sync::Arc<tokio::sync::Mutex<()>>>,
> = std::sync::Mutex::new(std::collections::BTreeMap::new());

fn refresh_gate(base: &str) -> std::sync::Arc<tokio::sync::Mutex<()>> {
    // A poisoned registry is recovered rather than propagated: the guarded value
    // is a map of handles with no invariant to corrupt, and refusing to refresh
    // for the rest of the process would be far worse than the panic that poisoned
    // it. Mirrors `claim_sign_in`.
    let mut gates = match REFRESH_GATES.lock() {
        Ok(gates) => gates,
        Err(poisoned) => poisoned.into_inner(),
    };

    gates.entry(base.to_string()).or_default().clone()
}

/// The live token set for this gateway, refreshing first when the stored access
/// token is at or inside the skew window (or when `force_refresh` says the
/// gateway just rejected it). `None` means "no native session" — the caller falls
/// back to the cookie jar, exactly as before.
///
/// A REFUSAL from `/auth/native/refresh` (401/403) clears the stored set: a
/// refresh token the gateway will not rotate is dead, and keeping it would make
/// every later call spend a doomed round trip.
///
/// An UNREACHABLE gateway does not. That distinction is the whole point: this
/// used to clear on any `Err`, so a phone that lost signal for one request threw
/// away a working session and forced an interactive sign-in to get it back. When
/// the refresh cannot be completed we hand back the set we already hold — stale
/// or not, presenting it costs one round trip and `transport.rs`'s 401 ladder is
/// there to catch it if the gateway really has moved on.
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

    // Everything below rotates the grant, so only one caller per gateway may run it.
    let gate = refresh_gate(base);
    let _guard = gate.lock().await;

    // Re-read under the gate. If someone rotated while we queued, THAT is the answer —
    // re-POSTing the refresh token they just consumed is precisely the reuse-detection
    // cascade this gate exists to stop. The access-token comparison is what keeps a
    // `force_refresh` caller honest: it was sent here because the gateway rejected a
    // specific bearer, so it may only accept a set that is demonstrably a different one.
    if let Some(rotated) = state.cached_bearer_tokens(base) {
        if rotated.access_token != tokens.access_token
            && !native::needs_refresh(&rotated, now_secs())
        {
            return Some(rotated);
        }
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
        Err(e) if e.credential_rejected() => {
            log::info!("[oauth] native refresh was refused, dropping the stored session: {e}");
            clear_native_tokens(app, state, base);

            None
        }
        Err(e) => {
            // Unreachable, 5xx, or an unreadable body. None of those say the grant is
            // dead, so the session stays exactly where it is and we retry on the next
            // call. Handing back the set we hold keeps requests flowing the moment the
            // network returns, instead of stranding a signed-in user on a sign-in CTA.
            log::info!("[oauth] native refresh could not be completed, keeping the session: {e}");

            Some(tokens)
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
) -> Result<SignInOutcome, String> {
    // Before anything else, and held for the whole command: three callers can drive a
    // sign-in and none of them coordinate. See `SIGN_IN_IN_FLIGHT`.
    //
    // Losing the race is reported, not raised. The caller must be able to tell "another
    // flow owns this" from "your sign-in failed", because the two demand opposite
    // reactions — defer quietly, versus tear down the resume state and surface an error.
    let Some(_lease) = claim_sign_in(webview.label()) else {
        return Ok(SignInOutcome::busy());
    };
    // And the surface: on desktop the sign-in window is ONE global label, which the
    // Allr Work sign-in (and any other window's `oauth_login`) uses too.
    let Some(surface_lease) = claim_surface() else {
        return Ok(SignInOutcome::busy());
    };

    run_oauth_login(app, webview, state, base, provider, &surface_lease).await?;

    Ok(SignInOutcome::started())
}

/// What an `oauth_login` call actually did.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignInOutcome {
    /// True when another sign-in already owned this webview, so this call did
    /// nothing at all. Not an error: the flow the user asked for is still running,
    /// and the caller must leave its state — above all the resume marker — alone.
    busy: bool,
}

impl SignInOutcome {
    fn busy() -> Self {
        Self { busy: true }
    }

    fn started() -> Self {
        Self { busy: false }
    }
}

/// The sign-in itself, once the lease is held.
///
/// Split from the command purely so the lease has exactly one claim site and one
/// scope — this body has a dozen early returns across two platform arms.
async fn run_oauth_login(
    app: AppHandle,
    webview: WebviewWindow,
    state: State<'_, TransportState>,
    base: String,
    provider: Option<String>,
    surface_lease: &SurfaceLease,
) -> Result<(), String> {
    let base = normalize_base(&base);
    // The two flows default differently: the native route auto-picks its provider, the
    // cascade has no such fallback. See `native::providers_for_flows`.
    let (native_provider, provider) = native::providers_for_flows(provider);
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

        match run_native_login(
            &app,
            &webview,
            surface_lease,
            state.inner(),
            &base,
            &native_provider,
        )
        .await
        {
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

        open_sign_in_window(&app, login_url, surface_lease).await?;

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
    /// Whether we actually got an answer. `false` means "could not tell" — the
    /// gateway was unreachable or answered a server error — and is NOT the same
    /// as signed out.
    ///
    /// Without this the reply had only two states, so an unreachable gateway was
    /// indistinguishable from a revoked session and the caller sent a signed-in
    /// user to an interactive sign-in for what was really a dropped connection.
    /// Callers must branch on all three: signed in, signed out, or unknown.
    reachable: bool,
    /// Why we could not tell, when `reachable` is false. Already redacted.
    error: Option<String>,
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
            reachable: true,
            error: None,
            email: None,
            display_name: None,
            session_kind: None,
        }
    }

    /// We hold (or held) a session but could not confirm it. The caller must treat
    /// this as a network fault and retry, never as a reason to sign in again.
    fn unknown(error: String) -> Self {
        Self {
            signed_in: false,
            reachable: false,
            error: Some(error),
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
            reachable: true,
            error: None,
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
    let had_bearer = tokens.is_some();

    let url = format!("{base}/api/auth/me");
    // Redirects OFF. A gateway's `/api/auth/me` has no legitimate redirect, but an edge in
    // front of it does: behind Pomerium the followed chain ended on Dex's HTML login page
    // with a 200, which read as a live cookie session for a workspace we hold nothing for.
    // The redirect itself is the answer — see `native::classify_auth_me`.
    let mut request = state
        .no_redirect_client()
        .get(&url)
        .header(reqwest::header::ORIGIN, &base);

    if let Some(set) = tokens.as_ref() {
        request = request.bearer_auth(&set.access_token);
    }

    // `redact_error` and not `redact_bearer` alone: reqwest quotes the request
    // URL back at us, and a hand-typed base can carry a basic-auth password in
    // its userinfo. This string is rendered on the connect screen.
    // An unreachable gateway is reported, not raised. Raising sent every caller
    // through `.catch(() => ({ signedIn: false }))`, which turned "the network is
    // down" into "you are signed out" and pushed the user at a sign-in button that
    // could not possibly help.
    let resp = match request.send().await {
        Ok(resp) => resp,
        Err(e) => {
            return Ok(OauthStatus::unknown(format!(
                "auth/me request failed: {}",
                crate::transport::redact_error(e.to_string(), &url)
            )));
        }
    };

    let status = resp.status();

    // Where a redirect points decides what it means: off the host is an edge's sign-in,
    // on the host is the gateway's own address having moved. See `classify_auth_me`.
    let redirect = status.is_redirection().then(|| {
        let location = resp
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|value| value.to_str().ok());

        match Url::parse(&url) {
            Ok(requested) => native::redirect_target(&requested, location),
            Err(_) => native::RedirectTarget::Unreadable,
        }
    });

    // Only a 2xx can make a session live, so only a 2xx body is read — and it has to be a
    // JSON object to count.
    let body = if status.is_success() {
        resp.bytes()
            .await
            .ok()
            .and_then(|bytes| auth_me_json_object(&bytes))
    } else {
        None
    };

    let verdict = native::classify_auth_me(
        status.as_u16(),
        had_bearer,
        body.is_some(),
        redirect.as_ref(),
    );
    let (reply, clear_tokens) = status_for_auth_me(verdict, body.as_ref(), tokens.as_ref());

    // A bearer the gateway REFUSES is dead (the middleware answers a bad bearer with 401
    // rather than falling through to the cookie), so drop it instead of re-presenting it
    // on every probe. Nothing else clears it: a 502 from a proxy or a 503 from a gateway
    // still booting is the gateway's problem, not the credential's.
    if clear_tokens {
        clear_native_tokens(&app, state.inner(), &base);
    }

    Ok(reply)
}

/// An `/api/auth/me` body, if it is a JSON object — the only shape a gateway answers with.
///
/// Anything else is not the gateway talking: an unreadable body used to parse to `Null`
/// and still report "signed in", which is exactly the answer an edge's HTML login page
/// produced at the end of a followed redirect.
fn auth_me_json_object(bytes: &[u8]) -> Option<serde_json::Value> {
    serde_json::from_slice::<serde_json::Value>(bytes)
        .ok()
        .filter(serde_json::Value::is_object)
}

/// The `oauth_status` reply for one `/api/auth/me` verdict, and whether the bearer that
/// was presented must be dropped. Split out so the mapping is testable without a gateway.
fn status_for_auth_me(
    verdict: native::AuthMeVerdict,
    body: Option<&serde_json::Value>,
    tokens: Option<&native::NativeTokenSet>,
) -> (OauthStatus, bool) {
    match verdict {
        native::AuthMeVerdict::Live => (
            OauthStatus::live(body.unwrap_or(&serde_json::Value::Null), tokens),
            false,
        ),
        native::AuthMeVerdict::SignedOut { clear_tokens } => {
            (OauthStatus::signed_out(), clear_tokens)
        }
        native::AuthMeVerdict::Unknown(reason) => (OauthStatus::unknown(reason), false),
    }
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
        assert!(claim_sign_in("lease-test-main").is_none());

        drop(first);

        // And the slot is usable again afterwards — a lease that leaked on any of
        // `oauth_login`'s early returns would wedge sign-in for the whole process.
        assert!(claim_sign_in("lease-test-main").is_some());
    }

    /// Losing the race is `None`, never an `Err`, and the difference is the whole
    /// reason `SignInOutcome` exists.
    ///
    /// `beginOAuthLogin` reads a rejection as proof that it never navigated, and
    /// responds by clearing the one-shot resume marker. That marker is global, so
    /// the loser was deleting the WINNER's: the user finished signing in, the SPA
    /// reloaded, found nothing to resume, and landed back on the connect screen.
    #[test]
    fn losing_the_race_is_reported_as_busy_rather_than_as_a_failure() {
        let _held = claim_sign_in("lease-test-busy").expect("the first claim wins");

        let outcome = match claim_sign_in("lease-test-busy") {
            Some(_) => SignInOutcome::started(),
            None => SignInOutcome::busy(),
        };

        let json = serde_json::to_string(&outcome).unwrap();

        assert_eq!(json, r#"{"busy":true}"#);
    }

    #[test]
    fn a_sign_in_that_actually_ran_is_not_busy() {
        let json = serde_json::to_string(&SignInOutcome::started()).unwrap();

        assert_eq!(json, r#"{"busy":false}"#);
    }

    #[test]
    fn a_different_webview_has_its_own_slot() {
        // Desktop can legitimately sign two windows in to two gateways at once, so the
        // lease must not be global.
        let _a = claim_sign_in("lease-test-alpha").expect("alpha");
        let _b = claim_sign_in("lease-test-beta").expect("beta is a separate webview");
    }

    /// The one desktop sign-in window is owned by one flow at a time — whichever command
    /// asks, `oauth_login` or `allr_work_sign_in` — so neither can rebuild it under the
    /// other. The only test that claims the window label, so it cannot race another.
    #[cfg(desktop)]
    #[test]
    fn the_desktop_sign_in_window_admits_one_flow_at_a_time() {
        let first = claim_surface().expect("the first flow gets the window");

        assert!(
            claim_surface().is_none(),
            "a second flow must defer, not take the window over"
        );
        // It is the same registry the caller slots use, keyed by the window's label.
        assert!(claim_sign_in(OAUTH_WINDOW_LABEL).is_none());

        drop(first);

        assert!(
            claim_surface().is_some(),
            "and the window is free again once the first flow ends"
        );
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

    // ── The loopback listener, generalised (ALLR-51) ─────────────────────────
    //
    // The same accept loop now serves the Allr Work hand-back. What has to hold for it is
    // what held for the callback: probes resolve nothing, the first real hit does, and the
    // page served never echoes what the request carried.

    const HANDOFF_STATE: &str = "Zm9vYmFyYmF6cXV4LWFiY2RlZmdoaWpr";

    /// Connect, send one request line, and read the whole reply — the page the webview
    /// would render.
    fn request_and_read(port: u16, target: String) -> tokio::task::JoinHandle<String> {
        tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};

            let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .unwrap();

            stream
                .write_all(format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").as_bytes())
                .await
                .unwrap();

            let mut reply = String::new();
            let _ = stream.read_to_string(&mut reply).await;

            reply
        })
    }

    fn handoff_parser(
    ) -> impl Fn(&str) -> Option<Result<Url, crate::allr_work::decide::AllrWorkError>>
           + Send
           + Sync
           + 'static {
        let cfg = crate::allr_work::decide::portal_config("https://app.allr.work").unwrap();

        move |target| crate::allr_work::decide::parse_handoff_target(target, HANDOFF_STATE, &cfg)
    }

    #[tokio::test]
    async fn the_handoff_parser_waits_past_a_probe_and_resolves_on_the_real_hit() {
        let (listener, port) = bound_listener().await;

        let probe = request_and_read(port, "/favicon.ico".to_string());
        let hit = request_and_read(
            port,
            format!("/workspace?workspace=https%3A%2F%2Fxm.allr.work&state={HANDOFF_STATE}"),
        );

        let workspace = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            await_loopback(
                listener,
                handoff_parser(),
                native::CallbackPage::WorkspaceFound,
                10,
                true,
            ),
        )
        .await
        .expect("the real hit must resolve the wait")
        .expect("no listener failure")
        .expect("a valid hand-back");

        assert_eq!(workspace.as_str(), "https://xm.allr.work/");

        // The hit is answered with the hop-1 page, and it echoes nothing it was sent.
        let page = hit.await.unwrap();
        assert!(page.contains("Opening your workspace"), "{page}");
        for echoed in [HANDOFF_STATE, "xm.allr.work", "workspace="] {
            assert!(!page.contains(echoed), "{echoed} in {page}");
        }
        // The probe got the failure page, exactly as a callback probe always has.
        assert!(probe.await.unwrap().contains("Sign-in failed"));
    }

    #[test]
    fn each_parser_reads_only_its_own_path() {
        // Distinct paths are what stop a hand-back being read as a code callback, or the
        // reverse. Each query below is a VALID verdict for the parser it is not sent to.
        let handoff = handoff_parser();
        let callback = callback_parser("xyz".to_string());

        assert!(handoff(&format!(
            "/callback?workspace=https%3A%2F%2Fxm.allr.work&state={HANDOFF_STATE}"
        ))
        .is_none());
        assert!(callback("/workspace?code=abc123&state=xyz").is_none());

        // …and each does read its own.
        assert!(matches!(
            handoff(&format!(
                "/workspace?workspace=https%3A%2F%2Fxm.allr.work&state={HANDOFF_STATE}"
            )),
            Some(Ok(_))
        ));
        assert_eq!(
            callback("/callback?code=abc123&state=xyz"),
            Some(Ok("abc123".to_string()))
        );
    }

    #[tokio::test]
    async fn a_stray_hit_on_the_other_path_cannot_decide_either_listener() {
        // The stray is answered in full BEFORE the real hit is sent, so a listener that
        // mis-read it would already have resolved — with the stray's DIFFERENT verdict
        // (another workspace, another code) — and the assertions below would see that.
        let (listener, port) = bound_listener().await;
        let wait = tokio::spawn(await_loopback(
            listener,
            handoff_parser(),
            native::CallbackPage::WorkspaceFound,
            10,
            true,
        ));

        request_and_read(
            port,
            format!("/callback?workspace=https%3A%2F%2Fother.allr.work&state={HANDOFF_STATE}"),
        )
        .await
        .unwrap();
        let _hit = request_and_read(
            port,
            format!("/workspace?workspace=https%3A%2F%2Fxm.allr.work&state={HANDOFF_STATE}"),
        );

        let workspace = wait.await.unwrap().unwrap().expect("the real hand-back");
        assert_eq!(workspace.as_str(), "https://xm.allr.work/");

        let (listener, port) = bound_listener().await;
        let wait = tokio::spawn(await_loopback(
            listener,
            callback_parser("xyz".to_string()),
            native::CallbackPage::SignedIn,
            10,
            true,
        ));

        request_and_read(port, "/workspace?code=stray&state=xyz".to_string())
            .await
            .unwrap();
        let _hit = request_and_read(port, "/callback?code=abc123&state=xyz".to_string());

        assert_eq!(wait.await.unwrap().unwrap(), Ok("abc123".to_string()));
    }

    #[tokio::test]
    async fn a_handoff_verdict_error_resolves_the_wait_with_the_failure_page() {
        // First verdict wins, Ok OR Err — so a hand-back naming a reserved host ends hop 1
        // at once instead of waiting out the budget, and the page says it failed.
        let (listener, port) = bound_listener().await;
        let hit = request_and_read(
            port,
            format!("/workspace?workspace=https%3A%2F%2Fauth.allr.work&state={HANDOFF_STATE}"),
        );

        let verdict = await_loopback(
            listener,
            handoff_parser(),
            native::CallbackPage::WorkspaceFound,
            10,
            true,
        )
        .await
        .unwrap();

        assert_eq!(
            verdict.unwrap_err().kind,
            crate::allr_work::decide::AllrWorkErrorKind::InvalidWorkspace
        );
        assert!(hit.await.unwrap().contains("Sign-in failed"));
    }

    #[tokio::test]
    async fn the_generic_wait_reports_a_timeout_as_a_timeout() {
        let (listener, _port) = bound_listener().await;

        let failure = await_loopback(
            listener,
            handoff_parser(),
            native::CallbackPage::WorkspaceFound,
            1,
            true,
        )
        .await
        .unwrap_err();

        assert!(matches!(failure, LoopbackFailure::TimedOut), "{failure:?}");
    }

    #[test]
    fn the_callback_rejection_keeps_the_messages_oauth_login_always_reported() {
        use native::CallbackRejection;

        assert_eq!(
            native::parse_callback("/callback?code=abc&state=other", "xyz"),
            Err(CallbackRejection::StateMismatch)
        );
        assert_eq!(
            native::parse_callback("/callback?error=access_denied&state=xyz", "xyz"),
            Err(CallbackRejection::Refused("access_denied".into()))
        );
        assert_eq!(
            native::parse_callback("/callback?state=xyz", "xyz"),
            Err(CallbackRejection::NoCode)
        );

        for (target, message) in [
            (
                "/callback?code=abc&state=other",
                "sign-in callback did not match this request",
            ),
            (
                "/callback?error=access_denied&state=xyz",
                "sign-in was refused: access_denied",
            ),
            (
                "/callback?state=xyz",
                "sign-in callback carried no authorization code",
            ),
        ] {
            assert_eq!(
                native::parse_callback_target(target, "xyz").unwrap_err(),
                message
            );
        }
    }

    #[test]
    fn the_workspace_found_page_is_static() {
        for (ok, in_app) in [(true, true), (true, false), (false, true), (false, false)] {
            let page = native::workspace_found_response(ok, in_app);

            assert!(page.contains("Content-Length:"), "{page}");
            assert!(!page.contains("state="), "{page}");
            assert!(!page.contains("src="), "no external resources: {page}");
            // The failure page is the callback's own, byte for byte.
            if !ok {
                assert_eq!(page, native::callback_response(false, in_app));
            }
        }

        // And the signed-in listener still answers with the page it always has.
        assert_eq!(
            native::loopback_response(native::CallbackPage::SignedIn, true, true),
            native::callback_response(true, true)
        );
    }

    // ── The sign-in surface ──────────────────────────────────────────────────

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    /// The mobile surface's second hop starts from our own loopback page. Every "where is
    /// home" question it asks must still be answered against the app URL captured before
    /// the FIRST hop.
    #[test]
    fn hop2_compares_against_original_app_url() {
        let app = url("tauri://localhost/#/settings/gateway");
        let portal = url("https://app.allr.work/?redirect_uri=http%3A%2F%2F127.0.0.1%3A51234%2Fworkspace&state=s1");
        let loopback =
            url("http://127.0.0.1:51234/workspace?workspace=https%3A%2F%2Fxm.allr.work&state=s1");
        let authorize = url("https://xm.allr.work/auth/native/authorize?state=s2");

        let mut home = AppReturn::capture(app.clone());

        // Hop 1 leaves from the app.
        assert_eq!(home.begin_hop(Some(&app), &portal), Ok(app.clone()));
        home.hop_settled(false);

        // Hop 2 reads the loopback page as the page it is LEAVING (so a refused hop-2
        // navigation is still detectable)…
        assert_eq!(
            home.begin_hop(Some(&loopback), &authorize),
            Ok(loopback.clone())
        );

        // …but home is still the app: backing out to it is noticed, the loopback page is
        // not mistaken for it, and the restore goes to the app with its route intact.
        assert!(home.is_home(&url("tauri://localhost/#/chat")));
        assert!(!home.is_home(&loopback));
        assert!(!home.is_home(&authorize));
        assert_eq!(home.app_url(), &app);
        assert!(home.must_restore());

        // The already-on-the-sign-in-page refusal is measured from the APP too: a hop-2
        // target on the loopback page's origin is not refused, one on the app's origin is.
        assert_eq!(
            home.begin_hop(Some(&loopback), &url("http://127.0.0.1:51234/elsewhere")),
            Ok(loopback.clone())
        );
        assert_eq!(
            home.begin_hop(Some(&loopback), &url("tauri://localhost/login")),
            Err(HopRefusal::OnSignInPage)
        );

        // An unreadable URL before a hop falls back to the app, never to nothing.
        assert_eq!(home.begin_hop(None, &authorize), Ok(app.clone()));
    }

    #[test]
    fn backing_out_to_the_app_between_hops_cancels_the_next_hop_without_a_restore() {
        let app = url("tauri://localhost/#/settings/gateway");
        let portal = url("https://app.allr.work/?state=s1");
        let authorize = url("https://xm.allr.work/auth/native/authorize?state=s2");
        let mut home = AppReturn::capture(app.clone());

        // The FIRST hop starts on the app by definition; that is not a back-out.
        assert_eq!(home.begin_hop(Some(&app), &portal), Ok(app.clone()));
        home.hop_settled(false);
        assert!(home.must_restore());

        // Between hops the user pressed back to the app (a different route, same origin).
        assert_eq!(
            home.begin_hop(Some(&url("tauri://localhost/#/chat")), &authorize),
            Err(HopRefusal::BackHome)
        );
        // Already home: no second reload, nothing to park.
        assert!(!home.must_restore());
    }

    #[test]
    fn a_refused_first_hop_has_nothing_to_restore_but_a_refused_later_hop_does() {
        let app = url("http://tauri.localhost/");
        let mut home = AppReturn::capture(app.clone());

        // The first hop is already refused when the app IS the sign-in origin.
        assert_eq!(
            home.begin_hop(Some(&app), &url("http://tauri.localhost/auth")),
            Err(HopRefusal::OnSignInPage)
        );

        home.hop_settled(true);
        assert!(!home.must_restore(), "never left, so the SPA is still live");

        home.hop_settled(false);
        home.hop_settled(true);
        assert!(
            home.must_restore(),
            "hop 1 took the UI away; a hop-2 refusal cannot undo that"
        );
    }

    #[test]
    fn only_a_cancel_stops_the_desktop_cascade_fallback() {
        use SurfaceLoginFailure as F;

        for failure in [
            F::Setup,
            F::AlreadyOnSignInPage,
            F::SurfaceUnavailable,
            F::NavigationRefused,
            F::TimedOut,
            F::Listener,
            F::StateMismatch,
            F::CallbackRefused,
            F::TokenRejected,
            F::TokenUnreachable,
            F::NotSaved,
        ] {
            assert!(!failure.navigated(true), "{failure:?}");
        }

        assert!(F::Cancelled.navigated(true));
    }

    #[test]
    fn on_mobile_only_a_failure_before_the_navigation_allows_the_cascade() {
        use SurfaceLoginFailure as F;

        for failure in [F::Setup, F::AlreadyOnSignInPage, F::SurfaceUnavailable] {
            assert!(!failure.navigated(false), "{failure:?}");
        }

        for failure in [
            F::Cancelled,
            F::NavigationRefused,
            F::TimedOut,
            F::Listener,
            F::StateMismatch,
            F::CallbackRefused,
            F::TokenRejected,
            F::TokenUnreachable,
            F::NotSaved,
        ] {
            assert!(failure.navigated(false), "{failure:?}");
        }
    }

    // ---------------------------------------------------------------------
    // Credential lifecycle: WHICH failures are allowed to end a session.
    //
    // `ensure_native_tokens` used to clear the keyring on any `Err` from the
    // refresh POST, so one unreachable moment on a phone threw away a working
    // grant and forced an interactive sign-in. These pin the classification it
    // now branches on; `post_native_tokens` is driven against a real loopback
    // socket so the status really does come off the wire.
    // ---------------------------------------------------------------------

    /// Answer exactly one request with a canned status, then hang up.
    fn serve_once(
        listener: tokio::net::TcpListener,
        status_line: &'static str,
        body: &'static str,
    ) {
        tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};

            let Ok((mut sock, _)) = listener.accept().await else {
                return;
            };

            let mut buf = [0u8; 2048];
            let _ = sock.read(&mut buf).await;

            let reply = format!(
                "HTTP/1.1 {status_line}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );

            let _ = sock.write_all(reply.as_bytes()).await;
            let _ = sock.flush().await;
        });
    }

    async fn refresh_against(status_line: &'static str, body: &'static str) -> TokenPostError {
        let (listener, port) = bound_listener().await;
        serve_once(listener, status_line, body);

        let state = TransportState::new();

        post_native_tokens(
            &state,
            &format!("http://127.0.0.1:{port}"),
            "/auth/native/refresh",
            serde_json::json!({ "refresh_token": "rt-secret", "provider": "nous" }),
        )
        .await
        .expect_err("the canned reply is never a success")
    }

    #[tokio::test]
    async fn a_refused_refresh_is_a_credential_rejection() {
        let err = refresh_against("401 Unauthorized", "{}").await;

        assert_eq!(err.status, Some(401));
        assert!(err.credential_rejected(), "{err}");
    }

    #[tokio::test]
    async fn a_forbidden_refresh_is_a_credential_rejection() {
        assert!(refresh_against("403 Forbidden", "{}")
            .await
            .credential_rejected());
    }

    /// The regression this whole change exists for. A gateway that is restarting
    /// answers 502/503; treating that as a dead grant is what cost the user a
    /// sign-in every time the server bounced.
    #[tokio::test]
    async fn a_gateway_error_never_ends_the_session() {
        for status in [
            "500 Internal Server Error",
            "502 Bad Gateway",
            "503 Service Unavailable",
        ] {
            let err = refresh_against(status, "{}").await;

            assert!(
                !err.credential_rejected(),
                "{status} must not be read as a refusal: {err}"
            );
        }
    }

    #[tokio::test]
    async fn a_rate_limit_never_ends_the_session() {
        assert!(!refresh_against("429 Too Many Requests", "{}")
            .await
            .credential_rejected());
    }

    /// No answer at all says nothing about the credential — this is the flaky
    /// network in the device log.
    #[tokio::test]
    async fn an_unreachable_gateway_never_ends_the_session() {
        let (listener, port) = bound_listener().await;
        drop(listener); // nothing is listening on `port` any more

        let state = TransportState::new();

        let err = post_native_tokens(
            &state,
            &format!("http://127.0.0.1:{port}"),
            "/auth/native/refresh",
            serde_json::json!({ "refresh_token": "rt-secret", "provider": "nous" }),
        )
        .await
        .expect_err("nothing is listening");

        assert_eq!(err.status, None);
        assert!(!err.credential_rejected(), "{err}");
    }

    /// A 2xx the gateway answered with an unreadable body is the body's fault,
    /// not the grant's.
    #[tokio::test]
    async fn an_unreadable_success_body_never_ends_the_session() {
        let err = refresh_against("200 OK", "{ not json").await;

        assert!(!err.credential_rejected(), "{err}");
    }

    #[tokio::test]
    async fn a_token_exchange_that_was_answered_is_a_rejection_not_unreachable() {
        // A refusal, and a 2xx with a body that is not a token set: the workspace was
        // reached both times.
        for (status, body) in [
            ("401 Unauthorized", "{}"),
            ("400 Bad Request", "{}"),
            ("200 OK", "{ not json"),
            ("200 OK", "{}"),
        ] {
            assert_eq!(
                refresh_against(status, body).await.surface_failure(),
                SurfaceLoginFailure::TokenRejected,
                "{status} {body}"
            );
        }
    }

    #[tokio::test]
    async fn a_token_exchange_that_got_no_answer_is_unreachable() {
        let (listener, port) = bound_listener().await;
        drop(listener);

        let err = post_native_tokens(
            &TransportState::new(),
            &format!("http://127.0.0.1:{port}"),
            "/auth/native/token",
            serde_json::json!({ "code": "c", "code_verifier": "v" }),
        )
        .await
        .expect_err("nothing is listening");

        assert_eq!(err.surface_failure(), SurfaceLoginFailure::TokenUnreachable);
    }

    #[tokio::test]
    async fn the_refresh_error_never_quotes_the_refresh_token() {
        let err = refresh_against("401 Unauthorized", "{}").await;

        assert!(!err.message.contains("rt-secret"), "{err}");
    }

    // --- the per-gateway refresh gate ---

    #[test]
    fn one_gateway_shares_a_single_refresh_gate() {
        let base = "https://gate-shared.example";

        assert!(std::sync::Arc::ptr_eq(
            &refresh_gate(base),
            &refresh_gate(base)
        ));
    }

    #[test]
    fn two_gateways_do_not_block_each_other() {
        assert!(!std::sync::Arc::ptr_eq(
            &refresh_gate("https://gate-a.example"),
            &refresh_gate("https://gate-b.example")
        ));
    }

    #[tokio::test]
    async fn the_gate_admits_one_refresher_at_a_time() {
        let gate = refresh_gate("https://gate-serialised.example");
        let held = gate.lock().await;

        assert!(
            gate.try_lock().is_err(),
            "a second refresher must queue behind the first, not race it"
        );

        drop(held);
        assert!(
            gate.try_lock().is_ok(),
            "the gate reopens once the winner is done"
        );
    }

    // --- the third status state ---

    #[test]
    fn an_unknown_status_is_not_a_signed_out_status() {
        let json = serde_json::to_string(&OauthStatus::unknown("host is down".into())).unwrap();

        assert!(json.contains("\"reachable\":false"), "{json}");
        assert!(json.contains("\"signedIn\":false"), "{json}");
        assert!(json.contains("host is down"), "{json}");
    }

    #[test]
    fn a_signed_out_status_says_the_gateway_answered() {
        let json = serde_json::to_string(&OauthStatus::signed_out()).unwrap();

        assert!(json.contains("\"reachable\":true"), "{json}");
    }

    #[test]
    fn a_live_status_says_the_gateway_answered() {
        let json =
            serde_json::to_string(&OauthStatus::live(&me_body(), Some(&token_set()))).unwrap();

        assert!(json.contains("\"reachable\":true"), "{json}");
        assert!(json.contains("\"signedIn\":true"), "{json}");
    }

    // --- `oauth_status` through `classify_auth_me` (ALLR-51) ---

    fn status_json(
        status: u16,
        tokens: Option<&native::NativeTokenSet>,
        body: Option<serde_json::Value>,
    ) -> (serde_json::Value, bool) {
        let redirect = (300..400)
            .contains(&status)
            .then_some(native::RedirectTarget::OtherHost);
        let verdict =
            native::classify_auth_me(status, tokens.is_some(), body.is_some(), redirect.as_ref());
        let (reply, clear) = status_for_auth_me(verdict, body.as_ref(), tokens);

        (serde_json::to_value(&reply).unwrap(), clear)
    }

    #[test]
    fn only_a_json_object_counts_as_an_auth_me_body() {
        // What a followed Pomerium redirect used to end on: Dex's login page.
        let dex = br#"<!DOCTYPE html>
<html>
  <head><meta charset="utf-8"><title>dex</title>
  <link href="/theme/styles.css" rel="stylesheet"></head>
  <body class="theme-body"><div class="theme-panel">
    <h2 class="theme-heading">Log in to Your Account</h2>
    <form method="post" action="/auth/local/login?back=&amp;state=abc">
      <input type="text" name="login" placeholder="email address" autofocus>
      <input type="password" name="password" placeholder="password">
      <button type="submit">Login</button>
    </form>
  </div></body>
</html>"#;

        for body in [
            &dex[..],
            b"",
            b"null",
            b"[]",
            b"\"signed in\"",
            b"true",
            b"{ not json",
        ] {
            assert_eq!(
                auth_me_json_object(body),
                None,
                "{}",
                String::from_utf8_lossy(body)
            );
        }

        assert_eq!(
            auth_me_json_object(br#" {"email":"a@example.com"} "#),
            Some(serde_json::json!({ "email": "a@example.com" }))
        );
        assert_eq!(auth_me_json_object(b"{}"), Some(serde_json::json!({})));
    }

    #[test]
    fn a_pomerium_redirect_without_a_bearer_is_signed_out_not_a_cookie_session() {
        // The false "signed in (cookie)" this change exists for.
        let (json, clear) = status_json(302, None, None);

        assert_eq!(json["signedIn"], false);
        assert_eq!(json["reachable"], true);
        assert_eq!(json["sessionKind"], serde_json::Value::Null);
        assert!(!clear, "nothing was presented, so nothing is cleared");
    }

    #[test]
    fn a_redirect_with_a_bearer_is_unknown_and_keeps_the_tokens() {
        let (json, clear) = status_json(302, Some(&token_set()), None);

        assert_eq!(json["reachable"], false);
        assert!(!clear);
    }

    #[test]
    fn a_refused_bearer_is_signed_out_and_cleared_exactly_as_before() {
        for status in [401, 403] {
            let (json, clear) = status_json(status, Some(&token_set()), None);

            assert_eq!(json["signedIn"], false, "{status}");
            assert_eq!(json["reachable"], true, "{status}");
            assert!(clear, "{status}");
            assert!(!status_json(status, None, None).1, "{status}");
        }
    }

    #[test]
    fn a_2xx_without_a_json_object_is_unknown_not_live() {
        // `oauth_status` passes `None` for any 2xx body that is not a JSON object.
        let (json, clear) = status_json(200, None, None);

        assert_eq!(json["signedIn"], false);
        assert_eq!(json["reachable"], false);
        assert!(!clear);
    }

    #[test]
    fn a_live_native_session_still_carries_no_bearer() {
        let tokens = token_set();
        let (json, clear) = status_json(200, Some(&tokens), Some(me_body()));
        let text = json.to_string();

        assert_eq!(json["signedIn"], true);
        assert_eq!(json["sessionKind"], "native");
        assert_eq!(json["email"], "a@example.com");
        assert!(!text.contains(&tokens.access_token), "{text}");
        assert!(!clear);
    }
}
