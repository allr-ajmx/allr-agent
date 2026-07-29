//! Typed SSH failure kinds + secret redaction.
//!
//! Ported from `apps/desktop/electron/ssh-connection.ts:279-348` (`SSH_ERROR`,
//! `classifySshError`, `redactSecrets`) and the `sshError` union in
//! `apps/desktop/src/global.d.ts:486`.
//!
//! The kind is what the UI branches on to pick its copy, so it is a closed enum
//! rather than a string: adding a variant must break the exhaustive match in the
//! frontend's copy map rather than silently falling through to "unknown".

use serde::Serialize;

/// Why an SSH operation failed. Serialized as the desktop's kebab-case strings so
/// the ported UI copy map keys line up 1:1.
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SshErrorKind {
    /// DNS/TCP never got there.
    Unreachable,
    /// The transport connected but no credential satisfied the server.
    AuthFailed,
    /// The host key does not match what we recorded. Fails closed, always.
    HostKeyChanged,
    /// Half-open TCP (classically after sleep/wake) or a wedged remote command.
    /// Treated as connection-dead so the caller fully reconnects rather than
    /// retrying in place.
    Timeout,
    /// Connected and authenticated, but no `hermes` install was found.
    HermesNotFound,
    /// The remote OS is not one we can drive.
    UnsupportedPlatform,
    /// A `hermes` too old to speak the SSH ownership contract
    /// (`--ssh-session-token-file` / `--ssh-owner-nonce`).
    UpdateRequired,
    /// A transport blip during the lifecycle. Distinct from `Unreachable`: the
    /// session was working, so the caller may retry rather than reconfigure.
    TransientTransportError,
    /// A lockfile claimed a live backend, but the authenticated ownership probe
    /// disagreed. The record is stale — clean up and respawn.
    AuthenticatedStale,
    /// A newer attempt for this scope superseded this one. Never surfaced to the
    /// user as a failure; the newer attempt owns the outcome.
    Superseded,
    /// The user declined to trust a new host key, or cancelled a prompt.
    Cancelled,
    Unknown,
}

/// A classified failure. `message` is already redacted.
#[derive(Serialize, Debug, Clone)]
pub struct SshError {
    pub kind: SshErrorKind,
    pub message: String,
}

impl SshError {
    pub fn new(kind: SshErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: redact_secrets(&message.into()) }
    }

    pub fn unknown(message: impl Into<String>) -> Self {
        Self::new(SshErrorKind::Unknown, message)
    }
}

impl std::fmt::Display for SshError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for SshError {}

/// Strip credentials that would otherwise reach a log or the UI. Ported from
/// `ssh-connection.ts:_REDACTIONS`. Deliberately conservative — over-redacting a
/// diagnostic beats leaking a session token into a bug report.
pub fn redact_secrets(text: &str) -> String {
    let mut out = String::with_capacity(text.len());

    // Hand-rolled rather than regex-based: this is the only regex-shaped need in
    // the whole module, and it is not worth a `regex` dependency in a crate that
    // ships to three mobile ABIs.
    for line in text.split_inclusive('\n') {
        out.push_str(&redact_line(line));
    }

    out
}

/// Every marker after which the following value is a secret. Matching is
/// case-insensitive, mirroring the desktop regexes' `i` flag.
///
/// Broader than desktop's, deliberately: desktop scoped `token=`/`ticket=` to
/// query parameters (`[?&]`-prefixed), which misses a bare `token=…` in an error
/// string. Over-redacting a diagnostic is the cheaper mistake.
const SECRET_MARKERS: &[&str] = &[
    "hermes_dashboard_session_token=",
    "x-hermes-session-token:",
    "x-hermes-session-token=",
    "authorization: bearer",
    "token=",
    "ticket=",
];

fn redact_line(line: &str) -> String {
    let lower = line.to_ascii_lowercase();
    let mut out = String::with_capacity(line.len());
    let mut cursor = 0usize;

    while cursor < line.len() {
        // Find the earliest marker at or after the cursor.
        let hit = SECRET_MARKERS
            .iter()
            .filter_map(|m| lower[cursor..].find(m).map(|at| (cursor + at, m.len())))
            .min_by_key(|(at, _)| *at);

        let Some((at, marker_len)) = hit else {
            out.push_str(&line[cursor..]);
            return out;
        };

        // A header marker is followed by whitespace before the value
        // ("Authorization: Bearer <tok>"). Copy that through, or the value would
        // look empty and nothing would be redacted.
        let mut value_start = at + marker_len;
        while line[value_start..].starts_with([' ', '\t']) {
            value_start += 1;
        }

        out.push_str(&line[cursor..value_start]);

        // The value runs until whitespace or a delimiter that cannot be part of it.
        let value_end = line[value_start..]
            .find(|c: char| c.is_whitespace() || matches!(c, '&' | '"' | '\'' | ';'))
            .map_or(line.len(), |rel| value_start + rel);

        if value_end > value_start {
            out.push_str("<redacted>");
        }

        cursor = value_end;
    }

    out
}

/// Classify remote stderr into a kind.
///
/// **Order matters** and is load-bearing, exactly as the desktop comment at
/// `ssh-connection.ts:286` says: the host-key-change banner also contains the
/// word "key", so it must be tested before the auth patterns or a MITM would be
/// reported as a mundane auth failure.
pub fn classify_stderr(stderr: &str) -> SshErrorKind {
    let text = stderr.to_ascii_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|n| text.contains(n));

    if has(&[
        "remote host identification has changed",
        "host key verification failed",
        "offending key",
        "offending ecdsa",
        "offending rsa",
        "offending ed25519",
    ]) {
        return SshErrorKind::HostKeyChanged;
    }

    if has(&[
        "permission denied",
        "too many authentication failures",
        "no matching host key",
        "publickey",
        "keyboard-interactive",
    ]) {
        return SshErrorKind::AuthFailed;
    }

    if has(&[
        "could not resolve hostname",
        "connection refused",
        "connection timed out",
        "no route to host",
        "network is unreachable",
        "operation timed out",
    ]) {
        return SshErrorKind::Unreachable;
    }

    SshErrorKind::Unknown
}

/// Kinds that mean "the transport itself failed". `detect_remote_platform` must
/// re-throw these as themselves rather than concluding `UnsupportedPlatform`,
/// because a `uname` that fails to *run* looks identical to a `uname` that is
/// absent. Ported from `windows-remote-lifecycle.ts:46-51` (`TRANSPORT_KINDS`).
pub fn is_transport_kind(kind: SshErrorKind) -> bool {
    matches!(
        kind,
        SshErrorKind::AuthFailed
            | SshErrorKind::HostKeyChanged
            | SshErrorKind::Timeout
            | SshErrorKind::Unreachable
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_key_change_wins_over_auth() {
        // The real OpenSSH banner contains both signals. Getting this backwards
        // would report a possible MITM as a routine auth failure.
        let banner = "@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\n\
             Offending ECDSA key in /home/u/.ssh/known_hosts:3\n\
             Permission denied (publickey).";
        assert_eq!(classify_stderr(banner), SshErrorKind::HostKeyChanged);
    }

    #[test]
    fn classifies_auth_and_unreachable() {
        assert_eq!(
            classify_stderr("user@host: Permission denied (publickey)."),
            SshErrorKind::AuthFailed
        );
        assert_eq!(
            classify_stderr("Received disconnect: Too many authentication failures"),
            SshErrorKind::AuthFailed
        );
        assert_eq!(classify_stderr("ssh: Could not resolve hostname nope"), SshErrorKind::Unreachable);
        assert_eq!(classify_stderr("connect to host x port 22: Connection refused"), SshErrorKind::Unreachable);
        assert_eq!(classify_stderr("No route to host"), SshErrorKind::Unreachable);
    }

    #[test]
    fn unmatched_stderr_is_unknown() {
        assert_eq!(classify_stderr(""), SshErrorKind::Unknown);
        assert_eq!(classify_stderr("bash: hermes: command not found"), SshErrorKind::Unknown);
    }

    #[test]
    fn classification_is_case_insensitive() {
        assert_eq!(classify_stderr("PERMISSION DENIED"), SshErrorKind::AuthFailed);
        assert_eq!(classify_stderr("connection REFUSED"), SshErrorKind::Unreachable);
    }

    #[test]
    fn redacts_every_marker() {
        assert_eq!(
            redact_secrets("env HERMES_DASHBOARD_SESSION_TOKEN=deadbeef hermes serve"),
            "env HERMES_DASHBOARD_SESSION_TOKEN=<redacted> hermes serve"
        );
        assert_eq!(
            redact_secrets("X-Hermes-Session-Token: abc123"),
            "X-Hermes-Session-Token: <redacted>"
        );
        assert_eq!(redact_secrets("Authorization: Bearer sk-xyz"), "Authorization: Bearer <redacted>");
        assert_eq!(
            redact_secrets("ws://127.0.0.1:5/api/ws?token=secret"),
            "ws://127.0.0.1:5/api/ws?token=<redacted>"
        );
        assert_eq!(
            redact_secrets("/api/ws?ticket=one&token=two"),
            "/api/ws?ticket=<redacted>&token=<redacted>"
        );
    }

    #[test]
    fn redaction_preserves_surrounding_text_and_newlines() {
        let input = "line one\nGET /api/ws?token=abc HTTP/1.1\nline three\n";
        let out = redact_secrets(input);
        assert_eq!(out, "line one\nGET /api/ws?token=<redacted> HTTP/1.1\nline three\n");
        assert_eq!(out.lines().count(), 3);
    }

    #[test]
    fn redaction_leaves_clean_text_untouched() {
        let clean = "Could not resolve hostname example.invalid";
        assert_eq!(redact_secrets(clean), clean);
    }

    #[test]
    fn ssh_error_redacts_on_construction() {
        let err = SshError::new(SshErrorKind::Unknown, "spawn failed: token=hunter2");
        assert!(!err.message.contains("hunter2"), "constructor must redact: {}", err.message);
    }

    #[test]
    fn transport_kinds_match_desktop() {
        for kind in [
            SshErrorKind::AuthFailed,
            SshErrorKind::HostKeyChanged,
            SshErrorKind::Timeout,
            SshErrorKind::Unreachable,
        ] {
            assert!(is_transport_kind(kind), "{kind:?} must be a transport kind");
        }
        // A genuinely absent `uname` must be allowed to fall through to the
        // Windows probe rather than aborting the connect.
        assert!(!is_transport_kind(SshErrorKind::UnsupportedPlatform));
        assert!(!is_transport_kind(SshErrorKind::HermesNotFound));
    }

    #[test]
    fn kinds_serialize_as_the_desktop_strings() {
        let json = serde_json::to_string(&SshErrorKind::HostKeyChanged).unwrap();
        assert_eq!(json, "\"host-key-changed\"");
        assert_eq!(serde_json::to_string(&SshErrorKind::AuthFailed).unwrap(), "\"auth-failed\"");
        assert_eq!(
            serde_json::to_string(&SshErrorKind::UpdateRequired).unwrap(),
            "\"update-required\""
        );
    }
}
