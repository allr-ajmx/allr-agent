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
//! and WebKit stored `hermes_session_at`/`_rt` exactly as it should; `poll_session_cookies`
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
}

#[cfg(test)]
mod tests {
    use super::*;

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
