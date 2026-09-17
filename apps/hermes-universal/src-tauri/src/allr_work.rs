//! Allr Work sign-in (ALLR-51) — connect to an Allr Work workspace without typing a URL.
//!
//! # The flow
//!
//! An Allr Work account lives at `https://<user>.<DOMAIN>`, behind Pomerium, and the only
//! thing that knows `<user>` for a signed-in person is the portal on `app.<DOMAIN>`
//! (`allr.os/portal/app.py`). So a sign-in is two hops through ONE sign-in surface (the
//! `hermes-oauth` window on desktop, the calling webview on mobile — see `oauth.rs` for why
//! neither is the system browser):
//!
//!   1. **Discover.** Open `https://app.<DOMAIN>/?redirect_uri=http://127.0.0.1:<p1>/workspace
//!      &state=<s1>`. Pomerium signs the user in (Dex → Google or password) and hands them to
//!      the portal, which answers with a 302 back to our loopback listener carrying
//!      `workspace=https://<user>.<DOMAIN>&state=<s1>` — or `error=no_workspace` /
//!      `error=sign_in_failed` with the same state. Nothing secret crosses this hop: the
//!      portal learns a loopback port, the app learns a host name.
//!   2. **Sign in.** The existing RFC 8252 native flow against that workspace
//!      (`oauth::native`, fresh PKCE and a fresh state), in the same surface, so the Dex
//!      session from hop 1 carries over. The bearer lands in the keyring under
//!      `nativeAuth:<workspace>` exactly as for any other gateway.
//!
//! The workspace host the portal returns is the one value in this flow that decides where
//! a bearer will later be sent, so it is validated here against a parent domain derived
//! from LOCAL configuration (never from the response): one DNS label under the portal's
//! parent, https, no port, no userinfo, no path, not a reserved label. Anything else fails
//! closed with a named error kind.
//!
//! # What lives here
//!
//! Only [`decide`] so far: every decision in the flow as a pure function — portal config,
//! the hand-off URL, the loopback hand-back parser, the workspace host rule, the "portal
//! does not know the hand-off yet" detector, the preflight verdict, the cookie filter for
//! sign-out, and the take-once outcome mailbox. The commands, the loopback listeners and
//! the sign-in surface (the I/O half) are wired in U3.

/// The pure half of the Allr Work sign-in. No sockets, no webviews, no clocks, no
/// environment: every input arrives as an argument, so every branch is reachable from
/// the tests below.
// Wired into the commands in U3 (ALLR-51); until then nothing outside the tests calls in.
#[allow(dead_code)]
pub mod decide {
    use std::time::{Duration, Instant};

    use serde::Serialize;
    use tauri::Url;

    /// The production portal. Overridable (see [`resolve_portal`]) so a dev build can
    /// target `https://app.dev.allr.work`, whose workspaces are `*.dev.allr.work`.
    pub const DEFAULT_PORTAL: &str = "https://app.allr.work";

    /// Host labels under the parent domain that belong to the platform, never to a
    /// person. Same list as `allr.os` (`provisioner/allr_provisioner/users.py`,
    /// `scripts/add-user.sh`), which refuses to provision these as usernames.
    ///
    /// Enforced on the client too because the portal is not the only thing that can put
    /// a URL in front of this code: a local process can answer the loopback, and a
    /// bearer for `auth.<DOMAIN>` (Dex) or `authenticate.<DOMAIN>` (Pomerium) is exactly
    /// the credential that must never be handed to them.
    pub const RESERVED_LABELS: [&str; 5] = ["app", "auth", "authenticate", "admin", "pgadmin"];

    /// Path the hop-1 loopback listener answers on. Distinct from
    /// `oauth::native::CALLBACK_PATH` so a hand-back can never be read as a code callback
    /// or the reverse.
    pub const HANDOFF_PATH: &str = "/workspace";

    /// How long a finished sign-in's outcome waits to be collected. Generous: on mobile it
    /// is read by the NEXT boot of the SPA, after the webview has been navigated back, and
    /// that boot can be slow on a cold device. Short enough that a stale result from an
    /// abandoned attempt never surprises a later launch.
    pub const OUTCOME_TTL: Duration = Duration::from_secs(15 * 60);

    // ── Errors ──────────────────────────────────────────────────────────────

    /// Why an Allr Work sign-in did not complete. Serialised kebab-case exactly like
    /// `SecretsErrorKind`, because the frontend maps each string to its own copy — a
    /// renamed variant is a silently broken error message, which is what
    /// `allr_work_error_kinds_serialize_kebab_case` pins.
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
    #[serde(rename_all = "kebab-case")]
    pub enum AllrWorkErrorKind {
        /// The configured portal URL is not a bare `https://<host>` with a parent domain.
        InvalidPortalConfig,
        /// The user closed the sign-in window or backed out of the page.
        Cancelled,
        /// A hop ran out of its budget.
        TimedOut,
        /// The platform webview would not load the sign-in page at all.
        NavigationRefused,
        /// The calling webview is already sitting on a sign-in page.
        AlreadyOnSignInPage,
        /// The portal could not confirm who the user is (`error=sign_in_failed`), sent an
        /// error we do not know, or sent a hand-back with no usable workspace.
        PortalRefused,
        /// Signed in, but the account has no workspace (`error=no_workspace`).
        NoWorkspace,
        /// The portal sent the user to their dashboard instead of back to the app: it
        /// predates the hand-off.
        PortalOutdated,
        /// The hand-back (or the hop-2 callback) did not carry this request's state.
        StateMismatch,
        /// The portal named a host this app will not send a credential to.
        InvalidWorkspace,
        /// The workspace's agent has no native routes, or its edge does not route them
        /// directly.
        WorkspaceUnsupported,
        /// The portal or the workspace could not be reached.
        Unreachable,
        /// The workspace refused the hop-2 sign-in or the token exchange.
        SignInFailed,
        /// Signed in, but the credential could not be written to the OS keyring.
        CredentialNotSaved,
        /// Signing out could not clear the sign-in page's cookies.
        CookieStoreFailed,
    }

    /// An Allr Work failure as it crosses IPC: a stable kind plus a human message. The
    /// message may quote the workspace host and nothing else — never a state, a code, a
    /// loopback target or a token.
    #[derive(Debug, Clone, PartialEq, Eq, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct AllrWorkError {
        pub kind: AllrWorkErrorKind,
        pub message: String,
    }

    impl AllrWorkError {
        pub fn new(kind: AllrWorkErrorKind, message: impl Into<String>) -> Self {
            Self {
                kind,
                message: message.into(),
            }
        }
    }

    impl std::fmt::Display for AllrWorkError {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "{}", self.message)
        }
    }

    impl std::error::Error for AllrWorkError {}

    // ── Replies ─────────────────────────────────────────────────────────────

    /// `allr_work_sign_in`'s reply. `busy` means another sign-in already owns the surface
    /// and this call deferred to it (a normal outcome, not an error — see
    /// `oauth::claim_sign_in`).
    #[derive(Debug, Clone, PartialEq, Eq, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct AllrWorkSignIn {
        pub busy: bool,
        pub workspace: Option<String>,
    }

    /// `allr_work_config`'s reply: which portal this build signs in through, and the parent
    /// domain a saved workspace URL must sit under.
    #[derive(Debug, Clone, PartialEq, Eq, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct AllrWorkConfig {
        pub portal_url: String,
        pub parent_domain: String,
    }

    impl From<&PortalConfig> for AllrWorkConfig {
        fn from(cfg: &PortalConfig) -> Self {
            Self {
                portal_url: cfg.portal.as_str().trim_end_matches('/').to_string(),
                parent_domain: cfg.parent.clone(),
            }
        }
    }

    /// `allr_work_clear_session`'s reply. `supported: false` means this platform cannot
    /// delete the sign-in page's cookies at all, which the caller must not present as
    /// "nothing to clear".
    #[derive(Debug, Clone, PartialEq, Eq, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct AllrWorkClearReport {
        pub cleared: usize,
        pub supported: bool,
    }

    /// A finished sign-in, parked for a caller that may not exist yet.
    ///
    /// On mobile the sign-in destroys the JS context that invoked it (the webview leaves
    /// the app), so the result cannot be returned — the reloaded SPA collects it instead.
    /// `workspace` on a failure is the host hop 1 discovered, when it got that far, so
    /// the card can say which workspace refused.
    #[derive(Debug, Clone, PartialEq, Eq, Serialize)]
    #[serde(
        tag = "kind",
        rename_all = "kebab-case",
        rename_all_fields = "camelCase"
    )]
    pub enum AllrWorkOutcome {
        SignedIn {
            workspace: String,
        },
        Failed {
            error: AllrWorkError,
            workspace: Option<String>,
        },
    }

    /// The take-once outcome slot, without its lock. The caller owns the `Mutex` and the
    /// clock; this owns the rules: a new outcome replaces an old one, reading clears it,
    /// and an outcome older than [`OUTCOME_TTL`] is gone.
    ///
    /// Take-once is the property that matters: a resume that fired twice would connect
    /// twice, or show a failure the user already dismissed.
    #[derive(Debug, Default)]
    pub struct Mailbox {
        slot: Option<(Instant, AllrWorkOutcome)>,
    }

    impl Mailbox {
        pub fn put(&mut self, outcome: AllrWorkOutcome, now: Instant) {
            self.slot = Some((now, outcome));
        }

        pub fn take(&mut self, now: Instant) -> Option<AllrWorkOutcome> {
            let (at, outcome) = self.slot.take()?;

            // `saturating_`: a `now` from before `at` is a caller mixing clocks, not an
            // expired outcome.
            (now.saturating_duration_since(at) < OUTCOME_TTL).then_some(outcome)
        }
    }

    // ── Portal configuration ────────────────────────────────────────────────

    /// The portal to sign in through, and the parent domain every workspace sits under
    /// (`https://app.allr.work` → `allr.work`).
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct PortalConfig {
        pub portal: Url,
        pub parent: String,
    }

    /// Pick the portal URL: the runtime override (`ALLR_WORK_PORTAL_URL` in the desktop
    /// process environment), then the build-time one (`option_env!`, which is the only
    /// way an Android/iOS build can carry an override), then [`DEFAULT_PORTAL`].
    ///
    /// A blank candidate counts as unset (`ALLR_WORK_PORTAL_URL=` must not mean "invalid").
    /// A non-blank but INVALID candidate is still returned, not skipped: someone who
    /// pointed the app at a dev portal and made a typo must get
    /// `invalid-portal-config`, not a silent sign-in to production.
    pub fn resolve_portal<'a>(runtime: Option<&'a str>, compile_time: Option<&'a str>) -> &'a str {
        [runtime, compile_time]
            .into_iter()
            .flatten()
            .map(str::trim)
            .find(|candidate| !candidate.is_empty())
            .unwrap_or(DEFAULT_PORTAL)
    }

    /// Validate a portal URL and derive its parent domain.
    ///
    /// Same shape rule as a workspace (a bare `https://<host>`), plus at least three
    /// labels: the parent is the host minus its first label, and a parent with fewer than
    /// two labels would make every name under a public suffix a "workspace".
    pub fn portal_config(raw: &str) -> Result<PortalConfig, AllrWorkError> {
        let invalid = |reason: &str| {
            AllrWorkError::new(
                AllrWorkErrorKind::InvalidPortalConfig,
                format!("The Allr Work portal address is not valid: {reason}."),
            )
        };

        let (portal, host) = bare_https_host(raw.trim()).map_err(invalid)?;
        let labels: Vec<&str> = host.split('.').collect();

        if labels.len() < 3 || labels.iter().any(|label| label.is_empty()) {
            return Err(invalid(
                "it must be a host under a parent domain, like app.allr.work",
            ));
        }

        let parent = labels[1..].join(".");

        Ok(PortalConfig { portal, parent })
    }

    /// Parse `raw` as exactly `https://<dns-name>` (an optional single `/` allowed) and
    /// return it with its lowercased host.
    ///
    /// The structured checks exist for the message; the final comparison against the
    /// canonical spelling is the one that closes the rule. WHATWG parsing is forgiving in
    /// ways that matter here — it drops a default `:443`, turns `https://h/?` into an empty
    /// query, strips tabs and newlines, reads `\` as `/`, and IDNA-maps Unicode hosts — and
    /// every one of those would otherwise pass as "no port, no query, plain host".
    fn bare_https_host(raw: &str) -> Result<(Url, String), &'static str> {
        let url = Url::parse(raw).map_err(|_| "it is not a URL")?;

        if url.scheme() != "https" {
            return Err("it must use https");
        }

        if !url.username().is_empty() || url.password().is_some() {
            return Err("it must not carry a user name or password");
        }

        if url.port().is_some() {
            return Err("it must not name a port");
        }

        if url.path() != "/" {
            return Err("it must not have a path");
        }

        if url.query().is_some() || url.fragment().is_some() {
            return Err("it must not have a query or fragment");
        }

        // `domain()` is `Some` only for a DNS name: `None` for an IPv4/IPv6 literal.
        let Some(host) = url.domain().map(str::to_string) else {
            return Err("its host must be a DNS name, not an IP address");
        };

        if host.ends_with('.') {
            return Err("its host must not end with a dot");
        }

        let lower = raw.to_ascii_lowercase();
        let canonical = format!("https://{host}");

        if lower != canonical && lower != format!("{canonical}/") {
            return Err("it must be written as a bare https:// address with no port");
        }

        Ok((url, host))
    }

    // ── Hop 1: the hand-off ─────────────────────────────────────────────────

    /// The hop-1 loopback `redirect_uri` for a bound port. Loopback IP literal for the
    /// same reason as `oauth::native::loopback_redirect_uri`; the portal enforces it too.
    pub fn handoff_redirect_uri(port: u16) -> String {
        format!("http://127.0.0.1:{port}{HANDOFF_PATH}")
    }

    /// The portal URL that starts hop 1. Encoded with the URL parser rather than
    /// concatenated: the redirect URI is itself a URL, and its `:` and `/` must reach the
    /// portal's `parse_qs` as one value.
    pub fn handoff_url(cfg: &PortalConfig, redirect_uri: &str, state: &str) -> String {
        let mut url = cfg.portal.clone();

        url.query_pairs_mut()
            .append_pair("redirect_uri", redirect_uri)
            .append_pair("state", state);

        url.into()
    }

    /// Does `got` equal `expected`, in time that does not depend on where they differ?
    ///
    /// `oauth::native::parse_callback_target` uses a plain `!=` and says why that is
    /// acceptable for a single-use state; this is the same check made constant-time
    /// anyway, because it costs one loop. The length is not secret (the app always sends
    /// 32 characters), so an early return on a length mismatch leaks nothing.
    fn state_matches(expected: &str, got: &str) -> bool {
        // An empty expected state must never match — not even an empty `state=`.
        if expected.is_empty() || expected.len() != got.len() {
            return false;
        }

        expected
            .bytes()
            .zip(got.bytes())
            .fold(0u8, |diff, (a, b)| diff | (a ^ b))
            == 0
    }

    /// Read the request target our hop-1 listener received
    /// (`/workspace?workspace=<url>&state=<s>` or `/workspace?error=<e>&state=<s>`).
    ///
    /// `None` means "not a hand-back" — any other path (`/favicon.ico`, a speculative
    /// probe) — and the listener keeps waiting. `Some` is a verdict.
    ///
    /// Order is the security argument:
    ///   1. **State first.** A request without exactly one `state` equal to ours is
    ///      `state-mismatch`, whatever else it says. Anything that can reach the loopback
    ///      port could otherwise make the app report a portal error it never sent, or
    ///      offer a workspace of its choosing.
    ///   2. **Portal errors.** `error=no_workspace` → `no-workspace`; any other error
    ///      value, a repeated `error`, or an `error` alongside a `workspace` →
    ///      `portal-refused`.
    ///   3. **Exactly one `workspace`**, else `portal-refused`.
    ///   4. [`validate_workspace`].
    ///
    /// Duplicates fail closed rather than taking the first or last value: the portal
    /// builds this query with `urlencode` over a dict and can never repeat a key, so a
    /// repeat is not the portal, and "which one did you mean" has no safe answer. A
    /// repeated `state` is a state problem (we cannot say the request is ours); a repeated
    /// `error`/`workspace` under a good state is a malformed hand-back (`portal-refused`).
    pub fn parse_handoff_target(
        target: &str,
        expected_state: &str,
        cfg: &PortalConfig,
    ) -> Option<Result<Url, AllrWorkError>> {
        let (path, query) = target.split_once('?').unwrap_or((target, ""));

        if path != HANDOFF_PATH {
            return None;
        }

        // Form-decoding through the URL parser (percent escapes and `+`), rather than a
        // second hand-rolled decoder beside `oauth::native`'s.
        let mut carrier = Url::parse("http://127.0.0.1/").expect("static URL parses");
        carrier.set_query(Some(query));

        let mut states = Vec::new();
        let mut workspaces = Vec::new();
        let mut errors = Vec::new();

        for (key, value) in carrier.query_pairs() {
            match key.as_ref() {
                "state" => states.push(value.into_owned()),
                "workspace" => workspaces.push(value.into_owned()),
                "error" => errors.push(value.into_owned()),
                _ => {}
            }
        }

        let ours = matches!(states.as_slice(), [state] if state_matches(expected_state, state));

        if !ours {
            return Some(Err(AllrWorkError::new(
                AllrWorkErrorKind::StateMismatch,
                "The sign-in response did not match this request.",
            )));
        }

        if !errors.is_empty() {
            let no_workspace = workspaces.is_empty()
                && matches!(errors.as_slice(), [error] if error == "no_workspace");

            return Some(Err(if no_workspace {
                AllrWorkError::new(
                    AllrWorkErrorKind::NoWorkspace,
                    "This account does not have an Allr Work workspace.",
                )
            } else {
                AllrWorkError::new(
                    AllrWorkErrorKind::PortalRefused,
                    "Allr Work could not confirm who you are.",
                )
            }));
        }

        let [workspace] = workspaces.as_slice() else {
            return Some(Err(AllrWorkError::new(
                AllrWorkErrorKind::PortalRefused,
                "Allr Work did not name exactly one workspace.",
            )));
        };

        Some(validate_workspace(workspace, cfg))
    }

    /// The label `host` has as a workspace under `parent`, if it is one: exactly one
    /// DNS label, then a dot, then `parent` — the dot is what keeps `xmallr.work` and
    /// `evil-allr.work` out — matching the portal's `USERNAME_RE`
    /// (`^[a-z0-9][a-z0-9-]{0,30}$`, whole-string) and not reserved.
    fn workspace_label<'h>(host: &'h str, parent: &str) -> Option<&'h str> {
        if parent.is_empty() {
            return None;
        }

        let label = host.strip_suffix(parent)?.strip_suffix('.')?;

        (is_username(label) && !RESERVED_LABELS.contains(&label)).then_some(label)
    }

    /// `^[a-z0-9][a-z0-9-]{0,30}$` without pulling `regex` (optional in this crate) into
    /// the default build.
    fn is_username(label: &str) -> bool {
        let bytes = label.as_bytes();

        matches!(bytes.first(), Some(b'a'..=b'z' | b'0'..=b'9'))
            && bytes.len() <= 31
            && bytes[1..]
                .iter()
                .all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'-'))
    }

    /// Is `raw` a workspace this app will sign in to and later send a bearer to?
    ///
    /// Exactly `https://<label>.<parent>` (trailing `/` and uppercase tolerated and
    /// normalised): https, no userinfo, no port — not even `:443` — no path, query or
    /// fragment, a DNS name rather than an IP, no trailing dot, one label matching the
    /// username rule, not reserved. `parent` comes from [`portal_config`], never from the
    /// response being validated.
    ///
    /// The message never quotes `raw`: a rejected value is by definition not something
    /// we trust enough to put on screen.
    pub fn validate_workspace(raw: &str, cfg: &PortalConfig) -> Result<Url, AllrWorkError> {
        let invalid = |reason: &str| {
            AllrWorkError::new(
                AllrWorkErrorKind::InvalidWorkspace,
                format!("Allr Work returned a workspace address this app will not use: {reason}."),
            )
        };

        let (url, host) = bare_https_host(raw).map_err(invalid)?;

        if workspace_label(&host, &cfg.parent).is_none() {
            let label = host
                .strip_suffix(cfg.parent.as_str())
                .and_then(|rest| rest.strip_suffix('.'));

            return Err(invalid(match label {
                Some(label) if RESERVED_LABELS.contains(&label) => "that name is reserved",
                _ => "it is not a single workspace name under the Allr Work domain",
            }));
        }

        Ok(url)
    }

    /// The workspace's base URL as every other part of the app spells it: no trailing
    /// slash. This is the keyring scope (`nativeAuth:<base>`, `secrets::OwnedKey`), the
    /// `BearerBases` key and the `url` JS saves, so it must agree with
    /// `oauth::normalize_base` byte for byte — a mismatch is a token stored under one name
    /// and looked up under another.
    pub fn workspace_base(workspace: &Url) -> String {
        workspace.as_str().trim_end_matches('/').to_string()
    }

    /// What the sign-in surface's current URL says about hop 1.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum SurfaceVerdict {
        /// Still on the way (Pomerium, Dex, Google, the portal, our loopback page).
        Continue,
        /// The surface reached a workspace host during hop 1, which only happens when the
        /// portal ignored the hand-off and sent the user to their dashboard: it predates
        /// the hand-off (`portal-outdated`). Detected so the user is not left looking at a
        /// dashboard until the 300 s budget runs out.
        PortalWithoutHandoff,
    }

    /// See [`SurfaceVerdict`]. A host counts as a workspace by the same rule
    /// [`validate_workspace`] applies, so the platform's own reserved hosts — Dex on
    /// `auth.`, Pomerium on `authenticate.`, the portal on `app.` — are never mistaken for
    /// a dashboard mid-sign-in.
    pub fn hop1_surface_verdict(current: &Url, cfg: &PortalConfig) -> SurfaceVerdict {
        let on_workspace = current.scheme() == "https"
            && current.port().is_none()
            && current
                .domain()
                .is_some_and(|host| workspace_label(host, &cfg.parent).is_some());

        if on_workspace {
            SurfaceVerdict::PortalWithoutHandoff
        } else {
            SurfaceVerdict::Continue
        }
    }

    // ── Between the hops ────────────────────────────────────────────────────

    /// What a bare `GET <workspace>/auth/native/authorize` (redirects OFF) says about the
    /// workspace before the user is sent through hop 2.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum Preflight {
        /// The agent's native routes answered directly.
        Native,
        /// The agent does not have (or does not expose) the native routes.
        Unsupported,
        /// The edge sent the request to sign-in instead of to the agent: `/auth/native/*`
        /// is not routed directly (Caddy `@direct`).
        EdgeNotDirect,
        /// No usable answer at all.
        Unreachable,
    }

    /// Classify the preflight. The authorize route validates its parameters before any
    /// side effect (`routes.py`: the S256 check precedes `register_pending`), so a bare
    /// GET is a safe capability probe whose healthy answer is a JSON client error.
    ///
    /// | status              | JSON body | verdict         |
    /// |---------------------|-----------|-----------------|
    /// | none (no response)  | –         | `Unreachable`   |
    /// | 400, 422            | yes       | `Native`        |
    /// | 404                 | –         | `Unsupported`   |
    /// | 300–399             | –         | `EdgeNotDirect` |
    /// | 500–599             | –         | `Unreachable`   |
    /// | anything else       | –         | `Unsupported`   |
    ///
    /// "Anything else" includes a 2xx (an authorize route that accepts no parameters is
    /// not ours), a 400/422 WITHOUT JSON (a proxy's error page) and 401/403 (something in
    /// front of the agent is gating the route). Treating every non-2xx as native would
    /// send the user into a hop 2 that cannot finish.
    pub fn classify_preflight(status: Option<u16>, json_body: bool) -> Preflight {
        match status {
            None => Preflight::Unreachable,
            Some(400 | 422) if json_body => Preflight::Native,
            Some(404) => Preflight::Unsupported,
            Some(300..=399) => Preflight::EdgeNotDirect,
            Some(500..=599) => Preflight::Unreachable,
            Some(_) => Preflight::Unsupported,
        }
    }

    // ── Sign-out ────────────────────────────────────────────────────────────

    /// Is a cookie with this `Domain` one of Allr Work's (the parent domain or any host
    /// under it)? Case-insensitive, and a leading `.` (RFC 2109 style) is tolerated.
    ///
    /// Boundary-safe on purpose: sign-out deletes whatever this matches from a cookie
    /// store the app shares with every other page it has ever opened, so a naive
    /// `ends_with("allr.work")` would also delete `evilallr.work`'s cookies — harmless to
    /// us, but not ours to touch.
    pub fn cookie_is_allr_work(cookie_domain: &str, parent: &str) -> bool {
        let domain = cookie_domain.to_ascii_lowercase();
        let domain = domain.strip_prefix('.').unwrap_or(&domain);
        let parent = parent.to_ascii_lowercase();

        !parent.is_empty() && (domain == parent || domain.ends_with(&format!(".{parent}")))
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn prod() -> PortalConfig {
            portal_config(DEFAULT_PORTAL).expect("the default portal is valid")
        }

        fn dev() -> PortalConfig {
            portal_config("https://app.dev.allr.work").expect("the dev portal is valid")
        }

        fn url(s: &str) -> Url {
            Url::parse(s).unwrap()
        }

        fn kind_of<T: std::fmt::Debug>(result: Result<T, AllrWorkError>) -> AllrWorkErrorKind {
            result.expect_err("expected a failure").kind
        }

        // ── Portal configuration ─────────────────────────────────────────────

        #[test]
        fn portal_config_derives_the_parent_domain() {
            let cfg = prod();

            assert_eq!(cfg.parent, "allr.work");
            assert_eq!(cfg.portal.as_str(), "https://app.allr.work/");
        }

        #[test]
        fn portal_config_derives_dev_parent() {
            // Parent = host minus its FIRST label, not "the last two labels": a dev portal
            // must scope workspaces to *.dev.allr.work, never to all of *.allr.work.
            assert_eq!(dev().parent, "dev.allr.work");
            // Trailing slash, uppercase and surrounding whitespace are spelling, not shape.
            assert_eq!(
                portal_config(" HTTPS://App.Dev.Allr.Work/ ")
                    .unwrap()
                    .parent,
                "dev.allr.work"
            );

            for bad in [
                "https://allr.work",
                "http://app.dev.allr.work",
                "https://app.allr.work:443",
                "https://app.allr.work:8443",
                "https://user@app.allr.work",
                "https://app.allr.work/portal",
                "https://app.allr.work/?x=1",
                "https://app.allr.work/?",
                "https://app.allr.work/#top",
                "https://app.allr.work.",
                "https://10.0.0.1",
                "https://[::1]",
                "app.allr.work",
                "",
            ] {
                assert_eq!(
                    kind_of(portal_config(bad)),
                    AllrWorkErrorKind::InvalidPortalConfig,
                    "{bad:?}"
                );
            }
        }

        #[test]
        fn portal_resolution_prefers_runtime_then_build_time_then_default() {
            let runtime = Some("https://app.dev.allr.work");
            let build = Some("https://app.staging.allr.work");

            assert_eq!(resolve_portal(runtime, build), "https://app.dev.allr.work");
            assert_eq!(resolve_portal(None, build), "https://app.staging.allr.work");
            assert_eq!(resolve_portal(None, None), DEFAULT_PORTAL);
            // A blank variable is unset, not invalid.
            assert_eq!(
                resolve_portal(Some("  "), build),
                "https://app.staging.allr.work"
            );
            assert_eq!(resolve_portal(Some(""), Some("")), DEFAULT_PORTAL);
            // An invalid override is NOT skipped in favour of production: it reaches
            // `portal_config` and fails there, loudly.
            assert_eq!(resolve_portal(Some("http://typo"), build), "http://typo");
            assert!(portal_config(resolve_portal(Some("http://typo"), None)).is_err());
        }

        #[test]
        fn the_config_reply_has_no_trailing_slash() {
            let reply = AllrWorkConfig::from(&dev());

            assert_eq!(reply.portal_url, "https://app.dev.allr.work");
            assert_eq!(reply.parent_domain, "dev.allr.work");
        }

        // ── Workspace host rule ──────────────────────────────────────────────

        #[test]
        fn validate_workspace_accepts_single_label_under_parent() {
            let cfg = prod();

            for (raw, base) in [
                ("https://xm.allr.work", "https://xm.allr.work"),
                ("https://xm.allr.work/", "https://xm.allr.work"),
                ("https://XM.Allr.Work", "https://xm.allr.work"),
                ("HTTPS://xm.allr.work/", "https://xm.allr.work"),
                ("https://a.allr.work", "https://a.allr.work"),
                ("https://0-a.allr.work", "https://0-a.allr.work"),
                // 31 characters: the longest name the username rule allows.
                (
                    "https://abcdefghijklmnopqrstuvwxyz01234.allr.work",
                    "https://abcdefghijklmnopqrstuvwxyz01234.allr.work",
                ),
            ] {
                let workspace =
                    validate_workspace(raw, &cfg).unwrap_or_else(|e| panic!("{raw}: {e}"));

                assert_eq!(workspace_base(&workspace), base, "{raw}");
            }
            // Under a dev portal the same person lives one level down.
            assert!(validate_workspace("https://xm.dev.allr.work", &dev()).is_ok());
        }

        #[test]
        fn validate_workspace_rejects_everything_else() {
            let cfg = prod();

            for raw in [
                "http://xm.allr.work",
                "https://xm.allr.work:443",
                "https://xm.allr.work:8443",
                "https://user@xm.allr.work",
                "https://user:pw@xm.allr.work",
                "https://xm.allr.work/x",
                "https://xm.allr.work?q",
                "https://xm.allr.work/?",
                "https://xm.allr.work#f",
                "https://a.b.allr.work",
                "https://allr.work",
                "https://.allr.work",
                "https://xm.allr.work.evil.test",
                "https://xmallr.work",
                "https://xm-allr.work",
                "https://xm.allr.work.",
                "https://100.113.166.18",
                "https://[::1]",
                "https://-xm.allr.work",
                "https://x_m.allr.work",
                // 32 characters: one past the username rule.
                "https://abcdefghijklmnopqrstuvwxyz012345.allr.work",
                // A dev workspace is not a prod workspace.
                "https://xm.dev.allr.work",
                // WHATWG would quietly clean these up into a valid host.
                " https://xm.allr.work",
                "https://xm.allr.work\t",
                "https:\\\\xm.allr.work",
                "https://xm%2Eallr.work",
                "xm.allr.work",
                "",
            ] {
                assert_eq!(
                    kind_of(validate_workspace(raw, &cfg)),
                    AllrWorkErrorKind::InvalidWorkspace,
                    "{raw:?}"
                );
            }
        }

        #[test]
        fn validate_workspace_rejects_each_reserved_label() {
            // These are Dex, Pomerium, the portal and the admin tools. A bearer sent to
            // any of them is a credential handed to the wrong party.
            for label in RESERVED_LABELS {
                let err = validate_workspace(&format!("https://{label}.allr.work"), &prod())
                    .expect_err(label);

                assert_eq!(err.kind, AllrWorkErrorKind::InvalidWorkspace, "{label}");
                assert!(err.message.contains("reserved"), "{label}: {}", err.message);
            }
        }

        #[test]
        fn a_rejected_workspace_is_never_quoted_back() {
            let err = validate_workspace("https://evil.example.test/steal", &prod()).unwrap_err();

            assert!(!err.message.contains("evil"), "{}", err.message);
        }

        #[test]
        fn workspace_base_agrees_with_the_keyring_scope_and_normalize_base() {
            // One token set, three names for its key: the keyring account
            // (`nativeAuth:<scope>` with trailing slashes trimmed), the base `oauth_status`
            // and `http_request` normalise to, and what this module hands back. If they
            // drift, sign-in stores a token nothing ever finds.
            let workspace = validate_workspace("https://XM.allr.work/", &prod()).unwrap();
            let base = workspace_base(&workspace);

            assert_eq!(base, "https://xm.allr.work");
            assert_eq!(crate::oauth::normalize_base(workspace.as_str()), base);
            assert_eq!(crate::oauth::normalize_base(&base), base);
        }

        // ── Hand-off URL and hand-back parse ─────────────────────────────────

        const STATE: &str = "Zm9vYmFyYmF6cXV4LWFiY2RlZmdoaWpr";

        fn target(query: &str) -> String {
            format!("{HANDOFF_PATH}?{query}")
        }

        #[test]
        fn handoff_url_encodes_redirect_uri_and_state() {
            let redirect = handoff_redirect_uri(51234);
            let built = handoff_url(&prod(), &redirect, "st+a/te=");

            assert_eq!(redirect, "http://127.0.0.1:51234/workspace");
            assert_eq!(
                built,
                "https://app.allr.work/?redirect_uri=http%3A%2F%2F127.0.0.1%3A51234%2Fworkspace&state=st%2Ba%2Fte%3D"
            );
            // And it round-trips to exactly the two values the portal's parse_qs expects.
            let pairs: Vec<(String, String)> = url(&built).query_pairs().into_owned().collect();
            assert_eq!(
                pairs,
                vec![
                    ("redirect_uri".to_string(), redirect),
                    ("state".to_string(), "st+a/te=".to_string()),
                ]
            );
        }

        #[test]
        fn handoff_workspace_is_percent_decoded_then_validated() {
            // Byte-for-byte what the portal's `urlencode({workspace, state})` produces.
            let hit = target(&format!(
                "workspace=https%3A%2F%2Fxm.allr.work&state={STATE}"
            ));
            let workspace = parse_handoff_target(&hit, STATE, &prod())
                .expect("a hand-back")
                .expect("a valid workspace");

            assert_eq!(workspace_base(&workspace), "https://xm.allr.work");

            // Decoded, then held to the host rule — not trusted because the state matched.
            let evil = target(&format!(
                "workspace=https%3A%2F%2Fauth.allr.work&state={STATE}"
            ));
            assert_eq!(
                kind_of(parse_handoff_target(&evil, STATE, &prod()).unwrap()),
                AllrWorkErrorKind::InvalidWorkspace
            );
            let elsewhere = target(&format!(
                "workspace=https%3A%2F%2Fxm.allr.work.evil.test&state={STATE}"
            ));
            assert_eq!(
                kind_of(parse_handoff_target(&elsewhere, STATE, &prod()).unwrap()),
                AllrWorkErrorKind::InvalidWorkspace
            );
        }

        #[test]
        fn handoff_state_mismatch_is_rejected() {
            let cfg = prod();

            for query in [
                "workspace=https%3A%2F%2Fxm.allr.work&state=someone-elses-state-value".to_string(),
                "workspace=https%3A%2F%2Fxm.allr.work".to_string(),
                format!("workspace=https%3A%2F%2Fxm.allr.work&state={STATE}x"),
                // A repeated state cannot be ours, whichever copy is right.
                format!("workspace=https%3A%2F%2Fxm.allr.work&state={STATE}&state={STATE}"),
                format!("workspace=https%3A%2F%2Fxm.allr.work&state=nope&state={STATE}"),
            ] {
                assert_eq!(
                    kind_of(parse_handoff_target(&target(&query), STATE, &cfg).unwrap()),
                    AllrWorkErrorKind::StateMismatch,
                    "{query}"
                );
            }
        }

        #[test]
        fn handoff_state_is_checked_before_anything_it_carries() {
            // Without the state, neither a portal error nor a bad workspace may speak: a
            // local process must not be able to make the app report "no workspace", nor
            // learn from a different error which check it tripped.
            let cfg = prod();

            for query in [
                "error=no_workspace&state=forged-state-value-000000",
                "error=sign_in_failed",
                "workspace=https%3A%2F%2Fauth.allr.work&state=forged-state-value-000000",
                "workspace=http%3A%2F%2Fevil.test",
                "",
            ] {
                assert_eq!(
                    kind_of(parse_handoff_target(&target(query), STATE, &cfg).unwrap()),
                    AllrWorkErrorKind::StateMismatch,
                    "{query}"
                );
            }
        }

        #[test]
        fn empty_expected_state_never_matches() {
            let cfg = prod();

            for query in [
                "workspace=https%3A%2F%2Fxm.allr.work&state=",
                "workspace=https%3A%2F%2Fxm.allr.work",
                "error=no_workspace&state=",
            ] {
                assert_eq!(
                    kind_of(parse_handoff_target(&target(query), "", &cfg).unwrap()),
                    AllrWorkErrorKind::StateMismatch,
                    "{query}"
                );
            }
        }

        #[test]
        fn handoff_error_no_workspace_maps_kind() {
            let hit = target(&format!("error=no_workspace&state={STATE}"));

            assert_eq!(
                kind_of(parse_handoff_target(&hit, STATE, &prod()).unwrap()),
                AllrWorkErrorKind::NoWorkspace
            );
        }

        #[test]
        fn handoff_other_errors_and_malformed_hand_backs_are_portal_refused() {
            let cfg = prod();

            for query in [
                format!("error=sign_in_failed&state={STATE}"),
                format!("error=something_new&state={STATE}"),
                format!("error=&state={STATE}"),
                // Repeated or contradictory: never what the portal sends.
                format!("error=no_workspace&error=no_workspace&state={STATE}"),
                format!("error=no_workspace&workspace=https%3A%2F%2Fxm.allr.work&state={STATE}"),
                format!(
                    "workspace=https%3A%2F%2Fxm.allr.work&workspace=https%3A%2F%2Fxm.allr.work&state={STATE}"
                ),
                // Nothing at all under a good state.
                format!("state={STATE}"),
            ] {
                assert_eq!(
                    kind_of(parse_handoff_target(&target(&query), STATE, &cfg).unwrap()),
                    AllrWorkErrorKind::PortalRefused,
                    "{query}"
                );
            }
        }

        #[test]
        fn handoff_non_handoff_path_is_a_probe() {
            let cfg = prod();
            let good = format!("workspace=https%3A%2F%2Fxm.allr.work&state={STATE}");

            for probe in [
                "/favicon.ico".to_string(),
                "/".to_string(),
                format!("/callback?{good}"),
                format!("/workspace/?{good}"),
                format!("/workspaces?{good}"),
                format!("/x/workspace?{good}"),
            ] {
                assert!(
                    parse_handoff_target(&probe, STATE, &cfg).is_none(),
                    "{probe}"
                );
            }

            // The bare path with no query IS the listener's path: a verdict, not a probe.
            assert!(parse_handoff_target(HANDOFF_PATH, STATE, &cfg).is_some());
        }

        #[test]
        fn state_comparison_is_exact() {
            assert!(state_matches("abc", "abc"));
            assert!(!state_matches("abc", "abd"));
            assert!(!state_matches("abc", "ab"));
            assert!(!state_matches("abc", "abcd"));
            assert!(!state_matches("", ""));
        }

        // ── Outdated portal detection ────────────────────────────────────────

        #[test]
        fn surface_on_workspace_host_is_portal_without_handoff() {
            for current in [
                "https://xm.allr.work/",
                "https://xm.allr.work/auth/login?next=/",
                "https://XM.allr.work/#/chat",
            ] {
                assert_eq!(
                    hop1_surface_verdict(&url(current), &prod()),
                    SurfaceVerdict::PortalWithoutHandoff,
                    "{current}"
                );
            }

            assert_eq!(
                hop1_surface_verdict(&url("https://xm.dev.allr.work/"), &dev()),
                SurfaceVerdict::PortalWithoutHandoff
            );
        }

        #[test]
        fn surface_on_auth_authenticate_app_google_loopback_continues() {
            // Every page hop 1 legitimately passes through. A false positive here fails a
            // sign-in that was working — on Dex's login page, of all places.
            for current in [
                "https://app.allr.work/?redirect_uri=http%3A%2F%2F127.0.0.1%3A1%2Fworkspace&state=s",
                "https://authenticate.allr.work/.pomerium/sign_in?x=1",
                "https://auth.allr.work/auth?client_id=pomerium",
                "https://auth.allr.work/auth/google",
                "https://admin.allr.work/",
                "https://pgadmin.allr.work/",
                "https://accounts.google.com/o/oauth2/v2/auth",
                "http://127.0.0.1:51234/workspace?workspace=x&state=s",
                "about:blank",
                // Not a workspace by the host rule, so not evidence of one.
                "http://xm.allr.work/",
                "https://xm.allr.work:8443/",
                "https://a.b.allr.work/",
                "https://allr.work/",
            ] {
                assert_eq!(
                    hop1_surface_verdict(&url(current), &prod()),
                    SurfaceVerdict::Continue,
                    "{current}"
                );
            }

            // Under a dev portal, a prod workspace host is not a dev workspace.
            assert_eq!(
                hop1_surface_verdict(&url("https://xm.allr.work/"), &dev()),
                SurfaceVerdict::Continue
            );
        }

        // ── Preflight ────────────────────────────────────────────────────────

        #[test]
        fn preflight_400_json_is_native() {
            // What the live agent answers: `400 {"detail":"code_challenge_method must be S256"}`.
            assert_eq!(classify_preflight(Some(400), true), Preflight::Native);
            assert_eq!(classify_preflight(Some(422), true), Preflight::Native);
            // A proxy's HTML 400 is not the agent.
            assert_eq!(classify_preflight(Some(400), false), Preflight::Unsupported);
            assert_eq!(classify_preflight(Some(422), false), Preflight::Unsupported);
        }

        #[test]
        fn preflight_404_is_unsupported() {
            assert_eq!(classify_preflight(Some(404), true), Preflight::Unsupported);
            assert_eq!(classify_preflight(Some(404), false), Preflight::Unsupported);
            // Neither a success nor a gate in front of the route is "native".
            for status in [200, 204, 401, 403, 405, 409, 418] {
                assert_eq!(
                    classify_preflight(Some(status), true),
                    Preflight::Unsupported,
                    "{status}"
                );
            }
        }

        #[test]
        fn preflight_302_is_edge_not_direct() {
            for status in [301, 302, 303, 307, 308] {
                assert_eq!(
                    classify_preflight(Some(status), false),
                    Preflight::EdgeNotDirect,
                    "{status}"
                );
            }
        }

        #[test]
        fn preflight_no_answer_is_unreachable() {
            assert_eq!(classify_preflight(None, false), Preflight::Unreachable);

            for status in [500, 502, 503, 504] {
                assert_eq!(
                    classify_preflight(Some(status), true),
                    Preflight::Unreachable,
                    "{status}"
                );
            }
        }

        // ── Cookie filter ────────────────────────────────────────────────────

        #[test]
        fn allr_work_cookie_filter_matches_parent_and_subdomains_only() {
            for domain in [
                "allr.work",
                ".allr.work",
                "app.allr.work",
                "authenticate.allr.work",
                ".AUTH.Allr.Work",
                "xm.dev.allr.work",
            ] {
                assert!(cookie_is_allr_work(domain, "allr.work"), "{domain}");
            }

            for domain in [
                "evilallr.work",
                ".evilallr.work",
                "allr.work.evil",
                "allr.workx",
                "work",
                "google.com",
                "",
                ".",
            ] {
                assert!(!cookie_is_allr_work(domain, "allr.work"), "{domain}");
            }

            // An empty parent matches nothing, rather than everything.
            assert!(!cookie_is_allr_work("allr.work", ""));
            assert!(!cookie_is_allr_work(".", ""));
        }

        // ── Outcome mailbox ──────────────────────────────────────────────────

        fn signed_in() -> AllrWorkOutcome {
            AllrWorkOutcome::SignedIn {
                workspace: "https://xm.allr.work".to_string(),
            }
        }

        #[test]
        fn outcome_mailbox_is_take_once() {
            let t0 = Instant::now();
            let mut mailbox = Mailbox::default();

            assert_eq!(mailbox.take(t0), None);

            mailbox.put(signed_in(), t0);

            assert_eq!(mailbox.take(t0 + Duration::from_secs(5)), Some(signed_in()));
            // A resume that fires twice must find nothing the second time.
            assert_eq!(mailbox.take(t0 + Duration::from_secs(6)), None);
        }

        #[test]
        fn outcome_mailbox_keeps_only_the_latest() {
            let t0 = Instant::now();
            let mut mailbox = Mailbox::default();
            let failed = AllrWorkOutcome::Failed {
                error: AllrWorkError::new(AllrWorkErrorKind::Cancelled, "cancelled"),
                workspace: None,
            };

            mailbox.put(failed, t0);
            mailbox.put(signed_in(), t0 + Duration::from_secs(1));

            assert_eq!(mailbox.take(t0 + Duration::from_secs(2)), Some(signed_in()));
            assert_eq!(mailbox.take(t0 + Duration::from_secs(3)), None);
        }

        #[test]
        fn outcome_mailbox_expires() {
            let t0 = Instant::now();
            let mut mailbox = Mailbox::default();

            mailbox.put(signed_in(), t0);
            assert_eq!(
                mailbox.take(t0 + OUTCOME_TTL - Duration::from_secs(1)),
                Some(signed_in())
            );

            mailbox.put(signed_in(), t0);
            assert_eq!(mailbox.take(t0 + OUTCOME_TTL), None);

            // Expired is also cleared: it does not come back if the clock were to rewind.
            assert_eq!(mailbox.take(t0), None);
        }

        // ── The wire ─────────────────────────────────────────────────────────

        /// Every object key in a JSON value, at any depth.
        fn keys(value: &serde_json::Value) -> Vec<String> {
            let mut out = Vec::new();
            let mut stack = vec![value];

            while let Some(value) = stack.pop() {
                match value {
                    serde_json::Value::Object(map) => {
                        for (key, child) in map {
                            out.push(key.clone());
                            stack.push(child);
                        }
                    }
                    serde_json::Value::Array(items) => stack.extend(items),
                    _ => {}
                }
            }

            out.sort();
            out
        }

        #[test]
        fn allr_work_replies_never_carry_state_code_or_token() {
            // The flow handles two states, a PKCE verifier, an authorization code and a
            // token set. None of them may cross IPC — pinned as exact key sets so that
            // ADDING a field, not just naming one "token", fails here first.
            let error = AllrWorkError::new(AllrWorkErrorKind::StateMismatch, "no");
            let cases = [
                (
                    serde_json::to_value(AllrWorkSignIn {
                        busy: false,
                        workspace: Some("https://xm.allr.work".into()),
                    }),
                    vec!["busy", "workspace"],
                ),
                (serde_json::to_value(&error), vec!["kind", "message"]),
                (serde_json::to_value(signed_in()), vec!["kind", "workspace"]),
                (
                    serde_json::to_value(AllrWorkOutcome::Failed {
                        error: error.clone(),
                        workspace: Some("https://xm.allr.work".into()),
                    }),
                    vec!["error", "kind", "kind", "message", "workspace"],
                ),
                (
                    serde_json::to_value(AllrWorkConfig::from(&prod())),
                    vec!["parentDomain", "portalUrl"],
                ),
                (
                    serde_json::to_value(AllrWorkClearReport {
                        cleared: 2,
                        supported: true,
                    }),
                    vec!["cleared", "supported"],
                ),
            ];

            for (json, expected) in cases {
                let json = json.unwrap();
                let found = keys(&json);

                assert_eq!(found, expected, "{json}");

                for key in &found {
                    let key = key.to_ascii_lowercase();

                    for secret in ["state", "code", "token", "verifier", "secret"] {
                        assert!(!key.contains(secret), "{key} in {json}");
                    }
                }
            }
        }

        #[test]
        fn outcome_serializes_as_a_kind_tagged_union() {
            assert_eq!(
                serde_json::to_value(signed_in()).unwrap(),
                serde_json::json!({ "kind": "signed-in", "workspace": "https://xm.allr.work" })
            );
            assert_eq!(
                serde_json::to_value(AllrWorkOutcome::Failed {
                    error: AllrWorkError::new(AllrWorkErrorKind::NoWorkspace, "none"),
                    workspace: None,
                })
                .unwrap(),
                serde_json::json!({
                    "kind": "failed",
                    "error": { "kind": "no-workspace", "message": "none" },
                    "workspace": null
                })
            );
        }

        #[test]
        fn allr_work_error_kinds_serialize_kebab_case() {
            use AllrWorkErrorKind::*;

            // The frontend's copy table is keyed on these exact strings.
            let expected = [
                (InvalidPortalConfig, "invalid-portal-config"),
                (Cancelled, "cancelled"),
                (TimedOut, "timed-out"),
                (NavigationRefused, "navigation-refused"),
                (AlreadyOnSignInPage, "already-on-sign-in-page"),
                (PortalRefused, "portal-refused"),
                (NoWorkspace, "no-workspace"),
                (PortalOutdated, "portal-outdated"),
                (StateMismatch, "state-mismatch"),
                (InvalidWorkspace, "invalid-workspace"),
                (WorkspaceUnsupported, "workspace-unsupported"),
                (Unreachable, "unreachable"),
                (SignInFailed, "sign-in-failed"),
                (CredentialNotSaved, "credential-not-saved"),
                (CookieStoreFailed, "cookie-store-failed"),
            ];

            // Exhaustive on purpose: a new variant does not compile until it is listed
            // above too.
            fn listed(kind: AllrWorkErrorKind) {
                match kind {
                    InvalidPortalConfig | Cancelled | TimedOut | NavigationRefused
                    | AlreadyOnSignInPage | PortalRefused | NoWorkspace | PortalOutdated
                    | StateMismatch | InvalidWorkspace | WorkspaceUnsupported | Unreachable
                    | SignInFailed | CredentialNotSaved | CookieStoreFailed => {}
                }
            }

            for (kind, wire) in expected {
                listed(kind);
                assert_eq!(
                    serde_json::to_value(kind).unwrap(),
                    serde_json::Value::String(wire.to_string())
                );
            }

            assert_eq!(expected.len(), 15);

            let err = AllrWorkError::new(TimedOut, "Sign-in took too long.");
            assert_eq!(err.to_string(), "Sign-in took too long.");
            assert_eq!(
                serde_json::to_value(&err).unwrap(),
                serde_json::json!({ "kind": "timed-out", "message": "Sign-in took too long." })
            );
        }
    }
}
