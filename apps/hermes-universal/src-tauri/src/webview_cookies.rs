//! Reading a webview's cookie jar for one origin.
//!
//! `WebviewWindow::cookies_for_url` is the obvious call, and on Linux, Windows and
//! Android it is the right one: the platform cookie manager answers it and does the
//! host matching itself. WKWebView exposes no such API, so wry fetches every cookie
//! and filters them in Rust — with
//!
//! ```text
//! cookie.domain() == url.domain()   // wry-0.55.1, src/wkwebview/mod.rs
//! ```
//!
//! which is wrong for a gateway addressed by IP. `Url::domain()` is `None` for an IP
//! literal host (only `Host::Domain` yields `Some`), while the cookie always carries
//! a domain, so the comparison can NEVER hold and the call returns an empty `Vec` for
//! every cookie in the store.
//!
//! That silently broke the interactive sign-in on macOS/iOS against a gateway reached
//! by address — a Tailscale IP, a LAN host, `127.0.0.1`. The login itself completed
//! and WebKit stored the session cookie exactly as it should; `poll_session_cookies`
//! then burned its whole 300s budget polling for cookies it was being handed an empty
//! list for, and reported a timeout. The same filter also drops parent-domain
//! (`Domain=.example.com`) cookies on a subdomain host.
//!
//! So on those two targets we do the fetch-and-filter here instead, matching hosts the
//! way RFC 6265 §5.1.3 says to.
//!
//! # Why this is async
//!
//! iOS goes further and does not use wry's cookie API at all: reading it ABORTS THE
//! PROCESS. `WebView::cookies()` waits for WebKit by pumping a nested `NSRunLoop`, which
//! re-enters tao mid-callback and trips a `panic!` that cannot unwind — every crash
//! report this app has produced on device is that one stack. The [`ios`] module reads
//! `WKHTTPCookieStore` directly and never blocks; see there for the mechanism.
//!
//! That is what makes [`cookies_for_base`] `async`. macOS and the platform-native paths
//! answer immediately and simply live under the same signature, so callers do not have to
//! know which platform they are on.

use tauri::webview::cookie::Cookie;
use tauri::{Url, WebviewWindow};

/// RFC 6265 §5.1.3 domain matching, against the domain a stored cookie carries.
///
/// `Cookie::domain()` has already stripped the leading dot of a `Domain=` attribute,
/// so a host-only cookie and a domain cookie arrive here in the same shape and the
/// suffix arm is what keeps `Domain=.example.com` visible on `gw.example.com`.
///
/// An IP host matches only exactly: a cookie cannot be scoped to a "parent" of an
/// address, and without the guard `1.2.3.4` would match a cookie for `3.4`.
#[cfg_attr(
    not(any(target_os = "macos", target_os = "ios")),
    allow(dead_code, reason = "only the WKWebView path filters cookies itself")
)]
fn domain_matches(cookie_domain: &str, host: &str) -> bool {
    let cookie_domain = cookie_domain.trim_start_matches('.');

    if cookie_domain.is_empty() || host.is_empty() {
        return false;
    }

    if cookie_domain.eq_ignore_ascii_case(host) {
        return true;
    }

    if host.parse::<std::net::IpAddr>().is_ok() {
        return false;
    }

    let Some(prefix_len) = host.len().checked_sub(cookie_domain.len()) else {
        return false;
    };

    prefix_len > 0
        && host.as_bytes()[prefix_len - 1] == b'.'
        && host[prefix_len..].eq_ignore_ascii_case(cookie_domain)
}

/// Narrow a whole-store read to the cookies `url`'s host owns.
///
/// `Secure` is deliberately NOT re-checked against the scheme the way wry's filter
/// does: this read exists to detect and import a session, and the shared reqwest jar
/// already refuses to send a secure cookie over plain http. Dropping one here would
/// only lose a sign-in we had in hand.
#[cfg(any(target_os = "macos", target_os = "ios"))]
fn narrow_to_host(all: Vec<Cookie<'static>>, url: &Url) -> Vec<Cookie<'static>> {
    // No host at all (an opaque origin) can own no cookies — and matching every stored
    // cookie into the shared jar is the one outcome worth ruling out.
    let Some(host) = url.host_str() else {
        return Vec::new();
    };

    all.into_iter()
        .filter(|cookie| {
            cookie
                .domain()
                .is_some_and(|domain| domain_matches(domain, host))
        })
        .collect()
}

/// The cookies `webview` holds for `url`'s host, HttpOnly ones included.
///
/// Async because of iOS — see [`ios`]. macOS and everything else answer immediately;
/// the signature is shared so callers do not have to care which platform they are on.
pub async fn cookies_for_base(
    webview: &WebviewWindow,
    url: &Url,
) -> tauri::Result<Vec<Cookie<'static>>> {
    #[cfg(target_os = "ios")]
    {
        Ok(narrow_to_host(ios::all_cookies(webview).await, url))
    }

    // macOS goes through wry, which blocks the main thread with a nested runloop — the
    // very thing `ios` below exists to avoid. It is left alone deliberately: tao's macOS
    // backend has no `InUserCallback` state machine to re-enter, and this app has never
    // produced a macOS crash for it. Narrower change, nothing to gain by widening it.
    #[cfg(target_os = "macos")]
    {
        Ok(narrow_to_host(webview.cookies()?, url))
    }

    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        webview.cookies_for_url(url.clone())
    }
}

/// What [`delete_matching`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeleteReport {
    /// Cookies whose deletion was handed to the platform store.
    pub deleted: usize,
    /// False when this platform cannot delete a webview cookie at all — which a caller
    /// must not present as "there was nothing to delete".
    pub supported: bool,
}

/// Delete every cookie in `webview`'s store whose `Domain` satisfies `matches`.
///
/// The store is the one the calling webview uses, which in this app is the platform's
/// DEFAULT store on every target (no window sets a `data_directory` except the Nous
/// portal's, and mobile has only the one) — so this also reaches cookies the
/// `hermes-oauth` sign-in window set. That is why it filters instead of clearing:
/// `clear_all_browsing_data` would take the app's own `localStorage` with it.
///
/// `deleted` counts cookies whose deletion was QUEUED. Neither wry (desktop) nor WebKit
/// (iOS) reports a per-cookie result back to this call, so a count is the most a caller
/// can be told.
pub async fn delete_matching<F>(webview: &WebviewWindow, matches: F) -> Result<DeleteReport, String>
where
    F: Fn(&str) -> bool + Send + 'static,
{
    #[cfg(target_os = "ios")]
    {
        ios::delete_matching(webview, matches)
            .await
            .map(|deleted| DeleteReport {
                deleted,
                supported: true,
            })
    }

    // U3b (ALLR-51): wry's Android `delete_cookie` is a no-op and `clearAllBrowsingData`
    // never touches `CookieManager`, so this needs a small Kotlin plugin. Until then the
    // answer is an honest "cannot", not a silent zero.
    #[cfg(target_os = "android")]
    {
        let _ = (webview, matches);

        Ok(DeleteReport {
            deleted: 0,
            supported: false,
        })
    }

    // Linux (WebKitGTK), Windows (WebView2), macOS (WKWebView) through wry. Both calls are
    // dispatched to the main thread by the runtime, and both are fine from an async
    // command: `cookies()` deadlocks on Windows only from a SYNC command, and macOS's
    // blocking read is the one `cookies_for_base` already tolerates.
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        let cookies = webview
            .cookies()
            .map_err(|e| format!("could not read the webview cookie store: {e}"))?;
        let mut deleted = 0;
        let mut failed = 0;

        for cookie in cookies {
            if !cookie.domain().is_some_and(&matches) {
                continue;
            }

            // Fire-and-forget in the runtime: `Ok` means the delete was queued, and a
            // store-side failure is only logged by wry. See `deletion_candidates` for why
            // one stored cookie takes two deletes.
            let queued = deletion_candidates(&cookie)
                .into_iter()
                .map(|candidate| webview.delete_cookie(candidate))
                .collect::<Vec<_>>();

            match queued.into_iter().find_map(Result::err) {
                None => deleted += 1,
                Some(e) => {
                    failed += 1;
                    log::warn!("[cookies] could not queue a cookie deletion: {e}");
                }
            }
        }

        if failed > 0 {
            return Err(format!(
                "{failed} matching cookie(s) could not be deleted ({deleted} were)"
            ));
        }

        Ok(DeleteReport {
            deleted,
            supported: true,
        })
    }
}

/// The cookies to hand wry's `delete_cookie` so that `cookie` — as `cookies()` returned
/// it — is really deleted, whether the store holds it host-only or as a domain cookie.
///
/// The trap: wry reads the native cookie's domain VERBATIM (`.allr.work` for a
/// `Domain=allr.work` cookie), but every conversion back — `cookie_into_soup_cookie`
/// (webkitgtk), `cookie_into_wkwebview` (macOS), `cookie_into_win32` (WebView2), all
/// wry 0.55.1 — builds the native cookie from `Cookie::domain()`, and the `cookie` crate
/// strips ONE leading dot there. So a domain cookie is sent back as host-only
/// `allr.work`, the store matches name + domain + path exactly, finds no such cookie,
/// and the delete is a silent no-op. Pomerium's `_pomerium` session cookie is exactly
/// such a domain cookie.
///
/// `Cookie::domain()` hides whether the dot was there, so both spellings are deleted:
/// the domain as read, and the same domain stored as `..<domain>` — which `domain()`
/// strips back to `.<domain>`, a real domain cookie on all three backends (soup, Foundation
/// and WebView2 all treat a leading dot as "this domain and its subdomains"). Deleting a
/// cookie that does not exist is a no-op everywhere, and both spellings pass the same
/// `cookie_is_allr_work` filter, so the extra delete can only remove what the filter
/// already chose. UNVERIFIED on a live store (runtime check V9).
#[cfg_attr(
    any(target_os = "ios", target_os = "android"),
    allow(
        dead_code,
        reason = "iOS deletes the NSHTTPCookie itself; Android cannot delete"
    )
)]
fn deletion_candidates(cookie: &Cookie<'static>) -> Vec<Cookie<'static>> {
    let Some(domain) = cookie.domain().map(str::to_string) else {
        return vec![cookie.clone()];
    };

    let mut domain_cookie = cookie.clone();
    domain_cookie.set_domain(format!("..{domain}"));

    vec![cookie.clone(), domain_cookie]
}

/// Reading `WKHTTPCookieStore` without parking the main thread.
///
/// wry's `WebView::cookies()` registers the same completion handler we do, then waits for
/// it by pumping a NESTED `NSRunLoop` in `NSDefaultRunLoopMode` in 2 ms slices — up to
/// ~500 of them. That is the mode tao attaches its CFRunLoop control-flow observers to,
/// and the wait happens *inside* one of tao's user callbacks, so a pump re-enters tao
/// while its state machine is already `InUserCallback`. tao panics
/// (`unexpected state InUserCallback`, `app_state.rs`), the panic crosses an
/// `extern "C"` boundary, and `panic in a function that cannot unwind` aborts the
/// process. Deterministic, not a race — and every crash report this app has produced on
/// device, back to the first one, is that single stack.
///
/// There is no safer place to call it FROM. Wrapping `WebviewWindow::cookies()` in
/// `run_on_main_thread` is strictly worse: Tauri runs a message posted from the main
/// thread inline, so the nested runloop happens just the same, and tao is in a user
/// callback either way.
///
/// So we do not call it at all. `getAllCookies` is already asynchronous — a completion
/// block WebKit invokes later on the main thread — and the only reason wry blocks is to
/// present a synchronous API on top of it. Registering the block ourselves and returning
/// immediately means nothing ever pumps a nested runloop; the result arrives over a
/// channel that the async caller awaits. `run_on_main_thread` is the right primitive
/// here precisely because the closure it runs does not wait for anything.
#[cfg(target_os = "ios")]
mod ios {
    use objc2::MainThreadMarker;
    use objc2_foundation::{NSArray, NSHTTPCookie};
    use objc2_web_kit::WKWebsiteDataStore;
    use tauri::webview::cookie::{self, Cookie, CookieBuilder};
    use tauri::{Manager, WebviewWindow};

    /// How long to wait for WebKit to answer before giving up.
    ///
    /// A backstop, not a schedule: the handler normally fires in well under a
    /// millisecond. It exists because a webview torn down between the dispatch and the
    /// callback would otherwise leave the caller waiting forever — and the callers here
    /// are poll loops, which must keep ticking.
    const READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

    /// One `NSHTTPCookie`, as the shared reqwest jar wants it.
    ///
    /// Mirrors wry's own `cookie_from_wkwebview` so an imported session looks identical
    /// to what the old path produced — minus its `SameSite` arm, which is gated on an
    /// OS-version helper wry does not export. Nothing downstream reads it: `SameSite` is
    /// a browser-side send rule, and `cookie_store` neither enforces nor needs it.
    fn from_ns(cookie: &NSHTTPCookie) -> Cookie<'static> {
        let mut builder = CookieBuilder::new(cookie.name().to_string(), cookie.value().to_string())
            .domain(cookie.domain().to_string())
            .path(cookie.path().to_string())
            .http_only(cookie.isHTTPOnly())
            .secure(cookie.isSecure());

        // No expiry at all is a session cookie, which is what the gateway's AT/RT are —
        // so this arm is the common one, not the fallback.
        let expiration = match cookie.expiresDate() {
            Some(date) => cookie::time::OffsetDateTime::from_unix_timestamp(
                date.timeIntervalSince1970() as i64,
            )
            .ok()
            .map(cookie::Expiration::DateTime),
            None => Some(cookie::Expiration::Session),
        };

        if let Some(expiration) = expiration {
            builder = builder.expires(expiration);
        }

        builder.build()
    }

    /// Every cookie in the app's store. Empty on any failure — callers are polls, and
    /// "nothing yet" is a state they already handle, whereas an error would abort a
    /// sign-in over a transient read.
    ///
    /// Reads the DEFAULT data store rather than going through the webview handle. On iOS
    /// that is the same object either way: `data_directory` is `cfg(desktop)` in this app
    /// and wry ignores it on WKWebView regardless, so every webview in the process shares
    /// `WKWebsiteDataStore.default` — the app-global store `cloud.rs` already documents.
    /// It also sidesteps two traps: `objc2-web-kit` 0.3 defines `WKWebView` only for
    /// macOS, and `PlatformWebview::inner()` hands out a pointer built with
    /// `Retained::into_raw`, leaking one retain per call.
    pub(super) async fn all_cookies(webview: &WebviewWindow) -> Vec<Cookie<'static>> {
        // Unbounded because the completion block is `dyn Fn`, not `FnOnce`: it can only
        // send through a `&self` API, which rules out a oneshot. Exactly why wry reaches
        // for `mpsc` here too.
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Vec<Cookie<'static>>>();
        let failed = tx.clone();

        let dispatched = webview.app_handle().run_on_main_thread(move || {
            // On the main thread from here — but only to REGISTER the handler. Nothing
            // below waits, which is the whole point of the module.
            let Some(mtm) = MainThreadMarker::new() else {
                let _ = failed.send(Vec::new());

                return;
            };

            let handler =
                block2::RcBlock::new(move |cookies: std::ptr::NonNull<NSArray<NSHTTPCookie>>| {
                    let cookies = unsafe { cookies.as_ref() };
                    let _ = tx.send(cookies.iter().map(|cookie| from_ns(&cookie)).collect());
                });

            unsafe {
                WKWebsiteDataStore::defaultDataStore(mtm)
                    .httpCookieStore()
                    .getAllCookies(&handler)
            };
        });

        if let Err(e) = dispatched {
            log::warn!("[cookies] could not reach the main thread to read the cookie store: {e}");

            return Vec::new();
        }

        match tokio::time::timeout(READ_TIMEOUT, rx.recv()).await {
            Ok(Some(cookies)) => cookies,
            Ok(None) => Vec::new(),
            Err(_) => {
                log::warn!("[cookies] the webview cookie store did not answer in time");

                Vec::new()
            }
        }
    }

    /// Delete every cookie whose domain satisfies `matches`, without blocking anything.
    ///
    /// Same mechanism as [`all_cookies`], and for the same reason: wry's
    /// `delete_cookie` waits on its completion handler by pumping a nested runloop, which
    /// aborts the process on iOS. Here the main-thread closure only REGISTERS a
    /// `getAllCookies` handler and returns; WebKit later calls that handler on the main
    /// thread, where it queues one `deleteCookie:completionHandler:` per match with no
    /// completion handler at all, and sends back how many it queued.
    ///
    /// Unlike the read, a failure here is an `Err`: a sign-out that could not reach the
    /// store must not report "nothing to clear".
    pub(super) async fn delete_matching<F>(
        webview: &WebviewWindow,
        matches: F,
    ) -> Result<usize, String>
    where
        F: Fn(&str) -> bool + Send + 'static,
    {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Result<usize, String>>();
        let failed = tx.clone();

        let dispatched = webview.app_handle().run_on_main_thread(move || {
            let Some(mtm) = MainThreadMarker::new() else {
                let _ = failed.send(Err("not on the main thread".to_string()));

                return;
            };

            let store = unsafe { WKWebsiteDataStore::defaultDataStore(mtm).httpCookieStore() };
            // The handler needs the store again to delete from it; it runs on the main
            // thread, like this closure, so the main-thread-only handle may ride along.
            let deleting = store.clone();

            let handler =
                block2::RcBlock::new(move |cookies: std::ptr::NonNull<NSArray<NSHTTPCookie>>| {
                    let cookies = unsafe { cookies.as_ref() };
                    let mut deleted = 0;

                    for cookie in cookies.iter() {
                        if matches(&cookie.domain().to_string()) {
                            unsafe { deleting.deleteCookie_completionHandler(&cookie, None) };
                            deleted += 1;
                        }
                    }

                    let _ = tx.send(Ok(deleted));
                });

            unsafe { store.getAllCookies(&handler) };
        });

        if let Err(e) = dispatched {
            return Err(format!(
                "could not reach the main thread to clear the cookie store: {e}"
            ));
        }

        match tokio::time::timeout(READ_TIMEOUT, rx.recv()).await {
            Ok(Some(result)) => result,
            Ok(None) => Err("the webview cookie store went away".to_string()),
            Err(_) => Err("the webview cookie store did not answer in time".to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_domain_cookie_is_deleted_under_both_spellings() {
        // What wry's reads hand back for `Set-Cookie: _pomerium=…; Domain=.allr.work`.
        let read = Cookie::build(("_pomerium", "v"))
            .domain(".allr.work")
            .path("/")
            .build();

        // The trap: the dot is already gone from what wry will convert back.
        assert_eq!(read.domain(), Some("allr.work"));

        let domains: Vec<Option<String>> = deletion_candidates(&read)
            .iter()
            .map(|candidate| candidate.domain().map(str::to_string))
            .collect();

        assert_eq!(
            domains,
            vec![
                Some("allr.work".to_string()),
                Some(".allr.work".to_string())
            ]
        );

        // Everything else about the cookie is what the store matches on, and is kept.
        for candidate in deletion_candidates(&read) {
            assert_eq!(candidate.name(), "_pomerium");
            assert_eq!(candidate.path(), Some("/"));
        }
    }

    #[test]
    fn a_host_only_cookie_gets_a_harmless_domain_twin_and_no_domain_is_left_alone() {
        let host_only = Cookie::build(("sid", "v")).domain("app.allr.work").build();

        assert_eq!(
            deletion_candidates(&host_only)
                .iter()
                .map(|candidate| candidate.domain())
                .collect::<Vec<_>>(),
            vec![Some("app.allr.work"), Some(".app.allr.work")]
        );

        let no_domain = Cookie::new("sid", "v");
        assert_eq!(deletion_candidates(&no_domain).len(), 1);
    }

    #[test]
    fn a_host_only_cookie_matches_its_own_host() {
        assert!(domain_matches("gw.example.com", "gw.example.com"));
        assert!(domain_matches("GW.Example.com", "gw.example.com"));
        assert!(!domain_matches("other.example.com", "gw.example.com"));
    }

    #[test]
    fn an_ip_host_matches_its_own_address() {
        // The regression this module exists for: an IP-addressed gateway (Tailscale,
        // LAN, loopback) is exactly what wry's `url.domain()` comparison can never
        // match, so a completed sign-in read as "no session".
        assert!(domain_matches("100.113.105.121", "100.113.105.121"));
        assert!(domain_matches("127.0.0.1", "127.0.0.1"));
        assert!(!domain_matches("100.113.105.122", "100.113.105.121"));
    }

    #[test]
    fn a_parent_domain_cookie_matches_a_subdomain_host() {
        // `Cookie::domain()` strips the leading dot; both spellings arrive here.
        assert!(domain_matches("example.com", "gw.example.com"));
        assert!(domain_matches(".example.com", "gw.example.com"));
        assert!(domain_matches("example.com", "a.b.example.com"));
    }

    #[test]
    fn a_suffix_that_is_not_a_domain_boundary_never_matches() {
        // The classic sibling-domain bug: "notexample.com" ends with "example.com".
        assert!(!domain_matches("example.com", "notexample.com"));
        assert!(!domain_matches("ample.com", "example.com"));
        // And an address is not a subdomain of its own tail.
        assert!(!domain_matches("3.4", "1.2.3.4"));
        assert!(!domain_matches("0.1", "127.0.0.1"));
    }

    #[test]
    fn a_host_is_never_a_subdomain_of_a_longer_or_empty_domain() {
        assert!(!domain_matches("gw.example.com", "example.com"));
        assert!(!domain_matches("", "example.com"));
        assert!(!domain_matches(".", "example.com"));
        assert!(!domain_matches("example.com", ""));
    }
}
