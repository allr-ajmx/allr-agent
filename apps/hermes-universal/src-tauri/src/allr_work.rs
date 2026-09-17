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
//!      `workspace=https://<user>.<DOMAIN>&state=<s1>` (plus, when the portal can tell,
//!      `connector=<dex connector id>`) — or `error=no_workspace` / `error=sign_in_failed`
//!      with the same state. Nothing secret crosses this hop: the portal learns a loopback
//!      port, the app learns a host name and which login (Google, password) was used.
//!   2. **Sign in.** The existing RFC 8252 native flow against that workspace
//!      (`oauth::native`, fresh PKCE and a fresh state), in the same surface, so the Dex
//!      session from hop 1 carries over. The connector from hop 1 rides along as
//!      `connector_id`, so Dex does not ask again which login to use. The bearer lands in
//!      the keyring under `nativeAuth:<workspace>` exactly as for any other gateway.
//!
//! The workspace host the portal returns is the one value in this flow that decides where
//! a bearer will later be sent, so it is validated here against a parent domain derived
//! from LOCAL configuration (never from the response): one DNS label under the portal's
//! parent, https, no port, no userinfo, no path, not a reserved label. Anything else fails
//! closed with a named error kind.
//!
//! # What lives here
//!
//! [`decide`] holds every decision in the flow as a pure function — portal config, the
//! hand-off URL, the loopback hand-back parser, the workspace host rule, the "portal does
//! not know the hand-off yet" detector, the preflight verdict, the cookie filter for
//! sign-out, and the take-once outcome mailbox.
//!
//! Out here is the I/O half: the four commands, the preflight request, and the mapping
//! from whatever went wrong to an [`decide::AllrWorkErrorKind`]. The loopback listener and
//! the sign-in surface are `oauth.rs`'s ([`crate::oauth::await_loopback`],
//! [`crate::oauth::SignInSurface`]), shared with the plain gateway sign-in rather than
//! copied, and hop 2 IS that sign-in ([`crate::oauth::native_login_on_surface`]).
//!
//! # Secrets
//!
//! Neither hop's state, the PKCE verifier, the code, the loopback request targets nor the
//! token set is ever logged, put in an error message, or returned. Every message this
//! module builds is fixed text, optionally quoting the workspace HOST (validated, and the
//! user's own) — never a URL with a query. Log lines carry the `[allr-work]` prefix.

use std::time::{Duration, Instant};

use tauri::{AppHandle, State, Url, WebviewWindow};

use crate::oauth::{
    self, native, LoopbackFailure, SignInSurface, SurfaceLoginFailure, SurfaceStop,
};
use crate::transport::TransportState;
use decide::{
    AllrWorkClearReport, AllrWorkConfig, AllrWorkError, AllrWorkErrorKind, AllrWorkOutcome,
    AllrWorkSignIn, PortalConfig,
};

/// The pure half of the Allr Work sign-in. No sockets, no webviews, no clocks, no
/// environment: every input arrives as an argument, so every branch is reachable from
/// the tests below.
pub mod decide {
    use std::time::{Duration, Instant};

    use serde::Serialize;
    use tauri::Url;

    /// The production portal: what a release build signs in through.
    pub const PROD_PORTAL: &str = "https://app.allr.work";

    /// The dev stack's portal (workspaces `*.dev.allr.work`, reached over NetBird): what a
    /// debug build (`tauri dev`, a mobile dev build) signs in through, so running the app
    /// from source never needs an environment variable to reach the dev system.
    pub const DEV_PORTAL: &str = "https://app.dev.allr.work";

    /// The portal a build uses when nothing overrides it: [`DEV_PORTAL`] for a debug build,
    /// [`PROD_PORTAL`] for a release build.
    pub const DEFAULT_PORTAL: &str = default_portal_for(cfg!(debug_assertions));

    /// [`DEFAULT_PORTAL`]'s rule, as a function so both branches are testable from one build.
    pub const fn default_portal_for(debug_build: bool) -> &'static str {
        if debug_build {
            DEV_PORTAL
        } else {
            PROD_PORTAL
        }
    }

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
    /// way an Android/iOS build can carry an override), then [`DEFAULT_PORTAL`] (the dev
    /// portal in a debug build, production in a release build).
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

    /// What a successful hop 1 hands back.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct Handoff {
        /// The workspace, already held to [`validate_workspace`].
        pub workspace: Url,
        /// The Dex connector the user signed in with (`google`, `local`), when the portal
        /// named exactly one well-formed id. Only a hint for hop 2 — `None` just means Dex
        /// shows its picker again — so it is never a reason to fail the hand-back.
        pub connector: Option<String>,
    }

    /// Read the request target our hop-1 listener received
    /// (`/workspace?workspace=<url>&connector=<id>&state=<s>`, `connector` optional, or
    /// `/workspace?error=<e>&state=<s>`).
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
    ///   5. **Only then the `connector`**: exactly one value that is
    ///      [`native::is_connector_id`] becomes [`Handoff::connector`]; missing, empty,
    ///      malformed or repeated is `None`. Never an error — a bad hint costs the user one
    ///      extra click in Dex's picker, not the sign-in.
    ///
    /// Duplicates fail closed rather than taking the first or last value: the portal
    /// builds this query with `urlencode` over a dict and can never repeat a key, so a
    /// repeat is not the portal, and "which one did you mean" has no safe answer. A
    /// repeated `state` is a state problem (we cannot say the request is ours); a repeated
    /// `error`/`workspace` under a good state is a malformed hand-back (`portal-refused`);
    /// a repeated `connector` is dropped (no hint).
    ///
    /// [`native::is_connector_id`]: crate::oauth::native::is_connector_id
    pub fn parse_handoff_target(
        target: &str,
        expected_state: &str,
        cfg: &PortalConfig,
    ) -> Option<Result<Handoff, AllrWorkError>> {
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
        let mut connectors = Vec::new();

        for (key, value) in carrier.query_pairs() {
            match key.as_ref() {
                "state" => states.push(value.into_owned()),
                "workspace" => workspaces.push(value.into_owned()),
                "error" => errors.push(value.into_owned()),
                "connector" => connectors.push(value.into_owned()),
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

        Some(validate_workspace(workspace, cfg).map(|workspace| Handoff {
            workspace,
            connector: handoff_connector(&connectors),
        }))
    }

    /// The one well-formed connector id among a hand-back's `connector` values, if there is
    /// exactly one. The shape rule is the gateway's, shared with the authorize URL that
    /// carries it on ([`crate::oauth::native::is_connector_id`]).
    fn handoff_connector(values: &[String]) -> Option<String> {
        match values {
            [connector] if crate::oauth::native::is_connector_id(connector) => {
                Some(connector.clone())
            }
            _ => None,
        }
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

    /// One host whose Allr Work cookies a store without a cookie listing (Android's
    /// `CookieManager`) must expire by name.
    #[cfg_attr(
        not(target_os = "android"),
        allow(dead_code, reason = "only Android's CookieManager is scrubbed by host")
    )]
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct CookieHost {
        /// `https://<host>/`. The `/` path is deliberate: it is the only cookie `Path` the
        /// store reads back for this URL, and so the only one expired.
        pub url: String,
        /// The `Domain=` values each cookie name is expired under besides host-only: the
        /// host itself, then the parent (once, for the parent host).
        pub domains: Vec<String>,
    }

    /// The hosts to scrub on sign-out where the store cannot enumerate its cookies: the
    /// parent domain, every platform host under it ([`RESERVED_LABELS`] — the portal on
    /// `app.`, Dex on `auth.`, Pomerium on `authenticate.`, and the admin hosts), and the
    /// signed-in workspace when the caller knows it.
    ///
    /// A cookie is visible on a host when it is host-only there or scoped to one of the
    /// host's parent domains, so expiring each name host-only, under `Domain=<host>` and
    /// under `Domain=<parent>` covers every cookie of ours on that host.
    ///
    /// Never outside the parent: every host is checked with [`cookie_is_allr_work`], so a
    /// workspace from somewhere else is dropped rather than scrubbed, whatever the caller
    /// validated. The single-label rule is [`validate_workspace`]'s job, not this one's.
    /// Duplicates (a workspace that names a platform host) are dropped, first one kept.
    #[cfg_attr(
        not(target_os = "android"),
        allow(dead_code, reason = "only Android's CookieManager is scrubbed by host")
    )]
    pub fn cookie_hosts(cfg: &PortalConfig, workspace: Option<&Url>) -> Vec<CookieHost> {
        let parent = cfg.parent.to_ascii_lowercase();
        let candidates = std::iter::once(parent.clone())
            .chain(
                RESERVED_LABELS
                    .iter()
                    .map(|label| format!("{label}.{parent}")),
            )
            .chain(workspace.and_then(Url::domain).map(str::to_ascii_lowercase));

        let mut hosts: Vec<String> = Vec::new();

        for host in candidates {
            if cookie_is_allr_work(&host, &parent) && !hosts.contains(&host) {
                hosts.push(host);
            }
        }

        hosts
            .into_iter()
            .map(|host| {
                let mut domains = vec![host.clone()];

                if host != parent {
                    domains.push(parent.clone());
                }

                CookieHost {
                    url: format!("https://{host}/"),
                    domains,
                }
            })
            .collect()
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn prod() -> PortalConfig {
            portal_config(PROD_PORTAL).expect("the production portal is valid")
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
        fn a_debug_build_defaults_to_the_dev_portal_and_a_release_build_to_production() {
            assert_eq!(default_portal_for(true), "https://app.dev.allr.work");
            assert_eq!(default_portal_for(false), "https://app.allr.work");
            assert_eq!(DEFAULT_PORTAL, default_portal_for(cfg!(debug_assertions)));
            // Both are real portals with the parent domain their workspaces live under.
            assert_eq!(portal_config(DEV_PORTAL).unwrap().parent, "dev.allr.work");
            assert_eq!(portal_config(PROD_PORTAL).unwrap().parent, "allr.work");
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
            let handoff = parse_handoff_target(&hit, STATE, &prod())
                .expect("a hand-back")
                .expect("a valid workspace");

            assert_eq!(workspace_base(&handoff.workspace), "https://xm.allr.work");
            // An older portal names no connector: still a hand-back, with no hint.
            assert_eq!(handoff.connector, None);

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

        /// A good hand-back under our state, with `connector` query text appended.
        fn connector_target(connector_query: &str) -> String {
            target(&format!(
                "workspace=https%3A%2F%2Fxm.allr.work{connector_query}&state={STATE}"
            ))
        }

        #[test]
        fn handoff_carries_a_well_formed_connector() {
            let cfg = prod();

            for (query, expected) in [
                ("&connector=google", "google"),
                ("&connector=local", "local"),
                ("&connector=my_ldap-2", "my_ldap-2"),
                ("&connector=0", "0"),
            ] {
                let handoff = parse_handoff_target(&connector_target(query), STATE, &cfg)
                    .expect("a hand-back")
                    .expect("a valid workspace");

                assert_eq!(handoff.workspace, url("https://xm.allr.work"), "{query}");
                assert_eq!(handoff.connector.as_deref(), Some(expected), "{query}");
            }

            // Where the portal puts it in the query does not matter.
            let first = target(&format!(
                "connector=google&workspace=https%3A%2F%2Fxm.allr.work&state={STATE}"
            ));
            assert_eq!(
                parse_handoff_target(&first, STATE, &cfg)
                    .unwrap()
                    .unwrap()
                    .connector
                    .as_deref(),
                Some("google")
            );
        }

        #[test]
        fn a_missing_or_bad_connector_is_no_hint_never_a_failure() {
            let cfg = prod();
            let longest = "a".repeat(64);
            let too_long = "a".repeat(65);

            // The 64-character id is the longest the gateway accepts.
            assert_eq!(
                parse_handoff_target(
                    &connector_target(&format!("&connector={longest}")),
                    STATE,
                    &cfg
                )
                .unwrap()
                .unwrap()
                .connector,
                Some(longest)
            );

            for query in [
                String::new(),
                "&connector=".to_string(),
                "&connector=Google".to_string(),
                "&connector=-x".to_string(),
                "&connector=_x".to_string(),
                "&connector=a%20b".to_string(),
                "&connector=a+b".to_string(),
                "&connector=goo.gle".to_string(),
                "&connector=google%0A".to_string(),
                "&connector=g%C3%B6ogle".to_string(),
                format!("&connector={too_long}"),
                // Repeated — even identically — is not the portal, and no hint.
                "&connector=google&connector=google".to_string(),
                "&connector=google&connector=local".to_string(),
                "&connector=&connector=google".to_string(),
            ] {
                let handoff = parse_handoff_target(&connector_target(&query), STATE, &cfg)
                    .expect("a hand-back")
                    .unwrap_or_else(|e| panic!("{query}: the hand-back must still succeed: {e:?}"));

                assert_eq!(handoff.workspace, url("https://xm.allr.work"), "{query}");
                assert_eq!(handoff.connector, None, "{query}");
            }
        }

        #[test]
        fn a_connector_never_outranks_the_state_or_the_workspace() {
            let cfg = prod();

            // No state of ours: state-mismatch, whatever connector rides along — valid,
            // invalid or repeated.
            for connector in [
                "&connector=google",
                "&connector=Google",
                "&connector=google&connector=local",
            ] {
                for query in [
                    format!("workspace=https%3A%2F%2Fxm.allr.work{connector}&state=forged-state-value-000000"),
                    format!("workspace=https%3A%2F%2Fxm.allr.work{connector}"),
                    format!("error=no_workspace{connector}&state=forged-state-value-000000"),
                    connector.trim_start_matches('&').to_string(),
                ] {
                    assert_eq!(
                        kind_of(parse_handoff_target(&target(&query), STATE, &cfg).unwrap()),
                        AllrWorkErrorKind::StateMismatch,
                        "{query}"
                    );
                }
            }

            // Under a good state a connector rescues nothing: the workspace rule, the
            // portal's errors and the one-workspace rule all still decide.
            for (query, kind) in [
                (
                    format!(
                        "workspace=https%3A%2F%2Fauth.allr.work&connector=google&state={STATE}"
                    ),
                    AllrWorkErrorKind::InvalidWorkspace,
                ),
                (
                    format!("error=no_workspace&connector=google&state={STATE}"),
                    AllrWorkErrorKind::NoWorkspace,
                ),
                (
                    format!("connector=google&state={STATE}"),
                    AllrWorkErrorKind::PortalRefused,
                ),
            ] {
                assert_eq!(
                    kind_of(parse_handoff_target(&target(&query), STATE, &cfg).unwrap()),
                    kind,
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

        // ── Cookie hosts (Android sign-out) ──────────────────────────────────

        fn host(url: &str, domains: &[&str]) -> CookieHost {
            CookieHost {
                url: url.into(),
                domains: domains.iter().map(|d| d.to_string()).collect(),
            }
        }

        fn platform_hosts() -> Vec<CookieHost> {
            vec![
                host("https://allr.work/", &["allr.work"]),
                host("https://app.allr.work/", &["app.allr.work", "allr.work"]),
                host("https://auth.allr.work/", &["auth.allr.work", "allr.work"]),
                host(
                    "https://authenticate.allr.work/",
                    &["authenticate.allr.work", "allr.work"],
                ),
                host(
                    "https://admin.allr.work/",
                    &["admin.allr.work", "allr.work"],
                ),
                host(
                    "https://pgadmin.allr.work/",
                    &["pgadmin.allr.work", "allr.work"],
                ),
            ]
        }

        #[test]
        fn cookie_hosts_without_a_workspace_are_the_parent_and_platform_hosts() {
            assert_eq!(cookie_hosts(&prod(), None), platform_hosts());
        }

        #[test]
        fn cookie_hosts_add_the_signed_in_workspace_last() {
            let workspace = validate_workspace("https://XM.allr.work/", &prod()).unwrap();
            let mut expected = platform_hosts();
            expected.push(host(
                "https://xm.allr.work/",
                &["xm.allr.work", "allr.work"],
            ));

            assert_eq!(cookie_hosts(&prod(), Some(&workspace)), expected);
        }

        #[test]
        fn cookie_hosts_follow_a_dev_parent() {
            let workspace = url("https://xm.dev.allr.work");
            let hosts = cookie_hosts(&dev(), Some(&workspace));

            assert_eq!(hosts[0], host("https://dev.allr.work/", &["dev.allr.work"]));
            assert_eq!(
                hosts.last().unwrap(),
                &host(
                    "https://xm.dev.allr.work/",
                    &["xm.dev.allr.work", "dev.allr.work"]
                )
            );
            assert_eq!(hosts.len(), 1 + RESERVED_LABELS.len() + 1);
        }

        #[test]
        fn cookie_hosts_never_leave_the_parent_or_repeat() {
            // Unvalidated on purpose: the guard must hold whatever the caller checked.
            for raw in [
                "https://evil.example.test",
                "https://xmallr.work",
                "https://allr.work.evil",
                "https://google.com",
                "https://127.0.0.1",
                "https://app.allr.work",
                "https://allr.work",
            ] {
                assert_eq!(
                    cookie_hosts(&prod(), Some(&url(raw))),
                    platform_hosts(),
                    "{raw}"
                );
            }

            for workspace in [None, Some(url("https://xm.allr.work"))] {
                let hosts = cookie_hosts(&prod(), workspace.as_ref());

                for (i, entry) in hosts.iter().enumerate() {
                    let parsed = url(&entry.url);

                    assert_eq!(parsed.path(), "/", "{}", entry.url);
                    assert!(
                        cookie_is_allr_work(parsed.domain().unwrap(), "allr.work"),
                        "{}",
                        entry.url
                    );
                    assert!(
                        entry
                            .domains
                            .iter()
                            .all(|d| cookie_is_allr_work(d, "allr.work")),
                        "{entry:?}"
                    );
                    assert!(
                        hosts[..i].iter().all(|earlier| earlier.url != entry.url),
                        "{} repeated",
                        entry.url
                    );
                }
            }
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

// ── Managed state ────────────────────────────────────────────────────────────

/// The outcome mailbox (see [`decide::Mailbox`]), managed on every target so the builder
/// chain in `lib.rs` has one shape. Only a mobile sign-in writes to it; on desktop the
/// command's own reply carries the result and `allr_work_take_outcome` always answers
/// `None`.
///
/// A `std` mutex on purpose: every access is a put or a take with nothing awaited while
/// the lock is held.
#[derive(Default)]
pub struct AllrWorkState(std::sync::Mutex<decide::Mailbox>);

impl AllrWorkState {
    fn with_mailbox<R>(&self, f: impl FnOnce(&mut decide::Mailbox) -> R) -> R {
        // A poisoned slot is recovered, not propagated: it holds at most one outcome and
        // no invariant a panic elsewhere could have broken.
        let mut mailbox = match self.0.lock() {
            Ok(mailbox) => mailbox,
            Err(poisoned) => poisoned.into_inner(),
        };

        f(&mut mailbox)
    }

    #[cfg_attr(
        not(mobile),
        allow(dead_code, reason = "only a mobile sign-in parks its outcome")
    )]
    fn put(&self, outcome: AllrWorkOutcome) {
        self.with_mailbox(|mailbox| mailbox.put(outcome, Instant::now()));
    }

    fn take(&self) -> Option<AllrWorkOutcome> {
        self.with_mailbox(|mailbox| mailbox.take(Instant::now()))
    }
}

// ── Configuration ────────────────────────────────────────────────────────────

/// The portal this process signs in through: `ALLR_WORK_PORTAL_URL` from the environment
/// (desktop only — nothing sets a phone app's environment), then the same variable at
/// build time, then the build's default: the dev portal in a debug build, production in a
/// release build. See [`decide::resolve_portal`].
fn configured_portal() -> Result<PortalConfig, AllrWorkError> {
    #[cfg(desktop)]
    let runtime = std::env::var("ALLR_WORK_PORTAL_URL").ok();
    #[cfg(mobile)]
    let runtime: Option<String> = None;

    decide::portal_config(decide::resolve_portal(
        runtime.as_deref(),
        option_env!("ALLR_WORK_PORTAL_URL"),
    ))
}

// ── Commands ─────────────────────────────────────────────────────────────────

/// Which portal this build signs in through, and the parent domain a saved workspace
/// URL must sit under.
#[tauri::command]
pub async fn allr_work_config() -> Result<AllrWorkConfig, AllrWorkError> {
    configured_portal().map(|cfg| AllrWorkConfig::from(&cfg))
}

/// Collect the outcome a mobile sign-in parked before it navigated the app back. Take-once.
#[tauri::command]
pub fn allr_work_take_outcome(allr: State<'_, AllrWorkState>) -> Option<AllrWorkOutcome> {
    allr.take()
}

/// Sign in to Allr Work: find the workspace through the portal (hop 1), check it can
/// broker an app sign-in (preflight), and run the RFC 8252 sign-in against it (hop 2) —
/// both hops on one sign-in surface, so the portal's Dex session carries into hop 2.
///
/// Desktop answers with the workspace. Mobile loses the JS context that asked the moment
/// hop 1 navigates, so it ALSO parks the result in the mailbox — before navigating back,
/// so the reloaded SPA always finds it — unless the app was never left (a refusal before
/// or at the first navigation), in which case the caller is still alive to read the
/// `Err` and the mailbox is left alone.
///
/// `busy: true` means another sign-in already owns this webview (or, on desktop, the
/// shared sign-in window) and this call did nothing.
#[tauri::command]
pub async fn allr_work_sign_in(
    app: AppHandle,
    webview: WebviewWindow,
    state: State<'_, TransportState>,
    allr: State<'_, AllrWorkState>,
) -> Result<AllrWorkSignIn, AllrWorkError> {
    let cfg = configured_portal()?;
    let busy = || AllrWorkSignIn {
        busy: true,
        workspace: None,
    };

    // Held for the whole command, like `oauth_login`'s. On desktop the sign-in window is
    // ONE global label, so no two flows may drive it at once — `oauth_login` included.
    let Some(_caller_lease) = oauth::claim_sign_in(webview.label()) else {
        return Ok(busy());
    };
    let Some(surface_lease) = oauth::claim_surface() else {
        return Ok(busy());
    };

    log::info!(
        "[allr-work] signing in through {}",
        AllrWorkConfig::from(&cfg).portal_url
    );

    let mut surface = SignInSurface::new(&app, &webview, &surface_lease);
    let result = sign_in_on_surface(&mut surface, state.inner(), &cfg).await;

    match &result {
        Ok(workspace) => log::info!("[allr-work] signed in to {workspace}"),
        Err(failure) => log::warn!(
            "[allr-work] sign-in did not complete ({:?}): {}",
            failure.error.kind,
            failure.error.message
        ),
    }

    #[cfg(mobile)]
    {
        if let Some(outcome) = mobile_outcome(&result, surface.left_app()) {
            allr.put(outcome);
        }
    }
    #[cfg(desktop)]
    let _ = &allr;

    // Desktop: close the window. Mobile: navigate back to the app, AFTER the mailbox
    // write above — the reload this starts reads it.
    surface.finish();

    command_reply(result)
}

/// Forget the Allr Work browser session: delete the cookies the sign-in pages left under
/// the portal's parent domain (Pomerium, Dex, the portal), so the next sign-in can pick a
/// different account. Google's cookies are deliberately left alone.
///
/// `supported: false` on a platform that cannot delete webview cookies — a caller must not
/// present that as "nothing to clear". Every current target reports `true`.
///
/// `workspace` (optional, JS key `workspace`): the signed-in workspace base
/// (`https://<user>.<DOMAIN>`), when the caller has one. Android's `CookieManager` cannot
/// list its cookies, so there the command scrubs a fixed set of hosts
/// ([`decide::cookie_hosts`]) and a workspace's own cookies are only reached when it is
/// named here. Desktop and iOS enumerate the store and do not need it. It is validated
/// with [`decide::validate_workspace`] on every platform, before anything is deleted, so
/// the argument means the same thing everywhere; an invalid one is `invalid-workspace`.
#[tauri::command]
pub async fn allr_work_clear_session(
    app: AppHandle,
    webview: WebviewWindow,
    workspace: Option<String>,
) -> Result<AllrWorkClearReport, AllrWorkError> {
    let cfg = configured_portal()?;
    let workspace = workspace
        .as_deref()
        .map(|raw| decide::validate_workspace(raw, &cfg))
        .transpose()
        .map_err(|_| {
            AllrWorkError::new(
                AllrWorkErrorKind::InvalidWorkspace,
                "That is not an Allr Work workspace address, so no sign-in cookies were cleared.",
            )
        })?;

    #[cfg(target_os = "android")]
    let report = {
        let _ = &webview;
        let hosts = decide::cookie_hosts(&cfg, workspace.as_ref())
            .into_iter()
            .map(|host| tauri_plugin_cookie_store::ExpireTarget {
                url: host.url,
                domains: host.domains,
            })
            .collect();

        crate::webview_cookies::expire_on_hosts(&app, hosts).await
    };

    #[cfg(not(target_os = "android"))]
    let report = {
        let _ = (&app, &workspace);
        let parent = cfg.parent.clone();

        crate::webview_cookies::delete_matching(&webview, move |domain| {
            decide::cookie_is_allr_work(domain, &parent)
        })
        .await
    };

    let report = report.map_err(|detail| {
        log::warn!("[allr-work] could not clear the Allr Work cookies: {detail}");

        AllrWorkError::new(
            AllrWorkErrorKind::CookieStoreFailed,
            "The Allr Work sign-in cookies could not be cleared.",
        )
    })?;

    log::info!(
        "[allr-work] cleared {} Allr Work cookie(s) under {} (supported: {})",
        report.deleted,
        cfg.parent,
        report.supported
    );

    Ok(AllrWorkClearReport {
        cleared: report.deleted,
        supported: report.supported,
    })
}

// ── The sign-in ──────────────────────────────────────────────────────────────

/// How long the preflight may take, body included. The reqwest clients have no timeout of
/// their own, and a workspace that accepts the connection and never answers must not
/// strand the user between the hops.
const PREFLIGHT_TIMEOUT: Duration = Duration::from_secs(15);

/// A sign-in that did not complete, and the workspace hop 1 found when it got that far.
#[derive(Debug, Clone, PartialEq, Eq)]
struct SignInFailure {
    error: AllrWorkError,
    workspace: Option<String>,
}

/// Both hops and the preflight between them, on one surface. `Ok` is the workspace base
/// (`https://<user>.<domain>`), under which the token set is now stored.
async fn sign_in_on_surface(
    surface: &mut SignInSurface<'_>,
    transport: &TransportState,
    cfg: &PortalConfig,
) -> Result<String, SignInFailure> {
    let decide::Handoff {
        workspace,
        connector,
    } = discover_workspace(surface, cfg)
        .await
        .map_err(|error| SignInFailure {
            error,
            workspace: None,
        })?;

    let base = decide::workspace_base(&workspace);
    // `validate_workspace` only accepts a DNS name, so there is always a host.
    let host = workspace.host_str().unwrap_or_default().to_string();
    let failed = |error| SignInFailure {
        error,
        workspace: Some(base.clone()),
    };

    log::info!("[allr-work] the portal named {base}; checking it supports app sign-in");
    // The connector id alone (`google`, `local`) — a login method, not a secret.
    log::debug!(
        "[allr-work] hop 1 connector hint: {}",
        connector.as_deref().unwrap_or("(none)")
    );

    if let Some(error) = preflight_error(preflight(transport, &base).await, &host) {
        return Err(failed(error));
    }

    // Hop 2. No provider: an Allr workspace has exactly one session provider, and the
    // native route picks it when none is named. The connector hop 1 used goes along so Dex
    // skips its picker (a gateway that predates the hint ignores it). Tokens land under
    // `base` — the keyring scope every later request to this workspace looks up. There is
    // deliberately no cookie-cascade fallback here: it cannot complete behind Pomerium.
    oauth::native_login_on_surface(surface, transport, &base, "", connector.as_deref())
        .await
        .map_err(|e| {
            if hop2_detail_is_loggable(e.failure) {
                log::warn!(
                    "[allr-work] hop 2 failed ({:?}): {}",
                    e.failure,
                    crate::transport::redact_message(e.message)
                );
            }

            failed(settle_hop2_failure(transport, &base, e.failure, &host))
        })?;

    Ok(base)
}

/// Hop 1: open the portal with a hand-off, and wait for it to hand the workspace (and the
/// connector it signed in with, when the portal says) back.
async fn discover_workspace(
    surface: &mut SignInSurface<'_>,
    cfg: &PortalConfig,
) -> Result<decide::Handoff, AllrWorkError> {
    let could_not_start = |detail: String| {
        log::warn!("[allr-work] could not start hop 1: {detail}");

        AllrWorkError::new(AllrWorkErrorKind::Unreachable, COULD_NOT_START)
    };

    let state = native::generate_state().map_err(could_not_start)?;

    // Bound BEFORE the portal is opened: its redirect has to name a port that is already
    // listening, or a signed-in user's instant 302 could beat us to it.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| could_not_start(format!("could not open a loopback listener: {e}")))?;
    let port = listener
        .local_addr()
        .map_err(|e| could_not_start(format!("could not read the loopback port: {e}")))?
        .port();

    let redirect_uri = decide::handoff_redirect_uri(port);
    let target = Url::parse(&decide::handoff_url(cfg, &redirect_uri, &state)).map_err(|_| {
        AllrWorkError::new(
            AllrWorkErrorKind::InvalidPortalConfig,
            "The Allr Work portal address is not valid.",
        )
    })?;

    surface
        .show(&target)
        .await
        .map_err(|e| hop1_open_error(e.failure))?;

    let parse_cfg = cfg.clone();
    let wait = oauth::await_loopback(
        listener,
        move |request_target: &str| {
            decide::parse_handoff_target(request_target, &state, &parse_cfg)
        },
        native::CallbackPage::WorkspaceFound,
        surface.hop_timeout_secs(),
        true,
    );

    let watch_cfg = cfg.clone();
    let portal_skipped_the_handoff = move |now: &Url| {
        decide::hop1_surface_verdict(now, &watch_cfg)
            == decide::SurfaceVerdict::PortalWithoutHandoff
    };

    hop1_result(surface.race(wait, Some(&portal_skipped_the_handoff)).await)
}

/// `GET <workspace>/auth/native/authorize` with no parameters, no bearer and redirects
/// OFF, classified by [`decide::classify_preflight`].
async fn preflight(transport: &TransportState, base: &str) -> decide::Preflight {
    let url = format!("{base}/auth/native/authorize");

    let response = transport
        .no_redirect_client()
        .get(&url)
        .timeout(PREFLIGHT_TIMEOUT)
        .send()
        .await;

    let resp = match response {
        Ok(resp) => resp,
        Err(e) => {
            log::warn!(
                "[allr-work] preflight could not reach {base}: {}",
                crate::transport::redact_error(e.to_string(), &url)
            );

            return decide::classify_preflight(None, false);
        }
    };

    let status = resp.status().as_u16();
    let json_body = resp
        .bytes()
        .await
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .is_some_and(|body| body.is_object());
    let verdict = decide::classify_preflight(Some(status), json_body);

    log::info!("[allr-work] preflight {base}: HTTP {status}, json={json_body} -> {verdict:?}");

    verdict
}

// ── Failure mapping (pure) ───────────────────────────────────────────────────

const COULD_NOT_START: &str = "This device could not start the sign-in. Try again.";

fn cancelled() -> AllrWorkError {
    AllrWorkError::new(AllrWorkErrorKind::Cancelled, "The sign-in was cancelled.")
}

fn already_on_sign_in_page() -> AllrWorkError {
    AllrWorkError::new(
        AllrWorkErrorKind::AlreadyOnSignInPage,
        "A sign-in page is already open. Finish it, or go back, before signing in again.",
    )
}

/// Hop 1 could not even put the portal on the surface.
fn hop1_open_error(failure: SurfaceLoginFailure) -> AllrWorkError {
    match failure {
        SurfaceLoginFailure::AlreadyOnSignInPage => already_on_sign_in_page(),
        SurfaceLoginFailure::Cancelled => cancelled(),
        // `show` fails only with the three above; anything else is still "could not open".
        _ => AllrWorkError::new(
            AllrWorkErrorKind::NavigationRefused,
            "The Allr Work sign-in page could not be opened on this device.",
        ),
    }
}

/// How hop 1's wait ended, as the flow's result.
fn hop1_result(
    verdict: Result<Result<Result<decide::Handoff, AllrWorkError>, LoopbackFailure>, SurfaceStop>,
) -> Result<decide::Handoff, AllrWorkError> {
    match verdict {
        // The hand-back itself — a workspace, or the portal's / the parser's named error.
        Ok(Ok(handback)) => handback,
        Ok(Err(LoopbackFailure::TimedOut)) => Err(AllrWorkError::new(
            AllrWorkErrorKind::TimedOut,
            "Signing in to Allr Work took too long.",
        )),
        Ok(Err(LoopbackFailure::Listener(detail))) => {
            log::warn!("[allr-work] the hop 1 listener failed: {detail}");

            Err(AllrWorkError::new(
                AllrWorkErrorKind::Unreachable,
                COULD_NOT_START,
            ))
        }
        Err(SurfaceStop::Cancelled) => Err(cancelled()),
        Err(SurfaceStop::Refused) => Err(AllrWorkError::new(
            AllrWorkErrorKind::NavigationRefused,
            "The Allr Work sign-in page could not be opened on this device.",
        )),
        Err(SurfaceStop::Watched) => Err(AllrWorkError::new(
            AllrWorkErrorKind::PortalOutdated,
            "Allr Work opened your workspace instead of returning to the app: app sign-in \
             is not available from the portal yet.",
        )),
    }
}

/// The preflight's verdict as a failure, or `None` to go on to hop 2.
fn preflight_error(verdict: decide::Preflight, host: &str) -> Option<AllrWorkError> {
    match verdict {
        decide::Preflight::Native => None,
        decide::Preflight::Unsupported | decide::Preflight::EdgeNotDirect => {
            Some(AllrWorkError::new(
                AllrWorkErrorKind::WorkspaceUnsupported,
                format!("{host} does not support signing in from the app yet."),
            ))
        }
        decide::Preflight::Unreachable => Some(AllrWorkError::new(
            AllrWorkErrorKind::Unreachable,
            format!("Could not reach {host}."),
        )),
    }
}

/// A hop-2 failure as an error kind. The message is built here from the kind and the
/// workspace host alone: [`oauth::SurfaceLoginError::message`] can quote the authorize
/// URL, state included.
fn hop2_error(failure: SurfaceLoginFailure, host: &str) -> AllrWorkError {
    use AllrWorkErrorKind as Kind;
    use SurfaceLoginFailure as F;

    match failure {
        F::Setup | F::Listener => AllrWorkError::new(Kind::Unreachable, COULD_NOT_START),
        F::AlreadyOnSignInPage => already_on_sign_in_page(),
        F::SurfaceUnavailable | F::NavigationRefused => AllrWorkError::new(
            Kind::NavigationRefused,
            format!("The sign-in page for {host} could not be opened on this device."),
        ),
        F::Cancelled => cancelled(),
        F::TimedOut => AllrWorkError::new(
            Kind::TimedOut,
            format!("Signing in to {host} took too long."),
        ),
        F::StateMismatch => AllrWorkError::new(
            Kind::StateMismatch,
            format!("The sign-in response from {host} did not match this request."),
        ),
        F::CallbackRefused | F::TokenRejected => {
            AllrWorkError::new(Kind::SignInFailed, format!("{host} refused the sign-in."))
        }
        F::TokenUnreachable => AllrWorkError::new(
            Kind::Unreachable,
            format!("Could not reach {host} to finish signing in."),
        ),
        F::NotSaved => AllrWorkError::new(
            Kind::CredentialNotSaved,
            format!(
                "Signed in to {host}, but this device could not store the credential securely."
            ),
        ),
    }
}

/// [`hop2_error`], plus the one side effect a hop-2 failure needs: when the credential
/// could not be written to the keyring, drop the copy `store_native_tokens` already put
/// in the transport's bearer cache.
///
/// That cache is written BEFORE the keyring, so without this the process kept attaching
/// a bearer for a sign-in this command reports as failed — the app would work until the
/// next launch and then silently not, the exact "works until restart" failure
/// `credential-not-saved` exists to name up front. Scoped to Allr Work on purpose:
/// `oauth_login`'s desktop arm falls back to the cookie cascade after this failure, and
/// what the cache does there is outside this change.
fn settle_hop2_failure(
    transport: &TransportState,
    base: &str,
    failure: SurfaceLoginFailure,
    host: &str,
) -> AllrWorkError {
    if failure == SurfaceLoginFailure::NotSaved {
        transport.forget_bearer_base(base);
    }

    hop2_error(failure, host)
}

/// May `oauth::SurfaceLoginError::message` for this failure go in a log line? Only for the
/// failures whose message is built from things that are not the authorize URL: a refused
/// navigation quotes it (state included), and a surface error can quote a platform error
/// that might.
fn hop2_detail_is_loggable(failure: SurfaceLoginFailure) -> bool {
    use SurfaceLoginFailure as F;

    matches!(
        failure,
        F::Setup
            | F::Listener
            | F::CallbackRefused
            | F::TokenRejected
            | F::TokenUnreachable
            | F::NotSaved
    )
}

/// What a mobile sign-in parks for the reloaded SPA, or `None` when the app was never left
/// — then the caller's JS context is alive, reads the command's `Err` itself, and a parked
/// copy would be read AGAIN by some later resume.
#[cfg_attr(
    not(mobile),
    allow(dead_code, reason = "only a mobile sign-in parks its outcome")
)]
fn mobile_outcome(
    result: &Result<String, SignInFailure>,
    left_app: bool,
) -> Option<AllrWorkOutcome> {
    if !left_app {
        return None;
    }

    Some(match result {
        Ok(workspace) => AllrWorkOutcome::SignedIn {
            workspace: workspace.clone(),
        },
        Err(failure) => AllrWorkOutcome::Failed {
            error: failure.error.clone(),
            workspace: failure.workspace.clone(),
        },
    })
}

/// The command's own reply.
fn command_reply(result: Result<String, SignInFailure>) -> Result<AllrWorkSignIn, AllrWorkError> {
    result
        .map(|workspace| AllrWorkSignIn {
            busy: false,
            workspace: Some(workspace),
        })
        .map_err(|failure| failure.error)
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOST: &str = "xm.allr.work";

    fn every_surface_failure() -> [SurfaceLoginFailure; 12] {
        use SurfaceLoginFailure as F;

        // Exhaustive on purpose: a new failure does not compile until it is listed here,
        // and so cannot reach `hop2_error` untested.
        fn listed(failure: SurfaceLoginFailure) {
            match failure {
                F::Setup
                | F::AlreadyOnSignInPage
                | F::SurfaceUnavailable
                | F::Cancelled
                | F::NavigationRefused
                | F::TimedOut
                | F::Listener
                | F::StateMismatch
                | F::CallbackRefused
                | F::TokenRejected
                | F::TokenUnreachable
                | F::NotSaved => {}
            }
        }

        let all = [
            F::Setup,
            F::AlreadyOnSignInPage,
            F::SurfaceUnavailable,
            F::Cancelled,
            F::NavigationRefused,
            F::TimedOut,
            F::Listener,
            F::StateMismatch,
            F::CallbackRefused,
            F::TokenRejected,
            F::TokenUnreachable,
            F::NotSaved,
        ];

        all.into_iter().for_each(listed);

        all
    }

    #[test]
    fn hop2_failures_map_to_their_error_kinds() {
        use AllrWorkErrorKind as Kind;
        use SurfaceLoginFailure as F;

        let expected = [
            (F::Setup, Kind::Unreachable),
            (F::AlreadyOnSignInPage, Kind::AlreadyOnSignInPage),
            (F::SurfaceUnavailable, Kind::NavigationRefused),
            (F::Cancelled, Kind::Cancelled),
            (F::NavigationRefused, Kind::NavigationRefused),
            (F::TimedOut, Kind::TimedOut),
            (F::Listener, Kind::Unreachable),
            (F::StateMismatch, Kind::StateMismatch),
            (F::CallbackRefused, Kind::SignInFailed),
            // The workspace ANSWERED the code exchange and did not hand over tokens: a
            // refusal, not a network problem.
            (F::TokenRejected, Kind::SignInFailed),
            (F::TokenUnreachable, Kind::Unreachable),
            // A keyring failure is its own kind, never "sign-in failed": the user did sign
            // in, and retrying will not fix the credential store.
            (F::NotSaved, Kind::CredentialNotSaved),
        ];

        assert_eq!(expected.len(), every_surface_failure().len());

        for (failure, kind) in expected {
            assert_eq!(hop2_error(failure, HOST).kind, kind, "{failure:?}");
        }
    }

    #[test]
    fn hop2_messages_quote_the_host_and_nothing_else() {
        for failure in every_surface_failure() {
            let message = hop2_error(failure, HOST).message;

            for leak in ["state", "code", "127.0.0.1", "?", "authorize", "http"] {
                assert!(!message.contains(leak), "{failure:?}: {message}");
            }
        }

        assert!(hop2_error(SurfaceLoginFailure::TokenRejected, HOST)
            .message
            .contains(HOST));
    }

    fn cached_tokens() -> oauth::native::NativeTokenSet {
        oauth::native::NativeTokenSet {
            access_token: "at".into(),
            refresh_token: "rt".into(),
            expires_at: i64::MAX,
            provider: "self-hosted".into(),
            user_id: "u".into(),
        }
    }

    #[test]
    fn a_credential_that_was_not_saved_is_not_left_in_the_bearer_cache() {
        let base = "https://xm.allr.work";
        let transport = TransportState::new();

        transport.cache_bearer_tokens(base, cached_tokens());

        let error = settle_hop2_failure(&transport, base, SurfaceLoginFailure::NotSaved, HOST);

        assert_eq!(error.kind, AllrWorkErrorKind::CredentialNotSaved);
        assert_eq!(transport.cached_bearer_tokens(base), None);
    }

    #[test]
    fn no_other_hop2_failure_touches_the_bearer_cache() {
        let base = "https://xm.allr.work";

        for failure in every_surface_failure()
            .into_iter()
            .filter(|failure| *failure != SurfaceLoginFailure::NotSaved)
        {
            let transport = TransportState::new();
            transport.cache_bearer_tokens(base, cached_tokens());

            assert_eq!(
                settle_hop2_failure(&transport, base, failure, HOST),
                hop2_error(failure, HOST)
            );
            assert!(
                transport.cached_bearer_tokens(base).is_some(),
                "{failure:?}"
            );
        }
    }

    #[test]
    fn a_refused_navigation_is_never_logged_with_its_detail() {
        // Its `SurfaceLoginError::message` quotes the authorize URL, state included.
        assert!(!hop2_detail_is_loggable(
            SurfaceLoginFailure::NavigationRefused
        ));
        assert!(!hop2_detail_is_loggable(
            SurfaceLoginFailure::SurfaceUnavailable
        ));
        assert!(hop2_detail_is_loggable(
            SurfaceLoginFailure::TokenUnreachable
        ));
    }

    #[test]
    fn preflight_verdicts_map_to_error_kinds() {
        use decide::Preflight;

        assert_eq!(preflight_error(Preflight::Native, HOST), None);
        assert_eq!(
            preflight_error(Preflight::Unsupported, HOST).map(|e| e.kind),
            Some(AllrWorkErrorKind::WorkspaceUnsupported)
        );
        // An edge that sends `/auth/native/*` to sign-in cannot finish hop 2 either.
        assert_eq!(
            preflight_error(Preflight::EdgeNotDirect, HOST).map(|e| e.kind),
            Some(AllrWorkErrorKind::WorkspaceUnsupported)
        );
        assert_eq!(
            preflight_error(Preflight::Unreachable, HOST).map(|e| e.kind),
            Some(AllrWorkErrorKind::Unreachable)
        );
    }

    fn workspace_url() -> decide::Handoff {
        decide::Handoff {
            workspace: Url::parse("https://xm.allr.work").unwrap(),
            connector: Some("google".to_string()),
        }
    }

    #[test]
    fn hop_2_carries_the_connector_hop_1_handed_back() {
        // `sign_in_on_surface` is I/O end to end, so this pins its one call into the shared
        // login by source: the hand-back's connector is what hop 2's authorize URL carries
        // (`oauth::native::tests` show what that URL then says). Its twin in `oauth.rs`
        // pins the plain gateway sign-in to `None`.
        let source = include_str!("allr_work.rs");
        let body = &source[source
            .find("async fn sign_in_on_surface(")
            .expect("sign_in_on_surface exists")..];
        let body = &body[..body.find("\n}\n").expect("sign_in_on_surface ends")];
        let calls: Vec<&str> = body.split("native_login_on_surface(").skip(1).collect();

        assert_eq!(
            calls.len(),
            1,
            "one shared-login call in sign_in_on_surface"
        );
        let args: String = calls[0][..calls[0].find(".await").expect("the call is awaited")]
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect();
        assert_eq!(args, "surface,transport,&base,\"\",connector.as_deref())");
    }

    #[test]
    fn hop1_passes_the_hand_back_verdict_through() {
        assert_eq!(
            hop1_result(Ok(Ok(Ok(workspace_url())))),
            Ok(workspace_url())
        );

        // The parser's own named errors survive untouched.
        let no_workspace = AllrWorkError::new(AllrWorkErrorKind::NoWorkspace, "none");
        assert_eq!(
            hop1_result(Ok(Ok(Err(no_workspace.clone())))),
            Err(no_workspace)
        );
    }

    #[test]
    fn hop1_stops_map_to_error_kinds() {
        let kind = |verdict| hop1_result(verdict).unwrap_err().kind;

        assert_eq!(
            kind(Err(SurfaceStop::Cancelled)),
            AllrWorkErrorKind::Cancelled
        );
        assert_eq!(
            kind(Err(SurfaceStop::Refused)),
            AllrWorkErrorKind::NavigationRefused
        );
        // The surface reached a workspace host during hop 1: the portal predates the
        // hand-off. Not a timeout, not a cancel.
        assert_eq!(
            kind(Err(SurfaceStop::Watched)),
            AllrWorkErrorKind::PortalOutdated
        );
        assert_eq!(
            kind(Ok(Err(LoopbackFailure::TimedOut))),
            AllrWorkErrorKind::TimedOut
        );
        assert_eq!(
            kind(Ok(Err(LoopbackFailure::Listener("boom".into())))),
            AllrWorkErrorKind::Unreachable
        );
    }

    #[test]
    fn hop1_open_failures_map_to_error_kinds() {
        assert_eq!(
            hop1_open_error(SurfaceLoginFailure::AlreadyOnSignInPage).kind,
            AllrWorkErrorKind::AlreadyOnSignInPage
        );
        // A desktop window the user closed before hop 2 navigated it.
        assert_eq!(
            hop1_open_error(SurfaceLoginFailure::Cancelled).kind,
            AllrWorkErrorKind::Cancelled
        );
        assert_eq!(
            hop1_open_error(SurfaceLoginFailure::SurfaceUnavailable).kind,
            AllrWorkErrorKind::NavigationRefused
        );
    }

    fn hop2_failure() -> SignInFailure {
        SignInFailure {
            error: hop2_error(SurfaceLoginFailure::TokenRejected, HOST),
            workspace: Some("https://xm.allr.work".to_string()),
        }
    }

    #[test]
    fn a_mobile_sign_in_that_never_left_the_app_parks_nothing() {
        // A refused FIRST navigation: the caller's JS is alive and reads the `Err`. A parked
        // copy would be read again by the next resume.
        let refused: Result<String, SignInFailure> = Err(SignInFailure {
            error: hop1_result(Err(SurfaceStop::Refused)).unwrap_err(),
            workspace: None,
        });

        assert_eq!(mobile_outcome(&refused, false), None);
        assert_eq!(
            mobile_outcome(&Ok("https://xm.allr.work".into()), false),
            None
        );
    }

    #[test]
    fn a_mobile_sign_in_that_left_the_app_parks_its_outcome() {
        assert_eq!(
            mobile_outcome(&Ok("https://xm.allr.work".into()), true),
            Some(AllrWorkOutcome::SignedIn {
                workspace: "https://xm.allr.work".into()
            })
        );

        // A hop-2 failure keeps the workspace hop 1 found, so the card can name it.
        assert_eq!(
            mobile_outcome(&Err(hop2_failure()), true),
            Some(AllrWorkOutcome::Failed {
                error: hop2_failure().error,
                workspace: Some("https://xm.allr.work".into()),
            })
        );
    }

    #[test]
    fn the_command_reply_carries_the_workspace_or_the_error() {
        assert_eq!(
            command_reply(Ok("https://xm.allr.work".into())),
            Ok(AllrWorkSignIn {
                busy: false,
                workspace: Some("https://xm.allr.work".into()),
            })
        );
        assert_eq!(
            command_reply(Err(hop2_failure())),
            Err(hop2_failure().error)
        );
    }

    #[test]
    fn the_managed_mailbox_is_take_once() {
        let state = AllrWorkState::default();

        assert_eq!(state.take(), None);

        state.put(AllrWorkOutcome::SignedIn {
            workspace: "https://xm.allr.work".into(),
        });

        assert!(state.take().is_some());
        assert_eq!(state.take(), None);
    }
}
