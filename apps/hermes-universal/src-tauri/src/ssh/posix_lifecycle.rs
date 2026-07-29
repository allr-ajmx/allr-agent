//! POSIX (Linux/macOS) remote-backend lifecycle.
//!
//! Ported from `apps/desktop/electron/remote-lifecycle.ts`.
//!
//! The lockfile is the reuse contract. On reconnect we would rather reattach to
//! the backend already running on the remote than spawn a second one, so a
//! record survives across app restarts — which is why validating it defensively
//! takes up so much of this file.
//!
//! The ordering in `connect` is not arbitrary. The ownership record is written
//! with `port: 0` *immediately* after spawn, before readiness: if the attempt is
//! superseded in that window and its cleanup cannot reach the box, the next
//! connect still finds a record it can prove ownership through and reap. Without
//! it, a supersede at exactly the wrong moment leaves an orphaned backend that
//! nothing will ever clean up.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::error::{SshError, SshErrorKind};
use super::ownership::fingerprint_token;
use super::progress::{ProgressReporter, SshStep};
use super::remote_paths::{
    expand_remote_path, lockfile_path, ownership_directory, shq, spawn_log_path, validate_spawn_nonce,
    LOCKFILE_SCHEMA_VERSION, PROTOCOL_VERSION,
};
use super::remote_scripts;
use super::session::SshSession;

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

// --------------------------------------------------------------------------
// Live half — everything below talks to the remote over an open session.
// --------------------------------------------------------------------------

const READY_POLL_INTERVAL: Duration = Duration::from_millis(750);
pub const DEFAULT_READY_TIMEOUT: Duration = Duration::from_secs(45);

/// Where a `hermes` install might be when the login-shell probe misses. These
/// are the installer's own command locations (`scripts/install.sh`): per-user,
/// root/FHS, and the legacy venv.
const FALLBACK_HERMES_PATHS: [&str; 3] =
    ["~/.local/bin/hermes", "/usr/local/bin/hermes", "~/.hermes/hermes-agent/venv/bin/hermes"];

#[derive(Debug, Clone, Default)]
pub struct RemotePlatform {
    pub os: String,
    pub arch: String,
}

/// A backend we just started.
#[derive(Debug, Clone)]
pub struct SpawnedBackend {
    pub pid: i64,
    pub spawn_nonce: String,
    pub log_path: String,
    pub token_file_path: String,
}

fn transient(message: impl Into<String>) -> SshError {
    SshError::new(SshErrorKind::TransientTransportError, message)
}

/// `uname -s; uname -m`, gated to the platforms this lifecycle drives.
pub async fn probe_platform(session: &SshSession) -> Result<RemotePlatform, SshError> {
    let out = session.exec("uname -s; uname -m", None).await?.require_success("uname")?;

    let mut lines = out.lines().map(str::trim).filter(|l| !l.is_empty());
    let os = lines.next().unwrap_or_default().to_string();
    let arch = lines.next().unwrap_or_default().to_string();

    check_supported_os(&os)?;

    Ok(RemotePlatform { os, arch })
}

/// Is this path an executable file on the remote?
async fn is_executable(session: &SshSession, candidate: &str) -> bool {
    let Ok(path) = expand_remote_path(candidate) else {
        return false;
    };

    session
        .exec(&format!("[ -x {path} ] && echo OK || true"), None)
        .await
        .map(|out| out.stdout.trim() == "OK")
        .unwrap_or(false)
}

/// Locate the remote `hermes`.
///
/// An **explicit** path is honoured strictly: if it is not executable we fail
/// rather than fall back, because silently running a different install than the
/// one configured is worse than not connecting.
///
/// A **blank** path auto-detects, starting with a *login* shell — `ssh host cmd`
/// runs a non-login shell whose PATH misses per-user installs, which is exactly
/// where `hermes` usually lives.
pub async fn locate_hermes(session: &SshSession, explicit: Option<&str>) -> Result<String, SshError> {
    if let Some(explicit) = explicit.filter(|p| !p.trim().is_empty()) {
        if is_executable(session, explicit).await {
            return resolve_launcher(session, explicit).await;
        }

        return Err(SshError::new(
            SshErrorKind::HermesNotFound,
            format!(
                "The Hermes path you set is not an executable on the remote host: \"{explicit}\". \
                 Check the path (it must be the full path to the `hermes` binary on the remote, \
                 e.g. ~/hermes-agent/.venv/bin/hermes), or clear it to auto-detect."
            ),
        ));
    }

    let mut candidates: Vec<String> = Vec::new();

    if let Ok(found) = session.exec(&format!("bash -lc {}", shq("command -v hermes")), None).await {
        // A login shell may print a banner first, so take the last line.
        if let Some(path) = found.stdout.lines().map(str::trim).filter(|l| !l.is_empty()).next_back() {
            candidates.push(path.to_string());
        }
    }

    candidates.extend(FALLBACK_HERMES_PATHS.iter().map(|p| (*p).to_string()));

    for candidate in candidates {
        if is_executable(session, &candidate).await {
            return resolve_launcher(session, &candidate).await;
        }
    }

    Err(SshError::new(
        SshErrorKind::HermesNotFound,
        "Hermes is not installed on the remote host (no `hermes` executable found). Install it there with: \
         curl -fsSL https://hermes-agent.nousresearch.com/install.sh | sh — or set the Hermes path \
         explicitly in the SSH connection settings.",
    ))
}

/// Follow an `exec` shim to the real binary. Falls back to the candidate.
async fn resolve_launcher(session: &SshSession, candidate: &str) -> Result<String, SshError> {
    let out = session.exec(&remote_scripts::resolve_launcher(candidate), None).await;

    let resolved = out.map(|o| o.stdout.trim().to_string()).unwrap_or_default();

    Ok(if resolved.is_empty() { candidate.to_string() } else { resolved })
}

/// The remote `hermes --version`, best-effort. Surfaces *which* install a
/// connection actually uses, so a stale or unexpected one is visible.
pub async fn probe_hermes_version(session: &SshSession, hermes_path: &str) -> String {
    let Ok(path) = expand_remote_path(hermes_path) else {
        return String::new();
    };

    session
        .exec(&format!("{path} --version 2>&1"), None)
        .await
        .ok()
        .and_then(|o| o.stdout.lines().next().map(|l| l.trim().to_string()))
        .unwrap_or_default()
}

/// The `HERMES_HOME` the remote backend will use. Recorded in the lockfile so a
/// later reuse can confirm it is the same state store.
pub async fn probe_hermes_home(session: &SshSession) -> Result<String, SshError> {
    let out = session
        .exec("echo \"${HERMES_HOME:-$HOME/.hermes}\"", None)
        .await
        .map_err(|e| transient(format!("Could not resolve the remote Hermes home: {e}")))?;

    Ok(out.stdout.lines().map(str::trim).filter(|l| !l.is_empty()).next_back().unwrap_or("~/.hermes").to_string())
}

/// Whether the remote `hermes` understands the ownership contract.
pub async fn supports_ssh_ownership(session: &SshSession, hermes_path: &str) -> Result<bool, SshError> {
    let out = session.exec(&build_capability_probe(hermes_path)?, None).await?;

    Ok(capability_probe_passed(&out.stdout))
}

/// Read the ownership record, if any.
pub async fn read_lockfile(session: &SshSession, ownership_id: &str) -> Result<Option<BackendLock>, SshError> {
    let path = expand_remote_path(&lockfile_path(ownership_id)?)?;

    let out = session
        .exec(&format!("if [ ! -e {path} ]; then exit 0; fi; cat {path}"), None)
        .await
        .map_err(|e| transient(format!("Could not read the SSH backend ownership record: {e}")))?;

    Ok(parse_lock(&out.stdout, ownership_id))
}

/// Write the ownership record atomically.
///
/// `printf > tmp && mv -f` rather than a direct write: a reader that catches a
/// partially written file would parse it as garbage and conclude there is no
/// backend, then spawn a second one alongside the first.
pub async fn write_lockfile(
    session: &SshSession,
    ownership_id: &str,
    lock: &BackendLock,
    temp_suffix: &str,
) -> Result<(), SshError> {
    let directory = expand_remote_path(&ownership_directory(ownership_id)?)?;
    let final_path = expand_remote_path(&lockfile_path(ownership_id)?)?;

    let temp = expand_remote_path(&format!(
        "{}/.{}.lock.tmp",
        ownership_directory(ownership_id)?,
        validate_spawn_nonce(temp_suffix)?
    ))?;

    let json = serde_json::to_string(lock)
        .map_err(|e| SshError::new(SshErrorKind::Unknown, format!("Could not encode the lock record: {e}")))?;

    session
        .exec(
            &format!(
                "umask 077 && mkdir -p {directory} && printf '%s' {} > {temp} && mv -f {temp} {final_path}",
                shq(&json)
            ),
            None,
        )
        .await?
        .require_success("writing the ownership record")?;

    Ok(())
}

/// Drop the ownership record. Best-effort.
pub async fn remove_lockfile(session: &SshSession, ownership_id: &str) {
    if let Ok(path) = lockfile_path(ownership_id).and_then(|p| expand_remote_path(&p)) {
        let _ = session.exec(&format!("rm -f {path}"), None).await;
    }
}

/// Does this pid exist on the remote?
pub async fn remote_pid_alive(session: &SshSession, pid: i64) -> Result<bool, SshError> {
    if pid <= 0 {
        return Ok(false);
    }

    let out = session
        .exec(&format!("kill -0 {pid} 2>/dev/null && echo ALIVE || echo DEAD"), None)
        .await
        .map_err(|e| transient(format!("Could not verify the SSH backend process: {e}")))?;

    Ok(out.stdout.trim() == "ALIVE")
}

/// Is this pid *provably* our backend?
///
/// The gate on every kill. Anything short of a positive identification returns
/// false, because the cost of a false positive is destroying an unrelated
/// process on someone else's machine.
pub async fn pid_is_our_dashboard(
    session: &SshSession,
    pid: i64,
    spawn_nonce: &str,
    hermes_path: &str,
) -> Result<bool, SshError> {
    if pid <= 0 || hermes_path.is_empty() || validate_spawn_nonce(spawn_nonce).is_err() {
        return Ok(false);
    }

    let command = remote_scripts::pid_is_our_dashboard(pid, spawn_nonce, hermes_path)?;

    let out = session
        .exec(&command, None)
        .await
        .map_err(|e| transient(format!("Could not verify SSH backend process ownership: {e}")))?;

    Ok(out.stdout.trim() == "OWNED")
}

/// Terminate a stale backend, but **only** once it is provably ours, then drop
/// its lockfile and log.
pub async fn cleanup_stale(
    session: &SshSession,
    ownership_id: &str,
    lock: &BackendLock,
    pid_alive: bool,
) -> Result<(), SshError> {
    if pid_alive && pid_is_our_dashboard(session, lock.pid, &lock.spawn_nonce, &lock.hermes_path).await? {
        // Wait for it to actually go away (5s), rather than assuming the signal
        // took: respawning while the old process still holds its port would give
        // us a backend we cannot reach.
        session
            .exec(
                &format!(
                    "kill {pid} && i=0; while kill -0 {pid} 2>/dev/null; do \
                     i=$((i+1)); [ \"$i\" -ge 50 ] && exit 1; sleep 0.1; done",
                    pid = lock.pid
                ),
                None,
            )
            .await
            .map_err(|e| transient(format!("Could not terminate the stale SSH backend: {e}")))?;
    }

    // The log path is derived from the nonce, so this can only ever delete a
    // file we named ourselves.
    if let Ok(expected) = spawn_log_path(ownership_id, &lock.spawn_nonce) {
        if lock.log_path == expected {
            if let Ok(path) = expand_remote_path(&lock.log_path) {
                let _ = session.exec(&format!("rm -f {path}"), None).await;
            }
        }
    }

    remove_lockfile(session, ownership_id).await;

    Ok(())
}

/// Upload the session token and start a detached backend.
pub async fn spawn_remote_dashboard(
    session: &SshSession,
    hermes_path: &str,
    profile: Option<&str>,
    token: &str,
    ownership_id: &str,
    spawn_nonce: &str,
) -> Result<SpawnedBackend, SshError> {
    if !supports_ssh_ownership(session, hermes_path).await? {
        return Err(SshError::new(
            SshErrorKind::UpdateRequired,
            "The remote Hermes install does not support --ssh-session-token-file and --ssh-owner-nonce. \
             Update Hermes on the remote host to continue using SSH gateway mode.",
        ));
    }

    validate_spawn_nonce(spawn_nonce)?;

    let token_file_path = format!("{}/{spawn_nonce}.token", ownership_directory(ownership_id)?);
    let log_path = spawn_log_path(ownership_id, spawn_nonce)?;

    // The secret goes over stdin, never argv.
    if let Err(err) = session
        .exec(&remote_scripts::upload_token(&token_file_path), Some(token.as_bytes()))
        .await
        .and_then(|o| o.require_success("uploading the session token"))
    {
        remove_token_file(session, &token_file_path).await;

        return Err(err);
    }

    let spawn_command =
        build_spawn_command(hermes_path, profile, &log_path, Some(&token_file_path), Some(spawn_nonce))?;

    let out = match session.exec(&spawn_command, None).await.and_then(|o| o.require_success("starting the backend")) {
        Ok(out) => out,
        Err(err) => {
            remove_token_file(session, &token_file_path).await;

            return Err(err);
        }
    };

    let pid = out
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .next_back()
        .and_then(|l| l.parse::<i64>().ok())
        .filter(|pid| *pid > 0);

    let Some(pid) = pid else {
        remove_token_file(session, &token_file_path).await;

        return Err(SshError::new(
            SshErrorKind::Unknown,
            "Failed to launch the remote backend (it returned no process id).",
        ));
    };

    Ok(SpawnedBackend {
        pid,
        spawn_nonce: spawn_nonce.to_string(),
        log_path,
        token_file_path,
    })
}

/// Remove an uploaded token. Best-effort — a leftover is reaped by the upload
/// script's own hour-old sweep.
pub async fn remove_token_file(session: &SshSession, token_file_path: &str) {
    if let Ok(path) = expand_remote_path(token_file_path) {
        let _ = session.exec(&format!("rm -f {path}"), None).await;
    }
}

/// Poll the backend's log until it announces its port.
///
/// Gives up early if the process dies: a backend that crashed on startup will
/// never write the line, and waiting the full timeout for it would turn a fast
/// failure into a 45-second one.
pub async fn wait_for_ready_port(
    session: &SshSession,
    log_path: &str,
    pid: i64,
    timeout: Duration,
) -> Result<u16, SshError> {
    let remote_log = expand_remote_path(log_path)?;
    let deadline = tokio::time::Instant::now() + timeout;

    while tokio::time::Instant::now() < deadline {
        if !remote_pid_alive(session, pid).await? {
            return Err(SshError::new(
                SshErrorKind::Unknown,
                "The remote backend exited before announcing its port.",
            ));
        }

        let tail = session
            .exec(&format!("cat {remote_log} 2>/dev/null || true"), None)
            .await
            .map(|o| o.stdout)
            .unwrap_or_default();

        if let Some(port) = scrape_ready_port(&tail) {
            return Ok(port);
        }

        tokio::time::sleep(READY_POLL_INTERVAL).await;
    }

    Err(SshError::new(
        SshErrorKind::Timeout,
        format!(
            "Timed out after {}s waiting for the remote backend to announce its port.",
            timeout.as_secs()
        ),
    ))
}

/// Whether a lockfile describes a backend we can reattach to.
///
/// Every clause is a way the record can be true-but-useless, and each is a real
/// case rather than defensive padding: the process may be gone, the pid may have
/// been recycled onto something else, the record may predate readiness
/// (`port == 0`), our stored token may no longer be the one it was started with,
/// or the user may have repointed the connection at a different install or
/// state directory since.
#[allow(clippy::too_many_arguments)]
pub fn lock_is_reusable(
    lock: &BackendLock,
    pid_alive: bool,
    owned: bool,
    reuse_token: &str,
    hermes_path: &str,
    hermes_home: &str,
) -> bool {
    pid_alive
        && owned
        && lock.is_reusable()
        && !reuse_token.is_empty()
        && lock.token_fingerprint == fingerprint_token(reuse_token)
        && lock.hermes_path == hermes_path
        && lock.hermes_home == hermes_home
}

/// Everything `connect` needs to build a fresh ownership record.
pub struct SpawnContext<'a> {
    pub ownership_id: &'a str,
    pub spawn_nonce: &'a str,
    pub profile: &'a str,
    pub hermes_path: &'a str,
    pub hermes_home: &'a str,
    pub log_path: &'a str,
    pub token_fingerprint: String,
    pub pid: i64,
    pub port: u16,
    pub started_at: String,
}

impl SpawnContext<'_> {
    pub fn to_lock(&self) -> BackendLock {
        BackendLock {
            schema_version: LOCKFILE_SCHEMA_VERSION,
            protocol_version: PROTOCOL_VERSION,
            ownership_id: self.ownership_id.to_string(),
            spawn_nonce: self.spawn_nonce.to_string(),
            pid: self.pid,
            port: self.port,
            token_fingerprint: self.token_fingerprint.clone(),
            profile: self.profile.to_string(),
            hermes_path: self.hermes_path.to_string(),
            hermes_home: self.hermes_home.to_string(),
            log_path: self.log_path.to_string(),
            started_at: self.started_at.clone(),
        }
    }
}

/// Report the discovery steps. Kept together so `connect` reads as a sequence.
pub async fn survey_remote(
    session: &SshSession,
    explicit_hermes_path: Option<&str>,
    reporter: &ProgressReporter,
) -> Result<(RemotePlatform, String, String, String), SshError> {
    reporter.step(SshStep::ProbingPlatform);
    let platform = probe_platform(session).await?;

    reporter.step(SshStep::LocatingHermes);
    let hermes_path = locate_hermes(session, explicit_hermes_path).await?;
    reporter.step_with(SshStep::LocatingHermes, format!("found hermes at {hermes_path}"));

    let hermes_version = probe_hermes_version(session, &hermes_path).await;
    let hermes_home = probe_hermes_home(session).await?;

    Ok((platform, hermes_path, hermes_version, hermes_home))
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

    /// A lock whose fingerprint matches `TOKEN`, matching `hermes_path`/`home`.
    fn reusable_lock() -> BackendLock {
        BackendLock { token_fingerprint: fingerprint_token(TOKEN), ..lock() }
    }

    const TOKEN: &str = "hunter2";
    const HERMES: &str = "/usr/local/bin/hermes";
    const HOME: &str = "/home/u/.hermes";

    fn reusable(l: &BackendLock, pid_alive: bool, owned: bool, token: &str) -> bool {
        lock_is_reusable(l, pid_alive, owned, token, HERMES, HOME)
    }

    #[test]
    fn a_matching_live_owned_lock_is_reusable() {
        assert!(reusable(&reusable_lock(), true, true, TOKEN));
    }

    #[test]
    fn a_dead_or_unowned_process_is_not_reusable() {
        // Liveness and identity are separate questions and both must pass:
        // "alive" alone could be a recycled pid running something else.
        assert!(!reusable(&reusable_lock(), false, true, TOKEN));
        assert!(!reusable(&reusable_lock(), true, false, TOKEN));
    }

    #[test]
    fn a_spawn_in_progress_record_is_never_reusable() {
        // port 0 means the backend had not yet bound when the record was
        // written. It proves ownership for cleanup; there is nothing to attach to.
        let mut l = reusable_lock();
        l.port = 0;
        assert!(!reusable(&l, true, true, TOKEN));
    }

    #[test]
    fn a_token_we_no_longer_hold_blocks_reuse() {
        // Without the stored token we cannot authenticate to the backend, so
        // reattaching would produce a connection that fails on its first call.
        assert!(!reusable(&reusable_lock(), true, true, ""), "no token at all");
        assert!(!reusable(&reusable_lock(), true, true, "a-different-token"));
    }

    #[test]
    fn repointing_the_connection_blocks_reuse() {
        // The user changed the Hermes path or HERMES_HOME since that backend
        // started, so it is running the wrong install or against the wrong state
        // directory. Respawn rather than silently use the old one.
        let l = reusable_lock();
        assert!(!lock_is_reusable(&l, true, true, TOKEN, "/opt/other/hermes", HOME));
        assert!(!lock_is_reusable(&l, true, true, TOKEN, HERMES, "/home/u/.hermes-other"));
    }

    #[test]
    fn spawn_context_produces_a_lock_that_parses_back() {
        // The record we write must satisfy the validator we read it with,
        // otherwise every reuse would silently fail as "malformed".
        let context = SpawnContext {
            ownership_id: OWNER,
            spawn_nonce: NONCE,
            profile: "",
            hermes_path: HERMES,
            hermes_home: HOME,
            log_path: &log_path(),
            token_fingerprint: fingerprint_token(TOKEN),
            pid: 4242,
            port: 51001,
            started_at: "2026-07-29T00:00:00Z".to_string(),
        };

        let written = serde_json::to_string(&context.to_lock()).unwrap();
        let parsed = parse_lock(&written, OWNER).expect("a record we wrote must parse");

        assert_eq!(parsed.pid, 4242);
        assert!(parsed.is_reusable());
    }

    #[test]
    fn a_port_zero_spawn_context_still_parses() {
        // This is the record written immediately after spawn, before readiness.
        // If it did not parse, a supersede in that window would leave an orphan
        // that nothing could ever prove ownership of.
        let context = SpawnContext {
            ownership_id: OWNER,
            spawn_nonce: NONCE,
            profile: "work",
            hermes_path: HERMES,
            hermes_home: HOME,
            log_path: &log_path(),
            token_fingerprint: fingerprint_token(TOKEN),
            pid: 4242,
            port: 0,
            started_at: "2026-07-29T00:00:00Z".to_string(),
        };

        let parsed = parse_lock(&serde_json::to_string(&context.to_lock()).unwrap(), OWNER)
            .expect("the pre-readiness record must remain a valid ownership proof");

        assert!(!parsed.is_reusable());
        assert_eq!(parsed.profile, "work");
    }

    #[test]
    fn fallback_hermes_paths_are_all_valid_remote_paths() {
        // Each is interpolated into a remote command, so a relative one would be
        // rejected at use time rather than here.
        for path in FALLBACK_HERMES_PATHS {
            assert!(expand_remote_path(path).is_ok(), "{path}");
        }
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
