//! Connection-level gateway OAuth (Track D3).
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
//!   2. Poll `webview.cookies_for_url({base})` — on WebKitGTK this reads the
//!      libsoup/WebKit cookie manager (HttpOnly cookies included, unlike
//!      `document.cookie`) — until the session cookie appears.
//!   3. Import those cookies into the SHARED reqwest jar via `insert_raw`, so the
//!      ws-ticket mint (driven from JS via `http_request`) is authenticated. Then
//!      close the window.
//!
//! A timeout backstops the poll so a missed / abandoned login can't hang connect().

use serde::Serialize;
use tauri::{AppHandle, Manager, State, Url, WebviewWindow};
// Desktop/iOS open a dedicated sign-in window; Android reuses the CALLING webview
// (see `oauth_login`), so these are only referenced off-Android.
#[cfg(not(target_os = "android"))]
use tauri::{WebviewUrl, WebviewWindowBuilder};
#[cfg(not(target_os = "android"))]
use tokio::sync::oneshot;

use crate::transport::TransportState;

/// The single label for the interactive sign-in window (desktop/iOS). Reused (closed +
/// rebuilt) across attempts so a stale window never lingers. Not used on Android, which
/// drives the login through the calling webview instead of a second window.
#[cfg(not(target_os = "android"))]
const OAUTH_WINDOW_LABEL: &str = "hermes-oauth";

/// How long to wait for the interactive login before giving up (desktop/iOS: the app UI
/// stays put behind the sign-in window, so a generous window is fine).
#[cfg(not(target_os = "android"))]
const OAUTH_TIMEOUT_SECS: u64 = 300;

/// Android runs the login in the calling webview, which replaces the entire app UI for the
/// duration (no in-app cancel until this elapses), so keep the wait tighter than desktop.
#[cfg(target_os = "android")]
const OAUTH_TIMEOUT_SECS_ANDROID: u64 = 120;

fn normalize_base(raw: &str) -> String {
    raw.trim().trim_end_matches('/').to_string()
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
/// (desktop: the user closed the sign-in window; Android: the calling webview outlives
/// the navigation, so a transient miss just retries).
///
/// `cookies_for_url` reads the platform cookie store (HttpOnly cookies included, unlike
/// `document.cookie`) and is safe from this async (off-main) context — the same call the
/// desktop flow has always used.
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
            let Ok(cookies) = win.cookies_for_url(base_url.clone()) else {
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
/// Desktop/iOS open a dedicated sign-in `WebviewWindow` that floats over the app.
/// Android CANNOT: wry attaches its webview via `setContentView` (an Activity has one
/// content view) and has no `Drop` to remove it, so a second window would replace the
/// app and never close. Instead, on Android we navigate the CALLING webview to the login,
/// poll the same cookies, then navigate it back — the SPA reload resumes the connect via
/// a one-shot marker the frontend persisted before we navigated away.
///
/// `webview` is the caller, injected by Tauri. It matters on Android: the windowable
/// surfaces (Settings, Command Center, …) run in their own native activity on a webview
/// labelled `screen` (see `window.rs`), so driving a hardcoded `main` would load the login
/// into a BACKGROUNDED activity — invisible to the user, and dead on arrival.
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

    // Load the gateway's own login entry point in the webview (not the IDP
    // directly): it sets the webview's PKCE cookie and 302s straight to the
    // provider, then runs the full cascade back to the dashboard — all inside the
    // webview's cookie jar.
    let login_url = format!("{base}/auth/login?provider={provider}");
    let login_url =
        Url::parse(&login_url).map_err(|e| format!("invalid login URL {login_url:?}: {e}"))?;

    #[cfg(not(target_os = "android"))]
    {
        // The caller hosts the login only on Android; here we build our own window.
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

    #[cfg(target_os = "android")]
    {
        // Capture the app's current URL so we can return to it (dev serves from the Vite
        // dev server, prod from http://tauri.localhost/ — never hardcode; and an activity
        // screen carries `?win=activity#/settings`, which is how the user gets back to the
        // page they started from). navigate/url are safe (and required) off the main
        // thread; wrapping url() on the main thread would deadlock the MainPipe round-trip
        // it makes internally.
        let label = webview.label().to_string();
        let return_url = webview
            .url()
            .map_err(|e| format!("could not read current app URL: {e}"))?;
        log::info!("[oauth] navigating webview {label:?} to sign-in; will return to {return_url}");
        webview
            .navigate(login_url)
            .map_err(|e| format!("could not open sign-in page: {e}"))?;

        let outcome = poll_session_cookies(
            &app,
            state.inner(),
            &base,
            &base_url,
            &label,
            OAUTH_TIMEOUT_SECS_ANDROID,
            false,
        )
        .await;

        // Restore the app regardless of outcome: the SPA reload auto-resumes the connect
        // (on success) or lands on the connect screen (on cancel/timeout).
        let _ = webview.navigate(return_url);

        outcome
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OauthStatus {
    signed_in: bool,
    email: Option<String>,
    display_name: Option<String>,
}

/// Whether the shared jar currently holds a live gateway session, via the
/// auth-required `GET /api/auth/me` probe (401 ⇒ signed out). Used on connect to
/// decide between a silent reconnect and re-opening the sign-in window.
#[tauri::command]
pub async fn oauth_status(
    state: State<'_, TransportState>,
    base: String,
) -> Result<OauthStatus, String> {
    let base = normalize_base(&base);
    let resp = state
        .client()
        .get(format!("{base}/api/auth/me"))
        .header(reqwest::header::ORIGIN, &base)
        .send()
        .await
        .map_err(|e| format!("auth/me request failed: {e}"))?;

    if !resp.status().is_success() {
        return Ok(OauthStatus {
            signed_in: false,
            email: None,
            display_name: None,
        });
    }

    let body: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
    Ok(OauthStatus {
        signed_in: true,
        email: body
            .get("email")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        display_name: body
            .get("display_name")
            .and_then(|v| v.as_str())
            .map(str::to_string),
    })
}

/// Sign out of the gateway session. `POST /auth/logout` revokes the refresh token
/// server-side and responds with max-age=0 Set-Cookie headers, which reqwest's
/// shared cookie jar applies — clearing the local session in the same round trip.
#[tauri::command]
pub async fn oauth_logout(
    state: State<'_, TransportState>,
    base: String,
) -> Result<(), String> {
    let base = normalize_base(&base);
    // redirects OFF: the logout 302 -> /login is irrelevant; we only need the
    // clearing Set-Cookie on the 302 response itself.
    state
        .no_redirect_client()
        .post(format!("{base}/auth/logout"))
        .header(reqwest::header::ORIGIN, &base)
        .send()
        .await
        .map_err(|e| format!("auth/logout request failed: {e}"))?;
    Ok(())
}
