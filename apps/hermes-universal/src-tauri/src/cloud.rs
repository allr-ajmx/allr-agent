//! Nous Cloud / Portal (Privy) integration (Track E4).
//!
//! Cloud mode discovers agents from the Nous portal and connects to the chosen
//! agent's gateway. E4.a covers login + status; E4.b bridges the portal cookie into
//! reqwest to call `/api/agents`; E4.c does the silent per-agent SSO.
//!
//! Two shapes, for the same reason as `oauth.rs`:
//!
//!   • Desktop/iOS — the Privy session lives in a dedicated, persistent portal webview
//!     with its own `data_directory`, mirroring desktop's `persist:hermes-remote-oauth`
//!     partition. It is kept (hidden) between calls so discovery and the silent SSO can
//!     reuse it.
//!   • Android — neither half of that works: a second window would replace the app and
//!     never close (wry's `setContentView`, see `oauth.rs`), and `data_directory` is not
//!     honoured — one app-global `CookieManager` holds everything. So the login runs in
//!     the CALLING webview (navigate away, poll, navigate back) and every later call
//!     reads the portal cookies back out of that same global store.
//!
//! This used to carry a `FIXME(E4)` claiming `cookies_for_url()` returns an empty Vec on
//! Android. That was the wry `RustWebView.getCookies` null bug, now patched in `build.rs`
//! — the same read is what makes the Android gateway OAuth poll work today.

#[cfg(not(target_os = "android"))]
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::webview::cookie::Cookie;
use tauri::{AppHandle, State, Url, WebviewWindow};
// The dedicated portal window and its callback intercept are the desktop/iOS shape only.
#[cfg(not(target_os = "android"))]
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
#[cfg(not(target_os = "android"))]
use tokio::sync::oneshot;

use crate::transport::TransportState;

#[cfg(not(target_os = "android"))]
const PORTAL_WINDOW_LABEL: &str = "hermes-portal";
const DEFAULT_PORTAL: &str = "https://portal.nousresearch.com";

/// How long the silent SSO may stay silent before the hidden portal window is
/// revealed anyway.
///
/// The cascade is *supposed* to complete without a UI, so the window is built
/// hidden. But an expired or MFA-gated Privy session turns it into a real login
/// — and a login nobody can see cannot be completed, so the whole 45s budget
/// burns down behind an invisible window and reports a timeout the user has no
/// way to act on. Revealing it converts a dead wait into a sign-in prompt.
///
/// Same idea as desktop's `WINDOW_REVEAL_FALLBACK_MS` (4s), and the same value:
/// long enough that a genuinely silent cascade never flashes a window, short
/// enough to leave most of the timeout for the person now typing into it.
#[cfg(not(target_os = "android"))]
const PORTAL_REVEAL_AFTER_MS: u64 = 4_000;

/// How long the Android login may run before we navigate the app back. Tighter than
/// desktop's 300s for the same reason as `oauth.rs`: the login has replaced the whole app
/// UI, so there is no in-app cancel until this elapses.
#[cfg(target_os = "android")]
const PORTAL_TIMEOUT_SECS_ANDROID: u64 = 120;

/// Portal base URL — env-overridable like desktop (`HERMES_PORTAL_BASE_URL` /
/// `NOUS_PORTAL_BASE_URL`), trailing slash stripped.
pub fn portal_base() -> String {
    std::env::var("HERMES_PORTAL_BASE_URL")
        .or_else(|_| std::env::var("NOUS_PORTAL_BASE_URL"))
        .unwrap_or_else(|_| DEFAULT_PORTAL.to_string())
        .trim_end_matches('/')
        .to_string()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortalStatus {
    signed_in: bool,
    portal_base_url: String,
}

/// Privy portal session cookie names (bare + prefixed variants), from desktop
/// `connection-config.ts`.
fn is_privy_cookie(name: &str) -> bool {
    matches!(
        name,
        "privy-token" | "__Host-privy-token" | "__Secure-privy-token" | "privy-session"
    )
}

pub fn has_privy_cookie(cookies: &[Cookie<'static>]) -> bool {
    cookies.iter().any(|c| is_privy_cookie(c.name()))
}

/// The Privy cookie values currently held, so the Android login can tell a session it
/// just minted from one that was already lying around (see `portal_login`).
#[cfg(target_os = "android")]
fn privy_cookie_values(cookies: &[Cookie<'static>]) -> Vec<String> {
    cookies
        .iter()
        .filter(|c| is_privy_cookie(c.name()))
        .map(|c| c.value().to_string())
        .collect()
}

#[cfg(not(target_os = "android"))]
fn portal_data_dir(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("portal-webview"))
}

/// Build the persistent portal webview (its own data_directory so the Privy
/// session survives restarts and is shared with the discovery/SSO calls).
#[cfg(not(target_os = "android"))]
fn build_portal_window(app: &AppHandle, url: Url, visible: bool) -> tauri::Result<()> {
    let mut builder = WebviewWindowBuilder::new(app, PORTAL_WINDOW_LABEL, WebviewUrl::External(url))
        .title("Nous Portal")
        .inner_size(520.0, 720.0)
        .visible(visible);
    if let Some(dir) = portal_data_dir(app) {
        builder = builder.data_directory(dir);
    }
    builder.build().map(|_| ())
}

/// The portal's cookies, from wherever this platform keeps them (see the module note):
/// the dedicated portal webview off-Android, the calling webview — reading the one
/// app-global cookie store — on Android. Empty when there is no session yet.
fn portal_cookies(app: &AppHandle, webview: &WebviewWindow, portal_url: &Url) -> Vec<Cookie<'static>> {
    #[cfg(target_os = "android")]
    {
        let _ = app;

        webview.cookies_for_url(portal_url.clone()).unwrap_or_default()
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = webview;

        app.get_webview_window(PORTAL_WINDOW_LABEL)
            .and_then(|w| w.cookies_for_url(portal_url.clone()).ok())
            .unwrap_or_default()
    }
}

/// Whether a live Privy session is present. False when no portal webview exists yet.
fn portal_signed_in(app: &AppHandle, webview: &WebviewWindow, portal_url: &Url) -> bool {
    has_privy_cookie(&portal_cookies(app, webview, portal_url))
}

/// Interactive portal sign-in: show the portal login page and wait until the Privy
/// session cookie appears.
///
/// Desktop/iOS open the dedicated portal window and hide it on success (its
/// data_directory keeps the session for discovery + agent SSO). Android navigates the
/// CALLING webview there and back — so, exactly like `oauth_login`, this destroys the JS
/// context and never resolves for the caller; the frontend persists a one-shot marker
/// first and picks the flow back up after the reload.
#[tauri::command]
pub async fn portal_login(app: AppHandle, webview: WebviewWindow) -> Result<PortalStatus, String> {
    let base = portal_base();
    let login_url =
        Url::parse(&format!("{base}/login")).map_err(|e| format!("bad portal URL: {e}"))?;
    let portal_url = Url::parse(&base).map_err(|e| format!("bad portal URL: {e}"))?;

    #[cfg(target_os = "android")]
    {
        // The Android cookie store is app-global AND persistent, so a Privy cookie the
        // server has since revoked can still be sitting there. Accepting on mere presence
        // would return "signed in" before the user typed anything, and every call after
        // it would 401 — a sign-in loop with no way out. So require a value we did not
        // already have: a real login always mints a fresh one.
        let known = privy_cookie_values(&portal_cookies(&app, &webview, &portal_url));

        // Same round-trip as oauth.rs: capture where we are, navigate, poll, come back.
        let return_url = webview
            .url()
            .map_err(|e| format!("could not read current app URL: {e}"))?;
        log::info!(
            "[portal] navigating webview {:?} to sign-in; will return to {return_url}",
            webview.label()
        );
        webview
            .navigate(login_url)
            .map_err(|e| format!("could not open the portal sign-in page: {e}"))?;

        let deadline = tokio::time::Instant::now()
            + Duration::from_secs(PORTAL_TIMEOUT_SECS_ANDROID);
        let mut signed_in = false;
        while tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(750)).await;
            let fresh = privy_cookie_values(&portal_cookies(&app, &webview, &portal_url));
            if fresh.iter().any(|value| !known.contains(value)) {
                signed_in = true;
                break;
            }
        }

        // Restore the app either way — on success the reload resumes into cloud mode, on
        // timeout it lands back on the gateway panel.
        let _ = webview.navigate(return_url);

        if !signed_in {
            return Err("Portal sign-in timed out".to_string());
        }

        return Ok(PortalStatus { signed_in: true, portal_base_url: base });
    }

    #[cfg(not(target_os = "android"))]
    {
        // (Re)create the visible portal window on the main thread.
        let app_build = app.clone();
        app.run_on_main_thread(move || {
            if let Some(existing) = app_build.get_webview_window(PORTAL_WINDOW_LABEL) {
                let _ = existing.close();
            }
            let _ = build_portal_window(&app_build, login_url, true);
        })
        .map_err(|e| format!("failed to open portal window: {e}"))?;

        // Poll the portal cookie jar (like desktop's 750ms poll) until signed in or
        // the window is closed / we time out.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(300);
        loop {
            tokio::time::sleep(Duration::from_millis(750)).await;
            if app.get_webview_window(PORTAL_WINDOW_LABEL).is_none() {
                return Err("Portal sign-in window was closed before completing".to_string());
            }
            if portal_signed_in(&app, &webview, &portal_url) {
                let app_hide = app.clone();
                let _ = app.run_on_main_thread(move || {
                    if let Some(w) = app_hide.get_webview_window(PORTAL_WINDOW_LABEL) {
                        let _ = w.hide();
                    }
                });
                return Ok(PortalStatus { signed_in: true, portal_base_url: base });
            }
            if tokio::time::Instant::now() >= deadline {
                return Err("Portal sign-in timed out".to_string());
            }
        }
    }
}

// ---------------------------------------------------------------------------
// E4.b — agent discovery via the reqwest cookie bridge.
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudAgent {
    id: String,
    name: String,
    status: String,
    dashboard_url: Option<String>,
    dashboard_gateway_state: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudOrg {
    id: String,
    slug: Option<String>,
    name: String,
    is_personal: bool,
    role: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DiscoverResult {
    agents: Vec<CloudAgent>,
    org: Option<CloudOrg>,
    /// Present (with `needs_org_selection`) when the portal wants an org chosen.
    orgs: Vec<CloudOrg>,
    needs_login: bool,
    needs_org_selection: bool,
}

fn parse_agent(v: &Value) -> Option<CloudAgent> {
    Some(CloudAgent {
        id: v.get("id")?.as_str()?.to_string(),
        name: v.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
        status: v.get("status").and_then(Value::as_str).unwrap_or("unknown").to_string(),
        dashboard_url: v.get("dashboardUrl").and_then(Value::as_str).map(str::to_string),
        dashboard_gateway_state: v
            .get("dashboardGatewayState")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string(),
    })
}

fn parse_org(v: &Value) -> Option<CloudOrg> {
    Some(CloudOrg {
        id: v.get("id")?.as_str()?.to_string(),
        slug: v.get("slug").and_then(Value::as_str).map(str::to_string),
        name: v.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
        is_personal: v.get("isPersonal").and_then(Value::as_bool).unwrap_or(false),
        role: v.get("role").and_then(Value::as_str).unwrap_or("MEMBER").to_string(),
    })
}

fn parse_orgs(v: &Value) -> Vec<CloudOrg> {
    v.get("orgs")
        .and_then(Value::as_array)
        .map(|arr| arr.iter().filter_map(parse_org).collect())
        .unwrap_or_default()
}

/// Discover the cloud agents visible to the signed-in portal user. Bridges the
/// portal webview's Privy cookie into a reqwest request (the portal is a
/// different origin from any gateway, so we send an explicit Cookie header rather
/// than pollute the shared gateway jar). 401 → needs re-login; 409 → the user
/// belongs to multiple orgs and must pick one.
#[tauri::command]
pub async fn portal_discover_agents(
    app: AppHandle,
    webview: WebviewWindow,
    org: Option<String>,
) -> Result<DiscoverResult, String> {
    let base = portal_base();
    let portal_url = Url::parse(&base).map_err(|e| format!("bad portal URL: {e}"))?;

    let cookies = portal_cookies(&app, &webview, &portal_url);
    if !has_privy_cookie(&cookies) {
        return Ok(DiscoverResult { needs_login: true, ..Default::default() });
    }
    let cookie_header = cookies
        .iter()
        .map(|c| format!("{}={}", c.name(), c.value()))
        .collect::<Vec<_>>()
        .join("; ");

    let mut url = format!("{base}/api/agents");
    if let Some(o) = org.as_deref().filter(|o| !o.is_empty()) {
        url = format!("{url}?org={o}");
    }

    let resp = reqwest::Client::new()
        .get(&url)
        .header(reqwest::header::COOKIE, cookie_header)
        .header(reqwest::header::ORIGIN, &base)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("agent discovery request failed: {e}"))?;

    let status = resp.status();
    if status.as_u16() == 401 {
        return Ok(DiscoverResult { needs_login: true, ..Default::default() });
    }
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    if status.as_u16() == 409 {
        return Ok(DiscoverResult {
            needs_org_selection: true,
            orgs: parse_orgs(&body),
            ..Default::default()
        });
    }
    if !status.is_success() {
        return Err(format!("agent discovery failed (HTTP {status})"));
    }

    let agents = body
        .get("agents")
        .and_then(Value::as_array)
        .map(|arr| arr.iter().filter_map(parse_agent).collect())
        .unwrap_or_default();
    let org = body.get("org").and_then(parse_org);
    Ok(DiscoverResult { agents, org, ..Default::default() })
}

/// Sign out of the portal: clear the portal webview's stored browsing data (the
/// Privy session cookie in its data_directory). Best-effort — a missing window
/// means there's nothing to clear.
#[tauri::command]
pub async fn portal_logout(app: AppHandle, webview: WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let _ = &app;

        // ponytail: Android has ONE cookie store, so this drops the gateway session too.
        // Both callers are sign-outs (`signOut`, `cloudSignOut`), so that is at worst a
        // re-login; per-origin clearing is the upgrade path if it ever isn't.
        webview
            .clear_all_browsing_data()
            .map_err(|e| format!("failed to clear portal session: {e}"))?;

        return Ok(());
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = webview;

        let app_clear = app.clone();
        app.run_on_main_thread(move || {
            if let Some(w) = app_clear.get_webview_window(PORTAL_WINDOW_LABEL) {
                let _ = w.clear_all_browsing_data();
            }
        })
        .map_err(|e| format!("failed to clear portal session: {e}"))?;

        Ok(())
    }
}

/// Whether a live portal session exists, without prompting. Off-Android this ensures the
/// hidden portal webview exists first (it is what holds the persisted session); on
/// Android there is no such webview — the session is in the app-global cookie store, so
/// the read is immediate.
#[tauri::command]
pub async fn portal_status(app: AppHandle, webview: WebviewWindow) -> Result<PortalStatus, String> {
    let base = portal_base();
    let portal_url = Url::parse(&base).map_err(|e| format!("bad portal URL: {e}"))?;

    #[cfg(not(target_os = "android"))]
    if app.get_webview_window(PORTAL_WINDOW_LABEL).is_none() {
        let app_build = app.clone();
        let url = portal_url.clone();
        app.run_on_main_thread(move || {
            let _ = build_portal_window(&app_build, url, false);
        })
        .map_err(|e| format!("failed to open portal window: {e}"))?;
        // Let the hidden webview load the persisted cookies.
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    Ok(PortalStatus {
        signed_in: portal_signed_in(&app, &webview, &portal_url),
        portal_base_url: base,
    })
}

// ---------------------------------------------------------------------------
// E4.c — silent per-agent SSO.
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSignInResult {
    connected: bool,
    base_url: String,
}

/// Silently sign in to an agent's gateway using the live portal session. Same
/// reqwest-driven exchange as oauth.rs, but the interactive leg runs in the
/// PORTAL webview (which holds the Privy cookie), so the gateway's OAuth
/// `authorize` step auto-approves for org members with no prompt. The PKCE +
/// session cookies land in the shared gateway (transport) jar, so the subsequent
/// ws-ticket mint is authenticated exactly like a manual OAuth login.
///
/// Android has no portal webview to drive, so it runs the authorize cascade in reqwest
/// instead: the Privy cookies are copied out of the app-global store into the shared jar,
/// and the redirect-following client walks `authorize → portal → agent callback` itself.
/// Nothing navigates, so unlike `portal_login` this one really is silent there.
#[tauri::command]
pub async fn portal_agent_sign_in(
    app: AppHandle,
    webview: WebviewWindow,
    state: State<'_, TransportState>,
    dashboard_url: String,
) -> Result<AgentSignInResult, String> {
    let base = dashboard_url.trim().trim_end_matches('/').to_string();

    // 1. Bootstrap the agent gateway's /auth/login (redirects OFF): PKCE cookie
    //    into the shared gateway jar + the portal authorize URL.
    let resp = state
        .no_redirect_client()
        .get(format!("{base}/auth/login?provider=nous"))
        .header(reqwest::header::ORIGIN, &base)
        .send()
        .await
        .map_err(|e| format!("agent auth/login failed: {e}"))?;
    if !resp.status().is_redirection() {
        return Err(format!("expected a redirect from agent /auth/login, got {}", resp.status()));
    }
    let authorize = resp
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| "no Location on agent /auth/login".to_string())?
        .to_string();
    let authorize_url = Url::parse(&authorize).map_err(|e| format!("bad authorize URL: {e}"))?;

    // 2/3. Approve the authorize request with the live portal session, however this
    //      platform can, and land the agent's session cookie in the shared jar.
    let connected = agent_sso(&app, &webview, state.inner(), &base, authorize_url).await?;

    Ok(AgentSignInResult { connected, base_url: base })
}

/// The authorize leg, desktop/iOS: drive it in the hidden portal webview (same
/// data_directory → the Privy session auto-approves) with a callback intercept, then
/// complete the exchange over reqwest.
#[cfg(not(target_os = "android"))]
async fn agent_sso(
    app: &AppHandle,
    webview: &WebviewWindow,
    state: &TransportState,
    base: &str,
    authorize_url: Url,
) -> Result<bool, String> {
    let _ = webview;
    let callback_prefix = format!("{base}/auth/callback");

    // 2. Drive the authorize URL in the portal webview (same data_directory → the
    //    Privy session auto-approves). Rebuild it hidden with a callback intercept.
    let (tx, rx) = oneshot::channel::<Result<String, String>>();
    let tx = Arc::new(Mutex::new(Some(tx)));
    let tx_nav = tx.clone();
    let tx_close = tx.clone();
    let app_build = app.clone();
    let data_dir = portal_data_dir(app);

    app.run_on_main_thread(move || {
        if let Some(existing) = app_build.get_webview_window(PORTAL_WINDOW_LABEL) {
            let _ = existing.close();
        }
        let mut builder =
            WebviewWindowBuilder::new(&app_build, PORTAL_WINDOW_LABEL, WebviewUrl::External(authorize_url))
                .title("Nous Portal")
                .inner_size(520.0, 720.0)
                .visible(false)
                .on_navigation(move |url| {
                    if url.as_str().starts_with(&callback_prefix) {
                        if let Some(tx) = tx_nav.lock().ok().and_then(|mut g| g.take()) {
                            let _ = tx.send(Ok(url.to_string()));
                        }
                        return false;
                    }
                    true
                });
        if let Some(dir) = data_dir {
            builder = builder.data_directory(dir);
        }
        match builder.build() {
            Ok(win) => {
                win.on_window_event(move |event| {
                    if matches!(event, WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed) {
                        if let Some(tx) = tx_close.lock().ok().and_then(|mut g| g.take()) {
                            let _ = tx.send(Err("Portal window closed before SSO completed".to_string()));
                        }
                    }
                });
            }
            Err(e) => {
                if let Some(tx) = tx_close.lock().ok().and_then(|mut g| g.take()) {
                    let _ = tx.send(Err(format!("could not open portal window: {e}")));
                }
            }
        }
    })
    .map_err(|e| format!("failed to schedule portal window: {e}"))?;

    // Reveal-on-stall: a cascade that has not produced a callback by now is not
    // silent, it is waiting for a person. Show the window so they can finish the
    // sign-in inside the remaining budget instead of watching it time out behind
    // nothing. `tx` is still `Some` exactly while the flow is unresolved, so it
    // doubles as the "did it complete?" flag — no extra state to keep in sync.
    let app_reveal = app.clone();
    let tx_reveal = tx.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(PORTAL_REVEAL_AFTER_MS)).await;

        // Guard dropped before the hop to the main thread — never hold a std
        // lock across a scheduling boundary.
        let unresolved = tx_reveal.lock().map(|guard| guard.is_some()).unwrap_or(false);

        if !unresolved {
            return;
        }

        let app_show = app_reveal.clone();
        let _ = app_reveal.run_on_main_thread(move || {
            if let Some(win) = app_show.get_webview_window(PORTAL_WINDOW_LABEL) {
                let _ = win.show();
                let _ = win.set_focus();
            }
        });
    });

    let callback_url = tokio::time::timeout(Duration::from_secs(45), rx)
        .await
        .map_err(|_| "silent SSO timed out — the portal session may have expired".to_string())?
        .map_err(|_| "silent SSO was cancelled".to_string())??;

    // Hide the portal window again (keep it for the persisted session).
    let app_hide = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(w) = app_hide.get_webview_window(PORTAL_WINDOW_LABEL) {
            let _ = w.hide();
        }
    });

    // 3. Complete the exchange via reqwest → agent session cookie in the shared jar.
    let done = state
        .no_redirect_client()
        .get(&callback_url)
        .header(reqwest::header::ORIGIN, base)
        .send()
        .await
        .map_err(|e| format!("agent auth/callback failed: {e}"))?;
    Ok(done.status().is_redirection() || done.status().is_success())
}

/// The authorize leg, Android: there is no portal webview to drive, so bridge the Privy
/// cookies out of the app-global store into the shared jar and let the
/// redirect-FOLLOWING client walk the cascade itself. It ends at `{base}/auth/callback`,
/// which drops the agent session cookie in that same jar — so unlike `portal_login`, this
/// really is silent here: nothing navigates.
#[cfg(target_os = "android")]
async fn agent_sso(
    app: &AppHandle,
    webview: &WebviewWindow,
    state: &TransportState,
    base: &str,
    authorize_url: Url,
) -> Result<bool, String> {
    let portal_url = Url::parse(&portal_base()).map_err(|e| format!("bad portal URL: {e}"))?;
    let cookies = portal_cookies(app, webview, &portal_url);
    if !has_privy_cookie(&cookies) {
        return Err("Not signed in to the Nous portal".to_string());
    }
    {
        let mut store = state
            .cookies()
            .lock()
            .map_err(|_| "cookie jar poisoned".to_string())?;
        for cookie in &cookies {
            let _ = store.insert_raw(cookie, &portal_url);
        }
    }

    let cascade = state
        .client()
        .get(authorize_url)
        .send()
        .await
        .map_err(|e| format!("silent SSO failed: {e}"))?;
    log::info!("[portal] silent SSO cascade -> {}", cascade.status());

    // The cookie is what matters, not the final page — confirm it server-side the same
    // way oauth.rs does after an interactive login.
    let me = state
        .client()
        .get(format!("{base}/api/auth/me"))
        .header(reqwest::header::ORIGIN, base)
        .send()
        .await;

    Ok(matches!(me, Ok(ref resp) if resp.status().is_success()))
}
