//! Parsing and validation of the user-supplied SSH target.
//!
//! Ported from `apps/desktop/electron/connection-config.ts:206-270`
//! (`normalizeSshConfig`) and `ssh-connection.ts:47-87` (`validateSshTarget`,
//! `validateKeyPath`).
//!
//! The host field is deliberately forgiving — people paste `user@box:2222` and
//! `[fd00::1]:2222` out of habit — so it absorbs the user and port when they are
//! embedded, while explicit fields still win.

use serde::{Deserialize, Serialize};

use super::error::{SshError, SshErrorKind};

pub const DEFAULT_SSH_PORT: u16 = 22;

/// What the settings form collects, before normalization.
#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct SshTargetInput {
    pub host: String,
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub key_path: Option<String>,
    #[serde(default)]
    pub remote_hermes_path: Option<String>,
}

/// A validated target. `port`/`user` stay `None` when unset so that
/// `~/.ssh/config` keeps the final say — writing a default 22 here would
/// silently override a `Port` directive the user set for that Host.
#[derive(Serialize, Debug, Clone, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SshTarget {
    pub host: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_path: Option<String>,
    /// Blank means auto-detect on the remote.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_hermes_path: Option<String>,
}

impl SshTarget {
    /// `user@host` when a user is known, else the bare host. This is the label
    /// the statusbar pill shows — the tunnelled `http://127.0.0.1:<port>` base
    /// URL would be meaningless there.
    pub fn label(&self) -> String {
        match &self.user {
            Some(u) => format!("{u}@{}", self.host),
            None => self.host.clone(),
        }
    }

    /// The port to actually dial once config resolution has had its say.
    pub fn effective_port(&self) -> u16 {
        self.port.unwrap_or(DEFAULT_SSH_PORT)
    }
}

fn err(message: &str) -> SshError {
    SshError::new(SshErrorKind::Unknown, message)
}

/// Reject anything that could smuggle a newline into a remote shell string.
///
/// Note: desktop additionally rejected a leading `-` on every field, because it
/// built an `argv` for `spawn('ssh', ...)` and a value like `-oProxyCommand=...`
/// would have become an option. russh takes a host and a port as typed values,
/// so there is no argv to poison and that rule is vestigial here. The
/// control-character rule is NOT vestigial: these values still reach remote
/// shell commands via `shq`.
fn reject_control_chars(field: &str, value: &str) -> Result<(), SshError> {
    if value.chars().any(|c| c.is_control()) {
        return Err(err(&format!("Unsafe SSH target: {field} contains control characters.")));
    }

    Ok(())
}

/// Normalize + validate. Returns `None` for a blank host, matching desktop's
/// "no usable SSH config" signal rather than treating it as an error.
pub fn normalize_ssh_target(input: &SshTargetInput) -> Result<Option<SshTarget>, SshError> {
    let mut host = input.host.trim().to_string();

    if host.is_empty() {
        return Ok(None);
    }

    let mut parsed_user: Option<String> = None;
    let mut parsed_port: Option<u16> = None;

    // `user@host`. `at > 0` (not `>= 0`) so a leading '@' is not read as an
    // empty user — it falls through and fails host validation instead.
    if let Some(at) = host.find('@').filter(|at| *at > 0) {
        parsed_user = Some(host[..at].to_string());
        host = host[at + 1..].to_string();
    }

    if let Some((inner, port)) = split_bracketed(&host) {
        // `[v6::addr]` or `[v6::addr]:port`
        host = inner;
        parsed_port = port;
    } else if host.matches(':').count() == 1 {
        // Exactly one colon: `host:port`. More than one means a bare IPv6
        // literal, which has no port to split off.
        let (name, raw_port) = host.split_once(':').expect("one colon is present");

        if !raw_port.is_empty() && raw_port.bytes().all(|b| b.is_ascii_digit()) {
            if let Ok(p) = raw_port.parse::<u16>() {
                host = name.to_string();
                parsed_port = Some(p);
            }
        }
    }

    if host.is_empty() {
        return Ok(None);
    }

    reject_control_chars("host", &host)?;

    let user = input
        .user
        .as_deref()
        .map(str::trim)
        .filter(|u| !u.is_empty())
        .map(str::to_string)
        .or(parsed_user)
        .filter(|u| !u.is_empty());

    if let Some(u) = &user {
        reject_control_chars("user", u)?;
    }

    // An explicit port field beats one embedded in the host string.
    let port = input.port.or(parsed_port).filter(|p| {
        // Port 22 is dropped deliberately, not as an optimization: leaving it
        // unset lets a `Port` directive in ~/.ssh/config apply. Desktop does the
        // same so `hostArgs` never emits `-p 22`.
        *p > 0 && *p != DEFAULT_SSH_PORT
    });

    let key_path = input.key_path.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);

    if let Some(k) = &key_path {
        reject_control_chars("key path", k)?;
    }

    let remote_hermes_path = input
        .remote_hermes_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    if let Some(p) = &remote_hermes_path {
        reject_control_chars("remote hermes path", p)?;
    }

    Ok(Some(SshTarget { host, user, port, key_path, remote_hermes_path }))
}

/// Split `[inner]` / `[inner]:port`. Returns `None` when the string is not
/// bracketed at all.
fn split_bracketed(value: &str) -> Option<(String, Option<u16>)> {
    let rest = value.strip_prefix('[')?;
    let close = rest.find(']')?;
    let inner = &rest[..close];
    let after = &rest[close + 1..];

    if inner.is_empty() {
        return None;
    }

    if after.is_empty() {
        return Some((inner.to_string(), None));
    }

    let raw_port = after.strip_prefix(':')?;

    if raw_port.is_empty() || !raw_port.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }

    Some((inner.to_string(), raw_port.parse::<u16>().ok()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(host: &str) -> SshTargetInput {
        SshTargetInput { host: host.to_string(), ..Default::default() }
    }

    fn normalize(host: &str) -> SshTarget {
        normalize_ssh_target(&input(host)).expect("valid").expect("some")
    }

    #[test]
    fn blank_host_is_none_not_an_error() {
        assert!(normalize_ssh_target(&input("")).unwrap().is_none());
        assert!(normalize_ssh_target(&input("   ")).unwrap().is_none());
    }

    #[test]
    fn splits_user_from_host() {
        let t = normalize("deploy@box.example");
        assert_eq!(t.host, "box.example");
        assert_eq!(t.user.as_deref(), Some("deploy"));
    }

    #[test]
    fn splits_port_from_host() {
        let t = normalize("box.example:2222");
        assert_eq!(t.host, "box.example");
        assert_eq!(t.port, Some(2222));
    }

    #[test]
    fn splits_both_user_and_port() {
        let t = normalize("deploy@box.example:2222");
        assert_eq!(t.host, "box.example");
        assert_eq!(t.user.as_deref(), Some("deploy"));
        assert_eq!(t.port, Some(2222));
    }

    #[test]
    fn port_22_is_dropped_so_ssh_config_can_win() {
        // The whole point: an unset port lets a `Port` directive in
        // ~/.ssh/config apply. Storing 22 would silently override it.
        assert_eq!(normalize("box.example:22").port, None);
        let explicit = SshTargetInput { host: "box.example".into(), port: Some(22), ..Default::default() };
        assert_eq!(normalize_ssh_target(&explicit).unwrap().unwrap().port, None);
        assert_eq!(normalize("box.example:22").effective_port(), 22);
    }

    #[test]
    fn handles_bracketed_ipv6() {
        let plain = normalize("[fd00::1]");
        assert_eq!(plain.host, "fd00::1");
        assert_eq!(plain.port, None);

        let ported = normalize("[fd00::1]:2222");
        assert_eq!(ported.host, "fd00::1");
        assert_eq!(ported.port, Some(2222));

        let with_user = normalize("deploy@[fd00::1]:2222");
        assert_eq!(with_user.host, "fd00::1");
        assert_eq!(with_user.user.as_deref(), Some("deploy"));
        assert_eq!(with_user.port, Some(2222));
    }

    #[test]
    fn bare_ipv6_is_not_split_on_its_colons() {
        // More than one colon means an unbracketed IPv6 literal — there is no
        // port to peel off, and splitting would silently corrupt the address.
        let t = normalize("fd00::1");
        assert_eq!(t.host, "fd00::1");
        assert_eq!(t.port, None);
    }

    #[test]
    fn non_numeric_port_stays_part_of_the_host() {
        let t = normalize("box.example:notaport");
        assert_eq!(t.host, "box.example:notaport");
        assert_eq!(t.port, None);
    }

    #[test]
    fn explicit_fields_beat_embedded_ones() {
        let i = SshTargetInput {
            host: "embedded@box.example:2222".into(),
            user: Some("explicit".into()),
            port: Some(4242),
            ..Default::default()
        };
        let t = normalize_ssh_target(&i).unwrap().unwrap();
        assert_eq!(t.user.as_deref(), Some("explicit"));
        assert_eq!(t.port, Some(4242));
    }

    #[test]
    fn blank_optional_fields_become_none() {
        let i = SshTargetInput {
            host: "box".into(),
            user: Some("  ".into()),
            key_path: Some("".into()),
            remote_hermes_path: Some("   ".into()),
            ..Default::default()
        };
        let t = normalize_ssh_target(&i).unwrap().unwrap();
        assert_eq!(t.user, None);
        assert_eq!(t.key_path, None);
        // Blank means auto-detect the remote install, not "look for a file named ''".
        assert_eq!(t.remote_hermes_path, None);
    }

    #[test]
    fn rejects_control_characters_in_every_field() {
        assert!(normalize_ssh_target(&input("box\nexample")).is_err());
        assert!(normalize_ssh_target(&input("box\u{0}example")).is_err());

        let bad_user = SshTargetInput { host: "box".into(), user: Some("a\nb".into()), ..Default::default() };
        assert!(normalize_ssh_target(&bad_user).is_err());

        let bad_key = SshTargetInput { host: "box".into(), key_path: Some("/k\ny".into()), ..Default::default() };
        assert!(normalize_ssh_target(&bad_key).is_err());

        let bad_path =
            SshTargetInput { host: "box".into(), remote_hermes_path: Some("/h\rx".into()), ..Default::default() };
        assert!(normalize_ssh_target(&bad_path).is_err());
    }

    #[test]
    fn a_leading_dash_is_allowed_because_there_is_no_argv() {
        // Desktop rejected this because it built `spawn('ssh', argv)`. russh takes
        // a typed host + port, so there is no option to smuggle. Kept as a test so
        // the rationale is not re-litigated by a future reader.
        let t = normalize_ssh_target(&input("-box.example")).unwrap().unwrap();
        assert_eq!(t.host, "-box.example");
    }

    #[test]
    fn label_prefers_user_at_host() {
        assert_eq!(normalize("deploy@box").label(), "deploy@box");
        assert_eq!(normalize("box").label(), "box");
    }
}
