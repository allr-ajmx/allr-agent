use serde::{Deserialize, Serialize};

/// One host to scrub. Serialized field names are load-bearing: the Kotlin
/// `ExpireTarget` (`@InvokeArg`) is filled by Jackson from exactly these keys.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ExpireTarget {
    /// `https://<host>/`. Handed to `CookieManager.getCookie` / `setCookie` as-is, so
    /// its path must be `/`: that is the only cookie `Path` it reads and expires.
    pub url: String,
    /// `Domain=` values to expire each name under, in addition to host-only. A cookie
    /// store keys a cookie by (name, domain, path), so a host-only cookie and a
    /// `Domain=<parent>` cookie of the same name are two deletions.
    pub domains: Vec<String>,
}

/// What the Kotlin `expireCookies` command resolved.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub struct ExpireReport {
    /// Distinct (host, cookie name) pairs found and expired.
    pub cleared: usize,
    /// Of those, how many `getCookie` still returned after `flush()`. Non-zero means a
    /// cookie outlived its expiry — one scoped above the parent domain, or one the
    /// store refused to overwrite. Diagnostic only; carries no names.
    pub remaining: usize,
}
