//! POSIX remote-backend lifecycle — pure half.
//!
//! Ported from `apps/desktop/electron/remote-lifecycle.ts`. This file holds only
//! the parts with no I/O: the remote command strings, the readiness scrape, and
//! lockfile validation. The parts that actually talk over the session land in a
//! later phase.
//!
//! The lockfile is the reuse contract. On reconnect we would rather reattach to
//! the backend already running on the remote than spawn a second one, so a
//! record survives across app restarts — which makes validating it defensively
//! the whole job here.

use serde::{Deserialize, Serialize};

use super::error::{SshError, SshErrorKind};
use super::remote_paths::{
    expand_remote_path, shq, spawn_log_path, validate_spawn_nonce, LOCKFILE_SCHEMA_VERSION, PROTOCOL_VERSION,
};

/// Remote operating systems this lifecycle drives. Anything else is routed to
/// the Windows lifecycle or refused.
pub const SUPPORTED_REMOTE_OS: [&str; 2] = ["Linux", "Darwin"];

/// Linux pids top out well below this; the bound exists to reject nonsense in a
/// file we did not write this run.
const MAX_PID: i64 = 4_194_304;

/// Cap on every free-text lockfile field, so a corrupt record cannot balloon.
const MAX_FIELD_LEN: usize = 1024;

/// The ownership record written next to a spawned backend on the remote.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackendLock {
    pub schema_version: u32,
    pub protocol_version: u32,
    pub ownership_id: String,
    pub spawn_nonce: String,
    pub pid: i64,
    /// `0` marks a spawn-in-progress record, written before readiness. It is a
    /// valid ownership proof for cleanup but is never reusable.
    pub port: u16,
    /// SHA256 of the token, truncated — never the token itself.
    pub token_fingerprint: String,
    pub profile: String,
    pub hermes_path: String,
    pub hermes_home: String,
    pub log_path: String,
    pub started_at: String,
}

impl BackendLock {
    /// Reusable means "there is a live backend here we can attach to". A
    /// port-0 record is deliberately excluded: it proves ownership (so cleanup
    /// may act on it) but there is nothing listening yet.
    pub fn is_reusable(&self) -> bool {
        self.port > 0
    }
}

/// Parse and validate a lockfile.
///
/// Returns `None` — not an error — for anything malformed, mismatched or from a
/// different schema. This is remote state that may predate the running build,
/// and "ignore it and spawn fresh" is always safe, whereas trusting a
/// half-understood record is not.
pub fn parse_lock(text: &str, ownership_id: &str) -> Option<BackendLock> {
    let text = text.trim();

    if text.is_empty() {
        return None;
    }

    let lock: BackendLock = serde_json::from_str(text).ok()?;

    if lock.schema_version != LOCKFILE_SCHEMA_VERSION || lock.protocol_version != PROTOCOL_VERSION {
        return None;
    }

    if lock.pid <= 0 || lock.pid > MAX_PID {
        return None;
    }

    if lock.ownership_id != ownership_id {
        return None;
    }

    validate_spawn_nonce(&lock.spawn_nonce).ok()?;

    let fingerprint_ok =
        lock.token_fingerprint.len() == 32 && lock.token_fingerprint.bytes().all(|b| b.is_ascii_hexdigit());

    if !fingerprint_ok {
        return None;
    }

    // The log path is derived, never free-form: a record pointing somewhere else
    // would let a cleanup delete an arbitrary file.
    if lock.log_path != spawn_log_path(ownership_id, &lock.spawn_nonce).ok()? {
        return None;
    }

    for field in [&lock.profile, &lock.hermes_path, &lock.hermes_home, &lock.log_path, &lock.started_at] {
        if field.len() > MAX_FIELD_LEN {
            return None;
        }
    }

    Some(lock)
}

/// Build the detached spawn command.
///
/// Detachment matters: the backend must outlive the SSH channel that started it,
/// or every reconnect would respawn. `setsid` starts a new session on Linux;
/// macOS has no `setsid`, so it falls back to `nohup` (HUP-immune — fd
/// detachment is already handled by `</dev/null` plus the redirect).
///
/// The backend binds `127.0.0.1` on the remote and takes `--port 0`, so it is
/// reachable only through our tunnel and never exposed to the remote's network.
pub fn build_spawn_command(
    hermes_path: &str,
    profile: Option<&str>,
    log_path: &str,
    token_file_path: Option<&str>,
    spawn_nonce: Option<&str>,
) -> Result<String, SshError> {
    let hermes = expand_remote_path(hermes_path)?;
    let log = expand_remote_path(log_path)?;

    let profile_args = match profile.filter(|p| !p.is_empty()) {
        Some(p) => format!("--profile {} ", shq(p)),
        None => String::new(),
    };

    let token_arg = match token_file_path {
        Some(p) => format!(" --ssh-session-token-file {}", expand_remote_path(p)?),
        None => String::new(),
    };

    let owner_arg = match spawn_nonce {
        Some(n) => format!(" --ssh-owner-nonce {}", validate_spawn_nonce(n)?),
        None => String::new(),
    };

    let sub_cmd = format!("serve --isolated --host 127.0.0.1 --port 0{token_arg}{owner_arg}");
    let dash_cmd = format!("env HERMES_DESKTOP=1 {hermes} {profile_args}{sub_cmd}");
    let inner = format!("{dash_cmd} </dev/null >> {log} 2>&1 & echo $!");

    Ok(format!(
        "mkdir -p \"$(dirname {log})\" && \"$(command -v setsid || echo nohup)\" sh -c {}",
        shq(&inner)
    ))
}

/// Probe whether the remote `hermes` understands the SSH ownership contract. An
/// older build would ignore the flags and hand back a backend we cannot prove
/// ownership of, so a `NO` here means `update-required`, not a silent downgrade.
pub fn build_capability_probe(hermes_path: &str) -> Result<String, SshError> {
    let hermes = expand_remote_path(hermes_path)?;

    Ok(format!(
        "help=\"$({hermes} serve --help 2>&1)\"; \
         printf '%s' \"$help\" | grep -q ssh-session-token-file && \
         printf '%s' \"$help\" | grep -q ssh-owner-nonce && echo YES || echo NO"
    ))
}

/// Interpret the capability probe's output. Only a trailing `YES` counts — a
/// login shell may print a banner first.
pub fn capability_probe_passed(output: &str) -> bool {
    output.trim_end().ends_with("YES")
}

/// Read the announced port out of a backend log.
///
/// Matches `HERMES_BACKEND_READY port=<n>` or `HERMES_DASHBOARD_READY port=<n>`
/// at the start of a line, and takes the **last** match: the log is appended to
/// across respawns, so an earlier line may describe a process that is gone.
pub fn scrape_ready_port(log_text: &str) -> Option<u16> {
    log_text.lines().filter_map(parse_ready_line).next_back()
}

fn parse_ready_line(line: &str) -> Option<u16> {
    let rest = line
        .strip_prefix("HERMES_BACKEND_READY port=")
        .or_else(|| line.strip_prefix("HERMES_DASHBOARD_READY port="))?;

    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();

    digits.parse::<u16>().ok().filter(|p| *p > 0)
}

/// Gate the remote OS. A transport failure must never reach here — see
/// `error::is_transport_kind`.
pub fn check_supported_os(uname_s: &str) -> Result<(), SshError> {
    let os = uname_s.trim();

    if SUPPORTED_REMOTE_OS.contains(&os) {
        return Ok(());
    }

    Err(SshError::new(
        SshErrorKind::UnsupportedPlatform,
        format!("The remote host reports an unsupported operating system: \"{os}\"."),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const OWNER: &str = "0123456789abcdef0123456789abcdef";
    const NONCE: &str = "0123456789abcdef";

    fn log_path() -> String {
        spawn_log_path(OWNER, NONCE).unwrap()
    }

    fn lock() -> BackendLock {
        BackendLock {
            schema_version: LOCKFILE_SCHEMA_VERSION,
            protocol_version: PROTOCOL_VERSION,
            ownership_id: OWNER.to_string(),
            spawn_nonce: NONCE.to_string(),
            pid: 4242,
            port: 51001,
            token_fingerprint: "f52fbd32b2b3b86ff88ef6c490628285".to_string(),
            profile: String::new(),
            hermes_path: "/usr/local/bin/hermes".to_string(),
            hermes_home: "/home/u/.hermes".to_string(),
            log_path: log_path(),
            started_at: "2026-07-29T00:00:00Z".to_string(),
        }
    }

    fn json(lock: &BackendLock) -> String {
        serde_json::to_string(lock).unwrap()
    }

    #[test]
    fn round_trips_a_valid_lock() {
        let original = lock();
        assert_eq!(parse_lock(&json(&original), OWNER).as_ref(), Some(&original));
    }

    #[test]
    fn rejects_a_schema_or_protocol_mismatch() {
        // A bumped version means an old backend is unsafe to reattach to.
        let mut l = lock();
        l.schema_version = 1;
        assert!(parse_lock(&json(&l), OWNER).is_none());

        let mut l = lock();
        l.protocol_version = 99;
        assert!(parse_lock(&json(&l), OWNER).is_none());
    }

    #[test]
    fn rejects_a_lock_belonging_to_another_install() {
        assert!(parse_lock(&json(&lock()), "fedcba9876543210fedcba9876543210").is_none());
    }

    #[test]
    fn rejects_out_of_range_pids() {
        for pid in [0, -1, MAX_PID + 1] {
            let mut l = lock();
            l.pid = pid;
            assert!(parse_lock(&json(&l), OWNER).is_none(), "pid {pid} must be rejected");
        }
    }

    #[test]
    fn port_zero_parses_but_is_not_reusable() {
        // The crux of the spawn-in-progress record: valid enough to prove
        // ownership for cleanup, never valid enough to connect to.
        let mut l = lock();
        l.port = 0;
        let parsed = parse_lock(&json(&l), OWNER).expect("a port-0 record is still a valid ownership proof");
        assert!(!parsed.is_reusable());
        assert!(lock().is_reusable());
    }

    #[test]
    fn rejects_a_malformed_nonce_or_fingerprint() {
        let mut l = lock();
        l.spawn_nonce = "nope".into();
        assert!(parse_lock(&json(&l), OWNER).is_none());

        let mut l = lock();
        l.token_fingerprint = "short".into();
        assert!(parse_lock(&json(&l), OWNER).is_none());
    }

    #[test]
    fn rejects_a_log_path_that_is_not_the_derived_one() {
        // Otherwise a doctored record could aim a cleanup at an arbitrary file.
        let mut l = lock();
        l.log_path = "~/.hermes/desktop-ssh/elsewhere.log".into();
        assert!(parse_lock(&json(&l), OWNER).is_none());

        let mut l = lock();
        l.log_path = "/etc/passwd".into();
        assert!(parse_lock(&json(&l), OWNER).is_none());
    }

    #[test]
    fn rejects_oversized_fields() {
        let mut l = lock();
        l.hermes_path = "x".repeat(MAX_FIELD_LEN + 1);
        assert!(parse_lock(&json(&l), OWNER).is_none());
    }

    #[test]
    fn rejects_garbage_and_empty_text() {
        assert!(parse_lock("", OWNER).is_none());
        assert!(parse_lock("   \n ", OWNER).is_none());
        assert!(parse_lock("not json", OWNER).is_none());
        assert!(parse_lock("{}", OWNER).is_none());
        assert!(parse_lock("null", OWNER).is_none());
    }

    #[test]
    fn tolerates_surrounding_whitespace() {
        assert!(parse_lock(&format!("\n  {}  \n", json(&lock())), OWNER).is_some());
    }

    #[test]
    fn spawn_command_matches_the_desktop_string() {
        // Byte-exact against `buildSpawnCommand` in remote-lifecycle.ts:446-460.
        // This is the command that starts a long-lived process on someone else's
        // machine, so it is pinned rather than merely smoke-tested.
        let out = build_spawn_command(
            "/usr/local/bin/hermes",
            None,
            "~/.hermes/desktop-ssh/o/n.log",
            Some("~/.hermes/desktop-ssh/o/n.token"),
            Some(NONCE),
        )
        .unwrap();

        assert_eq!(
            out,
            "mkdir -p \"$(dirname \"$HOME\"'/.hermes/desktop-ssh/o/n.log')\" && \
             \"$(command -v setsid || echo nohup)\" sh -c \
             'env HERMES_DESKTOP=1 '\\''/usr/local/bin/hermes'\\'' \
             serve --isolated --host 127.0.0.1 --port 0 \
             --ssh-session-token-file \"$HOME\"'\\''/.hermes/desktop-ssh/o/n.token'\\'' \
             --ssh-owner-nonce 0123456789abcdef </dev/null >> \"$HOME\"'\\''/.hermes/desktop-ssh/o/n.log'\\'' 2>&1 & echo $!'"
        );
    }

    #[test]
    fn spawn_command_binds_loopback_with_an_ephemeral_port() {
        // Non-negotiable: the remote backend must never be reachable from the
        // remote's own network — the tunnel is the only route in.
        let out =
            build_spawn_command("/usr/local/bin/hermes", None, "~/x.log", None, None).unwrap();
        assert!(out.contains("--host 127.0.0.1"), "{out}");
        assert!(out.contains("--port 0"), "{out}");
        assert!(!out.contains("0.0.0.0"), "{out}");
    }

    #[test]
    fn spawn_command_detaches_and_reports_the_pid() {
        let out = build_spawn_command("/usr/local/bin/hermes", None, "~/x.log", None, None).unwrap();
        assert!(out.contains("command -v setsid || echo nohup"), "macOS has no setsid: {out}");
        assert!(out.contains("</dev/null"), "{out}");
        assert!(out.ends_with("& echo $!'"), "the pid is how ownership is later proven: {out}");
    }

    #[test]
    fn spawn_command_places_the_profile_before_the_subcommand() {
        // The CLI takes --profile as a global flag, ahead of `serve`.
        let out = build_spawn_command("/usr/local/bin/hermes", Some("work"), "~/x.log", None, None).unwrap();
        let profile_at = out.find("--profile").expect("profile flag");
        let serve_at = out.find("serve --isolated").expect("subcommand");
        assert!(profile_at < serve_at, "{out}");
    }

    /// Reverse `shq`: unwrap one layer of POSIX single-quoting. Used to prove the
    /// nesting round-trips rather than eyeballing a doubly-escaped string.
    fn unshq(quoted: &str) -> String {
        let inner = quoted.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')).expect("one shell word");

        inner.replace("'\\''", "'")
    }

    #[test]
    fn spawn_command_quotes_a_hostile_profile() {
        // The profile reaches the remote through TWO layers of quoting: `shq` for
        // the --profile argument, then `shq` again for the whole `sh -c` string.
        // Peeling them proves the injection never becomes shell syntax.
        let hostile = "a'; rm -rf /; #";
        let out =
            build_spawn_command("/usr/local/bin/hermes", Some(hostile), "~/x.log", None, None).unwrap();

        let (_, sh_arg) = out.split_once("sh -c ").expect("sh -c argument");
        let inner = unshq(sh_arg);

        // One layer off: the profile is still a quoted argument, not syntax.
        assert!(inner.contains(&format!("--profile {}", shq(hostile))), "{inner}");
        // Two layers off: the original text, intact and inert.
        let (_, after) = inner.split_once("--profile ").expect("profile flag");
        let (profile_word, _) = after.split_once(" serve").expect("subcommand follows");
        assert_eq!(unshq(profile_word), hostile);
    }

    #[test]
    fn spawn_command_omits_optional_args_when_absent() {
        let out = build_spawn_command("/usr/local/bin/hermes", None, "~/x.log", None, None).unwrap();
        assert!(!out.contains("--ssh-session-token-file"), "{out}");
        assert!(!out.contains("--ssh-owner-nonce"), "{out}");
        assert!(!out.contains("--profile"), "{out}");
    }

    #[test]
    fn spawn_command_rejects_a_relative_hermes_path() {
        assert!(build_spawn_command("hermes", None, "~/x.log", None, None).is_err());
        assert!(build_spawn_command("/usr/local/bin/hermes", None, "x.log", None, None).is_err());
        assert!(build_spawn_command("/usr/local/bin/hermes", None, "~/x.log", None, Some("bad")).is_err());
    }

    #[test]
    fn capability_probe_looks_for_both_flags() {
        let probe = build_capability_probe("/usr/local/bin/hermes").unwrap();
        assert!(probe.contains("ssh-session-token-file"), "{probe}");
        assert!(probe.contains("ssh-owner-nonce"), "{probe}");
    }

    #[test]
    fn capability_probe_output_needs_a_trailing_yes() {
        assert!(capability_probe_passed("YES"));
        assert!(capability_probe_passed("YES\n"));
        // A login shell may print a banner before the answer.
        assert!(capability_probe_passed("Welcome to the box!\nYES\n"));
        assert!(!capability_probe_passed("NO\n"));
        assert!(!capability_probe_passed(""));
        assert!(!capability_probe_passed("YES but actually no"));
    }

    #[test]
    fn scrapes_both_ready_line_spellings() {
        assert_eq!(scrape_ready_port("HERMES_BACKEND_READY port=51001"), Some(51001));
        assert_eq!(scrape_ready_port("HERMES_DASHBOARD_READY port=8788"), Some(8788));
    }

    #[test]
    fn scrape_takes_the_last_match() {
        // Logs are appended across respawns; an earlier line describes a dead
        // process, and connecting to its port would be a silent misattachment.
        let log = "HERMES_BACKEND_READY port=1111\nsome noise\nHERMES_BACKEND_READY port=2222\n";
        assert_eq!(scrape_ready_port(log), Some(2222));
    }

    #[test]
    fn scrape_requires_the_marker_at_the_line_start() {
        assert_eq!(scrape_ready_port("INFO: HERMES_BACKEND_READY port=51001"), None);
        assert_eq!(scrape_ready_port("uvicorn running on 8788"), None);
        assert_eq!(scrape_ready_port(""), None);
    }

    #[test]
    fn scrape_rejects_unparseable_and_zero_ports() {
        assert_eq!(scrape_ready_port("HERMES_BACKEND_READY port=notaport"), None);
        assert_eq!(scrape_ready_port("HERMES_BACKEND_READY port="), None);
        assert_eq!(scrape_ready_port("HERMES_BACKEND_READY port=0"), None);
        assert_eq!(scrape_ready_port("HERMES_BACKEND_READY port=99999"), None, "out of u16 range");
    }

    #[test]
    fn scrape_ignores_trailing_text_after_the_port() {
        assert_eq!(scrape_ready_port("HERMES_BACKEND_READY port=51001 pid=42"), Some(51001));
    }

    #[test]
    fn os_gate_accepts_only_linux_and_darwin() {
        assert!(check_supported_os("Linux").is_ok());
        assert!(check_supported_os("Darwin\n").is_ok());

        for bad in ["FreeBSD", "MINGW64_NT-10.0", "", "linux"] {
            let err = check_supported_os(bad).expect_err("{bad} must be rejected");
            assert_eq!(err.kind, SshErrorKind::UnsupportedPlatform);
        }
    }
}
