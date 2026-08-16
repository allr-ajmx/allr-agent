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

/// The cookies `webview` holds for `url`'s host, HttpOnly ones included.
///
/// Off macOS/iOS this is `cookies_for_url` verbatim. There, it is `cookies()` (the
/// whole store, unfiltered on that backend) narrowed by [`domain_matches`] — see the
/// module note for why the platform call cannot be used.
///
/// `Secure` is deliberately NOT re-checked against the scheme the way wry's filter
/// does: this read exists to detect and import a session, and the shared reqwest jar
/// already refuses to send a secure cookie over plain http. Dropping one here would
/// only lose a sign-in we had in hand.
pub fn cookies_for_base(webview: &WebviewWindow, url: &Url) -> tauri::Result<Vec<Cookie<'static>>> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        // No host at all (an opaque origin) can own no cookies — and matching every
        // stored cookie into the shared jar is the one outcome worth ruling out.
        let Some(host) = url.host_str().map(str::to_owned) else {
            return Ok(Vec::new());
        };

        Ok(webview
            .cookies()?
            .into_iter()
            .filter(|cookie| {
                cookie
                    .domain()
                    .is_some_and(|domain| domain_matches(domain, &host))
            })
            .collect())
    }

    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        webview.cookies_for_url(url.clone())
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
