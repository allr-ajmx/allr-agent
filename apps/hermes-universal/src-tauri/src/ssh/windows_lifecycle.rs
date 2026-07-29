//! Windows **remote host** lifecycle — pure half.
//!
//! Ported from `apps/desktop/electron/windows-remote-lifecycle.ts`.
//!
//! To be clear about which machine this is: it is the lifecycle used when the
//! host we SSH *into* runs Windows. Whether the client is Windows is irrelevant
//! here — russh muxes identically on every platform, so the no-mux fallback the
//! Electron app needed does not exist for us.
//!
//! Every remote command is a base64-UTF16LE `powershell.exe -EncodedCommand`,
//! which sidesteps all quoting and escaping through the SSH command line. The
//! real work is delegated to `python -m hermes_cli.windows_ssh_runtime <op>`,
//! which speaks JSON on stdout/stdin and already ships in this repo.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::error::{is_transport_kind, redact_secrets, SshError, SshErrorKind};
use super::ownership::fingerprint_token;
use super::posix_lifecycle::{scrape_ready_port, RemotePlatform};
use super::progress::{ProgressReporter, SshStep};
use super::remote_paths::{LOCKFILE_SCHEMA_VERSION, PROTOCOL_VERSION};
use super::session::SshSession;

/// The remote Python + Hermes pair discovered by the `inspect` probe.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WindowsRuntime {
    pub os: String,
    #[serde(default)]
    pub arch: String,
    pub hermes_home: String,
    pub hermes_path: String,
    pub python: String,
}

/// The Windows lockfile. Same contract as the POSIX one plus `creationTimeNs`,
/// which is what makes ownership provable there: a pid alone can be reused by an
/// unrelated process, and killing on a bare pid match would be catastrophic.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WindowsLock {
    pub schema_version: u32,
    pub protocol_version: u32,
    pub ownership_id: String,
    pub spawn_nonce: String,
    pub pid: i64,
    /// A **string**, not a number, and deliberately so: the helper reports a
    /// Windows FILETIME in nanoseconds (~1.7e18), which exceeds JavaScript's
    /// MAX_SAFE_INTEGER. Round-tripping it as a number through any JSON layer
    /// would silently lose precision, and this value is half of the identity
    /// that decides whether a process may be killed.
    pub creation_time_ns: String,
    /// `0` = spawn-in-progress: an ownership proof, never reusable.
    pub port: u16,
    pub token_fingerprint: String,
    pub profile: String,
    pub hermes_path: String,
    pub hermes_home: String,
    pub started_at: String,
}

impl WindowsLock {
    pub fn is_reusable(&self) -> bool {
        self.port > 0
    }
}

/// What `process-state` reports back about a pid we believe is ours.
#[derive(Deserialize, Debug, Clone, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessState {
    #[serde(default)]
    pub alive: bool,
    #[serde(default)]
    pub owned: bool,
    /// The remote could not determine the truth (a permissions error, a
    /// transient WMI failure). See `spawn_definitely_failed`.
    #[serde(default)]
    pub indeterminate: bool,
}

/// Whether a spawn can be declared failed.
///
/// **Safety rule 1** from the desktop port (`windows-remote-lifecycle.ts:216`):
/// an `indeterminate` state must never count as failure. Treating "I could not
/// tell" as "it is dead" would destroy a live backend, so the answer must be a
/// definite no on both counts.
pub fn spawn_definitely_failed(state: &ProcessState) -> bool {
    !state.indeterminate && (!state.alive || !state.owned)
}

/// Quote a PowerShell single-quoted literal: `'` is doubled. Unlike POSIX there
/// is no backslash escape inside `'...'`, so doubling is the only mechanism.
pub fn ps_literal(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('\'');

    for ch in value.chars() {
        if ch == '\'' {
            out.push_str("''");
        } else {
            out.push(ch);
        }
    }

    out.push('\'');
    out
}

/// Encode a script the way `-EncodedCommand` expects: **UTF-16LE**, then base64.
/// Not UTF-8 — PowerShell will reject or mangle anything else.
pub fn encoded_powershell(script: &str) -> String {
    use base64::Engine as _;

    let utf16le: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();

    base64::engine::general_purpose::STANDARD.encode(utf16le)
}

/// Wrap a script into the full remote command line.
pub fn powershell_command(script: &str) -> String {
    format!(
        "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand {}",
        encoded_powershell(script)
    )
}

/// Build the `inspect` probe that locates `hermes.exe` and its sibling
/// `python.exe`. An explicit path is honoured strictly — it must be the one
/// found, never a fallback to a different install.
pub fn build_inspect_command(explicit_hermes_path: &str) -> String {
    let explicit = ps_literal(explicit_hermes_path);

    let script = [
        "$ErrorActionPreference=\"Stop\"".to_string(),
        format!("$explicit={explicit}"),
        "$hermesHome=$env:HERMES_HOME".to_string(),
        "if(-not $hermesHome){$hermesHome=Join-Path $env:LOCALAPPDATA \"hermes\"}".to_string(),
        "$candidates=@()".to_string(),
        "if($explicit){$candidates+=$explicit}".to_string(),
        "$cmd=Get-Command hermes.exe -ErrorAction SilentlyContinue".to_string(),
        "if($cmd){$candidates+=$cmd.Source}".to_string(),
        "$candidates+=(Join-Path $hermesHome \"hermes-agent\\venv\\Scripts\\hermes.exe\")".to_string(),
        "$candidates+=(Join-Path $HOME \"hermes-agent\\.venv\\Scripts\\hermes.exe\")".to_string(),
        "$hermes=$candidates|Where-Object{Test-Path -LiteralPath $_ -PathType Leaf}|Select-Object -First 1"
            .to_string(),
        "if(-not $hermes){throw \"Hermes is not installed on the remote Windows host.\"}".to_string(),
        "if($explicit -and $hermes -ne $explicit){throw \"The configured Hermes path is not an executable file.\"}"
            .to_string(),
        "$python=Join-Path (Split-Path $hermes) \"python.exe\"".to_string(),
        "if(-not (Test-Path -LiteralPath $python -PathType Leaf)){throw \"The remote Hermes Python runtime was not found.\"}"
            .to_string(),
        "[ordered]@{os=\"Windows\";arch=$env:PROCESSOR_ARCHITECTURE;hermesHome=$hermesHome;hermesPath=$hermes;python=$python}|ConvertTo-Json -Compress"
            .to_string(),
    ]
    .join(";");

    powershell_command(&script)
}

/// Build a `hermes_cli.windows_ssh_runtime` invocation.
pub fn build_helper_command(python: &str, operation: &str, args: &[String]) -> String {
    let mut argv = vec![python.to_string(), "-m".into(), "hermes_cli.windows_ssh_runtime".into(), operation.into()];
    argv.extend_from_slice(args);

    let quoted: Vec<String> = argv.iter().map(|a| ps_literal(a)).collect();

    let script = [
        "$ErrorActionPreference=\"Stop\"".to_string(),
        format!("& {}", quoted.join(" ")),
        "if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}".to_string(),
    ]
    .join(";");

    powershell_command(&script)
}

/// Pull the JSON payload out of a helper's stdout.
///
/// PowerShell may prepend a BOM and uses CRLF, and a login banner or a stray
/// warning can precede the payload — so the **last** non-empty line is the
/// answer. An `{"error": ...}` envelope becomes an `Err`.
pub fn parse_helper_output(output: &str) -> Result<serde_json::Value, SshError> {
    let cleaned = output.trim_start_matches('\u{feff}').replace("\r\n", "\n");

    let last = cleaned.lines().map(str::trim).filter(|l| !l.is_empty()).next_back().unwrap_or("null");

    let value: serde_json::Value = serde_json::from_str(last)
        .map_err(|e| SshError::new(SshErrorKind::Unknown, format!("The remote helper returned unreadable output: {e}")))?;

    if let Some(message) = value.get("error").and_then(|e| e.as_str()) {
        return Err(SshError::new(SshErrorKind::Unknown, message));
    }

    Ok(value)
}

/// Validate a Windows lockfile. Same defensive posture as the POSIX one, plus
/// `creationTimeNs`, without which ownership cannot be proven.
pub fn parse_windows_lock(value: &serde_json::Value, ownership_id: &str) -> Option<WindowsLock> {
    let lock: WindowsLock = serde_json::from_value(value.clone()).ok()?;

    if lock.schema_version != LOCKFILE_SCHEMA_VERSION || lock.protocol_version != PROTOCOL_VERSION {
        return None;
    }

    if lock.ownership_id != ownership_id || lock.pid <= 0 {
        return None;
    }

    // Without this the pid alone would be the identity, and pids are reused.
    // Desktop validates the same 10-20 digit shape (windows-remote-lifecycle.ts:141).
    let creation_ok = (10..=20).contains(&lock.creation_time_ns.len())
        && lock.creation_time_ns.bytes().all(|b| b.is_ascii_digit());

    if !creation_ok {
        return None;
    }

    if lock.spawn_nonce.len() != 16 || !lock.spawn_nonce.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }

    if lock.token_fingerprint.len() != 32 || !lock.token_fingerprint.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }

    Some(lock)
}

/// The interactive shell command for a terminal on a Windows backend.
pub fn build_interactive_command(cwd: &str) -> String {
    format!(
        "if(Test-Path -LiteralPath {cwd} -PathType Container){{Set-Location -LiteralPath {cwd}}};powershell.exe -NoLogo",
        cwd = ps_literal(cwd)
    )
}

// --------------------------------------------------------------------------
// Live half — everything below talks to the remote over an open session.
// --------------------------------------------------------------------------

const READY_POLL_INTERVAL: Duration = Duration::from_millis(750);
pub const DEFAULT_READY_TIMEOUT: Duration = Duration::from_secs(45);

/// What `inspect` reports about the remote install.
#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct WindowsInspection {
    #[serde(default)]
    pub supported: bool,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub version: String,
}

/// What `spawn` reports back.
#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct WindowsSpawned {
    pub pid: i64,
    /// Paired with the pid to form a reuse-proof identity. A pid alone is not
    /// enough — Windows recycles them just as readily as POSIX does.
    pub creation_time_ns: String,
}

fn transient(message: impl Into<String>) -> SshError {
    SshError::new(SshErrorKind::TransientTransportError, message)
}

/// Locate `hermes.exe` and its sibling `python.exe` on a Windows remote.
pub async fn probe_windows_remote(
    session: &SshSession,
    explicit_hermes_path: &str,
) -> Result<WindowsRuntime, SshError> {
    let out = session
        .exec(&build_inspect_command(explicit_hermes_path), None)
        .await?
        .require_success("probing the remote Windows host")?;

    serde_json::from_str::<WindowsRuntime>(out.trim()).map_err(|e| {
        SshError::new(SshErrorKind::UnsupportedPlatform, format!("Unreadable Windows probe result: {e}"))
    })
}

/// Decide which lifecycle a remote host needs.
///
/// `uname` failing is the **expected** Windows fall-through, so it must not be
/// fatal. But a *transport* failure — auth, host key, timeout, unreachable —
/// looks identical from here and is not a platform verdict at all, so it is
/// re-thrown as itself. Without that distinction, a wrong password on a Linux
/// box would be reported as "unsupported operating system", which sends the
/// user looking in entirely the wrong place.
pub async fn detect_remote_platform(
    session: &SshSession,
    explicit_hermes_path: &str,
) -> Result<(RemotePlatform, Option<WindowsRuntime>), SshError> {
    match session.exec("uname -s; uname -m", None).await {
        Ok(out) if out.succeeded() => {
            let mut lines = out.stdout.lines().map(str::trim).filter(|l| !l.is_empty());
            let os = lines.next().unwrap_or_default().to_string();

            if os == "Linux" || os == "Darwin" {
                let arch = lines.next().unwrap_or_default().to_string();

                return Ok((RemotePlatform { os, arch }, None));
            }
        }

        // A command that ran and failed is the normal "no uname here" answer.
        Ok(_) => {}

        Err(err) if is_transport_kind(err.kind) => return Err(err),
        Err(_) => {}
    }

    match probe_windows_remote(session, explicit_hermes_path).await {
        Ok(runtime) => {
            let platform = RemotePlatform { os: "Windows".to_string(), arch: runtime.arch.clone() };

            Ok((platform, Some(runtime)))
        }

        Err(err) if is_transport_kind(err.kind) => Err(err),

        Err(err) => {
            // The probe's message is remote-controlled output on its way to the
            // UI: redact it, strip control characters, and cap the length.
            let detail: String =
                redact_secrets(&err.message).chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
            let detail = detail.trim().chars().take(300).collect::<String>();

            Err(SshError::new(
                SshErrorKind::UnsupportedPlatform,
                format!(
                    "The remote operating system is not supported by SSH gateway mode.{}",
                    if detail.is_empty() { String::new() } else { format!(" (probe: {detail})") }
                ),
            ))
        }
    }
}

/// Run one `hermes_cli.windows_ssh_runtime` operation.
pub async fn helper(
    session: &SshSession,
    runtime: &WindowsRuntime,
    operation: &str,
    args: &[String],
    stdin: Option<&[u8]>,
) -> Result<serde_json::Value, SshError> {
    let command = build_helper_command(&runtime.python, operation, args);
    let out = session.exec(&command, stdin).await?;

    // The helper reports its own failures as a JSON `{error: ...}` envelope, so
    // parse before judging the exit status — the envelope is the better message.
    let parsed = parse_helper_output(&out.stdout);

    match parsed {
        Ok(value) => Ok(value),
        Err(err) if out.succeeded() => Err(err),
        // A non-zero exit with unparseable output: prefer stderr.
        Err(_) => Err(out.require_success(&format!("the remote `{operation}` helper")).map(|_| ()).unwrap_err()),
    }
}

/// Ask the helper whether a pid is alive and ours.
pub async fn process_state(
    session: &SshSession,
    runtime: &WindowsRuntime,
    lock: &WindowsLock,
) -> Result<ProcessState, SshError> {
    let args = [
        lock.pid.to_string(),
        lock.creation_time_ns.to_string(),
        lock.hermes_path.clone(),
        lock.spawn_nonce.clone(),
    ];

    let value = helper(session, runtime, "process-state", &args, None).await?;

    serde_json::from_value(value)
        .map_err(|e| transient(format!("Unreadable remote process state: {e}")))
}

/// Terminate a backend that is provably ours, then drop its artefacts.
///
/// **Safety rule 2**: the `terminate` call is deliberately *not* error-swallowed
/// the way the cleanup calls after it are. A thrown terminate must abort before
/// `remove-lock`, or a live backend is left running with no lock left to reclaim
/// it by — permanently orphaned, since the lock is the only thing tying that pid
/// to us.
pub async fn cleanup_owned(
    session: &SshSession,
    runtime: &WindowsRuntime,
    ownership_id: &str,
    lock: Option<&WindowsLock>,
) -> Result<(), SshError> {
    if let Some(lock) = lock {
        let state = process_state(session, runtime, lock).await?;

        if state.alive && state.owned {
            let args = [
                lock.pid.to_string(),
                lock.creation_time_ns.to_string(),
                lock.hermes_path.clone(),
                lock.spawn_nonce.clone(),
            ];

            // Not swallowed. See the doc comment.
            helper(session, runtime, "terminate", &args, None).await?;
        }

        if !lock.spawn_nonce.is_empty() {
            let args = [ownership_id.to_string(), lock.spawn_nonce.clone()];
            let _ = helper(session, runtime, "remove-token", &args, None).await;
            let _ = helper(session, runtime, "remove-log", &args, None).await;
        }
    }

    let _ = helper(session, runtime, "remove-lock", &[ownership_id.to_string()], None).await;

    Ok(())
}

/// Read the backend's log through the helper.
async fn read_log(
    session: &SshSession,
    runtime: &WindowsRuntime,
    ownership_id: &str,
    spawn_nonce: &str,
) -> String {
    let args = [ownership_id.to_string(), spawn_nonce.to_string()];

    helper(session, runtime, "read-log", &args, None)
        .await
        .ok()
        .and_then(|v| v.get("content").and_then(|c| c.as_str()).map(str::to_string))
        .unwrap_or_default()
}

/// Poll until the backend announces its port.
///
/// **Safety rule 1**: an `indeterminate` state never counts as failure. The
/// helper reports it when it genuinely could not tell — a permissions error, a
/// transient WMI hiccup — and reading "I don't know" as "it's dead" would tear
/// down a backend that is working fine.
pub async fn wait_ready(
    session: &SshSession,
    runtime: &WindowsRuntime,
    ownership_id: &str,
    lock: &WindowsLock,
    timeout: Duration,
) -> Result<u16, SshError> {
    let deadline = tokio::time::Instant::now() + timeout;

    while tokio::time::Instant::now() < deadline {
        // A failed probe is not a verdict either; try again.
        let Ok(state) = process_state(session, runtime, lock).await else {
            tokio::time::sleep(READY_POLL_INTERVAL).await;

            continue;
        };

        if spawn_definitely_failed(&state) {
            let detail = read_log(session, runtime, ownership_id, &lock.spawn_nonce).await;
            let tail: String = detail.chars().rev().take(2000).collect::<Vec<_>>().into_iter().rev().collect();

            return Err(SshError::new(
                SshErrorKind::Unknown,
                format!("The remote Windows backend exited before announcing its port. {tail}"),
            ));
        }

        let content = read_log(session, runtime, ownership_id, &lock.spawn_nonce).await;

        if let Some(port) = scrape_ready_port(&content) {
            return Ok(port);
        }

        tokio::time::sleep(READY_POLL_INTERVAL).await;
    }

    Err(SshError::new(
        SshErrorKind::Timeout,
        format!(
            "Timed out after {}s waiting for the remote Windows backend.",
            timeout.as_secs()
        ),
    ))
}

/// Confirm the remote install speaks the ownership contract, and pin its path.
pub async fn inspect_install(
    session: &SshSession,
    runtime: &mut WindowsRuntime,
) -> Result<String, SshError> {
    let value = helper(session, runtime, "inspect", &[runtime.hermes_path.clone()], None).await?;

    let inspection: WindowsInspection = serde_json::from_value(value)
        .map_err(|e| transient(format!("Unreadable remote inspection result: {e}")))?;

    if !inspection.supported {
        return Err(SshError::new(
            SshErrorKind::UpdateRequired,
            "Update Hermes on the remote Windows host before connecting over SSH.",
        ));
    }

    if !inspection.path.is_empty() {
        runtime.hermes_path = inspection.path;
    }

    Ok(inspection.version)
}

/// Read the ownership record, discarding anything that does not validate.
pub async fn read_lock(
    session: &SshSession,
    runtime: &WindowsRuntime,
    ownership_id: &str,
) -> Result<Option<WindowsLock>, SshError> {
    let value = helper(session, runtime, "read-lock", &[ownership_id.to_string()], None).await?;

    Ok(parse_windows_lock(&value, ownership_id))
}

/// Write the ownership record.
pub async fn write_lock(
    session: &SshSession,
    runtime: &WindowsRuntime,
    ownership_id: &str,
    lock: &WindowsLock,
) -> Result<(), SshError> {
    let json = serde_json::to_string(lock)
        .map_err(|e| SshError::new(SshErrorKind::Unknown, format!("Could not encode the lock record: {e}")))?;

    helper(session, runtime, "write-lock", &[ownership_id.to_string()], Some(json.as_bytes())).await?;

    Ok(())
}

/// Upload the session token, then start a detached backend.
pub async fn spawn_backend(
    session: &SshSession,
    runtime: &WindowsRuntime,
    ownership_id: &str,
    spawn_nonce: &str,
    profile: &str,
    token: &str,
    reporter: &ProgressReporter,
) -> Result<WindowsSpawned, SshError> {
    reporter.step(SshStep::UploadingToken);

    let token_args = [ownership_id.to_string(), spawn_nonce.to_string()];
    helper(session, runtime, "upload-token", &token_args, Some(token.as_bytes())).await?;

    reporter.step(SshStep::Spawning);

    let payload = serde_json::json!({
        "ownershipId": ownership_id,
        "spawnNonce": spawn_nonce,
        "profile": profile,
        "hermesPath": runtime.hermes_path,
    })
    .to_string();

    match helper(session, runtime, "spawn", &[], Some(payload.as_bytes())).await {
        Ok(value) => serde_json::from_value(value)
            .map_err(|e| transient(format!("Unreadable remote spawn result: {e}"))),

        Err(err) => {
            // A spawn that never started must not leave its credential behind.
            let _ = helper(session, runtime, "remove-token", &token_args, None).await;

            Err(err)
        }
    }
}

/// Whether a Windows lockfile describes a backend we can reattach to.
///
/// Same clauses as the POSIX gate, with `alive`/`owned` sourced from the helper
/// rather than from `kill -0` plus a cmdline check.
pub fn lock_is_reusable(
    lock: &WindowsLock,
    state: &ProcessState,
    reuse_token: &str,
    hermes_path: &str,
    hermes_home: &str,
) -> bool {
    state.alive
        && state.owned
        && lock.is_reusable()
        && !reuse_token.is_empty()
        && lock.token_fingerprint == fingerprint_token(reuse_token)
        && lock.hermes_path == hermes_path
        && lock.hermes_home == hermes_home
}

#[cfg(test)]
mod tests {
    use super::*;

    const OWNER: &str = "0123456789abcdef0123456789abcdef";

    fn lock() -> WindowsLock {
        WindowsLock {
            schema_version: LOCKFILE_SCHEMA_VERSION,
            protocol_version: PROTOCOL_VERSION,
            ownership_id: OWNER.to_string(),
            spawn_nonce: "0123456789abcdef".to_string(),
            pid: 4242,
            creation_time_ns: "133000000000000000".to_string(),
            port: 51001,
            token_fingerprint: "f52fbd32b2b3b86ff88ef6c490628285".to_string(),
            profile: String::new(),
            hermes_path: "C:\\hermes\\hermes.exe".to_string(),
            hermes_home: "C:\\Users\\u\\AppData\\Local\\hermes".to_string(),
            started_at: "2026-07-29T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn ps_literal_doubles_single_quotes() {
        // PowerShell has no backslash escape inside '...'; doubling is the only way.
        assert_eq!(ps_literal("plain"), "'plain'");
        assert_eq!(ps_literal("it's"), "'it''s'");
        assert_eq!(ps_literal("'"), "''''");
        assert_eq!(ps_literal(""), "''");
    }

    #[test]
    fn ps_literal_neutralizes_powershell_metacharacters() {
        for hostile in ["$(Get-Process)", "a; Remove-Item C:\\", "`n", "$env:PATH", "a|b"] {
            let quoted = ps_literal(hostile);
            assert_eq!(&quoted[1..quoted.len() - 1], hostile, "no quote to double in {hostile}");
        }
    }

    #[test]
    fn encodes_utf16le_base64() {
        // Pinned against what `powershell.exe -EncodedCommand` actually accepts:
        // UTF-16LE, not UTF-8. "hi" -> 68 00 69 00 -> aABpAA==
        assert_eq!(encoded_powershell("hi"), "aABpAA==");
        assert_eq!(encoded_powershell(""), "");
        // Single ASCII char: 'A' = 41 00 -> QQA=
        assert_eq!(encoded_powershell("A"), "QQA=");
    }

    #[test]
    fn encoding_round_trips_through_utf16le() {
        use base64::Engine as _;

        for script in ["$x=1", "echo 'it''s'", "Write-Output \"héllo\"", "日本語"] {
            let bytes = base64::engine::general_purpose::STANDARD.decode(encoded_powershell(script)).unwrap();
            assert_eq!(bytes.len() % 2, 0, "UTF-16 is 2 bytes per code unit");

            let units: Vec<u16> =
                bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
            assert_eq!(String::from_utf16(&units).unwrap(), script);
        }
    }

    #[test]
    fn powershell_command_carries_the_non_interactive_flags() {
        let cmd = powershell_command("$x=1");
        assert!(cmd.starts_with("powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand "));
        // Encoding is what keeps the script free of SSH-command-line quoting.
        assert!(!cmd.contains("$x=1"), "the script must be encoded, not inlined: {cmd}");
    }

    #[test]
    fn helper_command_targets_the_shipped_runtime_module() {
        let cmd = build_helper_command("C:\\py\\python.exe", "read-lock", &[OWNER.to_string()]);
        let decoded = decode(&cmd);
        assert!(decoded.contains("hermes_cli.windows_ssh_runtime"), "{decoded}");
        assert!(decoded.contains("'read-lock'"), "{decoded}");
        assert!(decoded.contains(&format!("'{OWNER}'")), "{decoded}");
        assert!(decoded.contains("if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}"), "{decoded}");
    }

    #[test]
    fn helper_command_quotes_a_hostile_python_path() {
        let decoded = decode(&build_helper_command("C:\\p'; Remove-Item C:\\ #", "inspect", &[]));
        assert!(decoded.contains("'C:\\p''; Remove-Item C:\\ #'"), "{decoded}");
    }

    fn decode(cmd: &str) -> String {
        use base64::Engine as _;

        let b64 = cmd.rsplit(' ').next().unwrap();
        let bytes = base64::engine::general_purpose::STANDARD.decode(b64).unwrap();
        let units: Vec<u16> = bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();

        String::from_utf16(&units).unwrap()
    }

    #[test]
    fn inspect_command_honours_an_explicit_path_strictly() {
        let decoded = decode(&build_inspect_command("C:\\custom\\hermes.exe"));
        assert!(decoded.contains("'C:\\custom\\hermes.exe'"), "{decoded}");
        // Never silently fall back to a different install than the one configured.
        assert!(decoded.contains("if($explicit -and $hermes -ne $explicit){throw"), "{decoded}");
        assert!(decoded.contains("python.exe"), "the sibling runtime is required: {decoded}");
    }

    #[test]
    fn helper_output_takes_the_last_line_through_bom_and_crlf() {
        // PowerShell prepends a BOM, uses CRLF, and a banner may precede the payload.
        assert_eq!(parse_helper_output("\u{feff}{\"ok\":true}\r\n").unwrap()["ok"], true);
        assert_eq!(parse_helper_output("WARNING: something\r\n{\"ok\":true}\r\n").unwrap()["ok"], true);
        assert_eq!(parse_helper_output("{\"ok\":true}\n\n\n").unwrap()["ok"], true);
    }

    #[test]
    fn helper_error_envelope_becomes_an_error() {
        let err = parse_helper_output("{\"error\":\"lock is not writable\"}").unwrap_err();
        assert_eq!(err.message, "lock is not writable");
    }

    #[test]
    fn helper_output_that_is_not_json_is_an_error() {
        assert!(parse_helper_output("Access is denied.").is_err());
        // No output at all parses as JSON null — a valid "nothing there" answer.
        assert!(parse_helper_output("").unwrap().is_null());
    }

    #[test]
    fn windows_lock_round_trips() {
        let l = lock();
        let value = serde_json::to_value(&l).unwrap();
        assert_eq!(parse_windows_lock(&value, OWNER).as_ref(), Some(&l));
    }

    #[test]
    fn windows_lock_requires_a_creation_time() {
        // Without it, identity collapses to the pid — and pids get reused, so a
        // cleanup could terminate an unrelated process.
        for bad in ["", "0", "123", "notdigits", "1330000000000000000000000"] {
            let mut l = lock();
            l.creation_time_ns = bad.to_string();
            assert!(
                parse_windows_lock(&serde_json::to_value(&l).unwrap(), OWNER).is_none(),
                "creationTimeNs {bad:?} must be rejected"
            );
        }
    }

    #[test]
    fn windows_lock_rejects_mismatches() {
        let mut l = lock();
        l.ownership_id = "fedcba9876543210fedcba9876543210".into();
        assert!(parse_windows_lock(&serde_json::to_value(&l).unwrap(), OWNER).is_none());

        let mut l = lock();
        l.schema_version = 1;
        assert!(parse_windows_lock(&serde_json::to_value(&l).unwrap(), OWNER).is_none());

        let mut l = lock();
        l.pid = 0;
        assert!(parse_windows_lock(&serde_json::to_value(&l).unwrap(), OWNER).is_none());

        assert!(parse_windows_lock(&serde_json::json!({}), OWNER).is_none());
    }

    #[test]
    fn windows_port_zero_is_a_proof_not_a_reuse() {
        let mut l = lock();
        l.port = 0;
        let parsed = parse_windows_lock(&serde_json::to_value(&l).unwrap(), OWNER).unwrap();
        assert!(!parsed.is_reusable());
    }

    #[test]
    fn indeterminate_process_state_never_counts_as_failure() {
        // Safety rule 1. Getting this wrong destroys live backends.
        let unknown = ProcessState { alive: false, owned: false, indeterminate: true };
        assert!(!spawn_definitely_failed(&unknown), "an unknown state must never be treated as dead");

        let dead = ProcessState { alive: false, owned: false, indeterminate: false };
        assert!(spawn_definitely_failed(&dead));

        let not_ours = ProcessState { alive: true, owned: false, indeterminate: false };
        assert!(spawn_definitely_failed(&not_ours));

        let healthy = ProcessState { alive: true, owned: true, indeterminate: false };
        assert!(!spawn_definitely_failed(&healthy));
    }

    #[test]
    fn missing_process_state_fields_default_to_the_safe_answer() {
        // An older helper that omits `indeterminate` must not be read as "known".
        let state: ProcessState = serde_json::from_value(serde_json::json!({"alive": true})).unwrap();
        assert!(state.alive && !state.owned && !state.indeterminate);
    }

    #[test]
    fn creation_time_stays_a_string_through_json() {
        // A Windows FILETIME in nanoseconds exceeds JavaScript's
        // MAX_SAFE_INTEGER (9007199254740991). Carrying it as a number anywhere
        // in the round trip would silently truncate the value that decides
        // whether a process may be killed.
        let mut l = lock();
        l.creation_time_ns = "1753747200123456789".to_string();

        let value = serde_json::to_value(&l).unwrap();
        assert!(value["creationTimeNs"].is_string(), "must serialize as a string: {value}");

        let parsed = parse_windows_lock(&value, OWNER).unwrap();
        assert_eq!(parsed.creation_time_ns, "1753747200123456789", "no precision may be lost");

        let as_number: i64 = parsed.creation_time_ns.parse().unwrap();
        assert!(as_number > 9_007_199_254_740_991, "the value really is beyond JS's safe range");
    }

    #[test]
    fn a_reusable_windows_lock_needs_every_clause() {
        const TOKEN: &str = "hunter2";
        let healthy = ProcessState { alive: true, owned: true, indeterminate: false };

        let mut l = lock();
        l.token_fingerprint = fingerprint_token(TOKEN);

        assert!(lock_is_reusable(&l, &healthy, TOKEN, &l.hermes_path.clone(), &l.hermes_home.clone()));

        // Dead, or alive-but-not-ours (a recycled pid).
        for state in [
            ProcessState { alive: false, owned: true, indeterminate: false },
            ProcessState { alive: true, owned: false, indeterminate: false },
        ] {
            assert!(!lock_is_reusable(&l, &state, TOKEN, &l.hermes_path.clone(), &l.hermes_home.clone()));
        }

        // Pre-readiness record: an ownership proof, never something to attach to.
        let mut pending = l.clone();
        pending.port = 0;
        assert!(!lock_is_reusable(&pending, &healthy, TOKEN, &l.hermes_path.clone(), &l.hermes_home.clone()));

        // A token we no longer hold means we could not authenticate anyway.
        assert!(!lock_is_reusable(&l, &healthy, "", &l.hermes_path.clone(), &l.hermes_home.clone()));
        assert!(!lock_is_reusable(&l, &healthy, "other", &l.hermes_path.clone(), &l.hermes_home.clone()));

        // Repointed at a different install or state directory since.
        assert!(!lock_is_reusable(&l, &healthy, TOKEN, "C:\\other\\hermes.exe", &l.hermes_home.clone()));
        assert!(!lock_is_reusable(&l, &healthy, TOKEN, &l.hermes_path.clone(), "C:\\other"));
    }

    #[test]
    fn an_indeterminate_state_is_not_reusable_either() {
        // It cannot satisfy alive && owned, so the gate closes — and the caller
        // treats indeterminate as "retry", never as "tear down".
        const TOKEN: &str = "hunter2";
        let mut l = lock();
        l.token_fingerprint = fingerprint_token(TOKEN);

        let unknown = ProcessState { alive: false, owned: false, indeterminate: true };
        assert!(!lock_is_reusable(&l, &unknown, TOKEN, &l.hermes_path.clone(), &l.hermes_home.clone()));
    }

    #[test]
    fn the_runtime_probe_result_deserializes() {
        let value = serde_json::json!({
            "os": "Windows",
            "arch": "AMD64",
            "hermesHome": "C:\\Users\\u\\AppData\\Local\\hermes",
            "hermesPath": "C:\\hermes\\hermes.exe",
            "python": "C:\\hermes\\python.exe"
        });

        let runtime: WindowsRuntime = serde_json::from_value(value).expect("the inspect payload must parse");
        assert_eq!(runtime.python, "C:\\hermes\\python.exe");
        assert_eq!(runtime.arch, "AMD64");
    }

    #[test]
    fn the_spawn_result_keeps_creation_time_as_a_string() {
        let spawned: WindowsSpawned =
            serde_json::from_value(serde_json::json!({"pid": 4242, "creationTimeNs": "133000000000000000"}))
                .expect("the spawn payload must parse");

        assert_eq!(spawned.pid, 4242);
        assert_eq!(spawned.creation_time_ns, "133000000000000000");
    }

    #[test]
    fn interactive_command_guards_the_cwd() {
        let cmd = build_interactive_command("C:\\work");
        assert!(cmd.contains("Test-Path -LiteralPath 'C:\\work' -PathType Container"), "{cmd}");
        assert!(cmd.ends_with("powershell.exe -NoLogo"), "{cmd}");
    }
}
