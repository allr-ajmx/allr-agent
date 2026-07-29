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

use serde::{Deserialize, Serialize};

use super::error::{SshError, SshErrorKind};
use super::remote_paths::{LOCKFILE_SCHEMA_VERSION, PROTOCOL_VERSION};

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
    pub creation_time_ns: i64,
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
    if lock.creation_time_ns <= 0 {
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
            creation_time_ns: 133_000_000_000_000_000,
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
        let mut l = lock();
        l.creation_time_ns = 0;
        assert!(parse_windows_lock(&serde_json::to_value(&l).unwrap(), OWNER).is_none());
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
    fn interactive_command_guards_the_cwd() {
        let cmd = build_interactive_command("C:\\work");
        assert!(cmd.contains("Test-Path -LiteralPath 'C:\\work' -PathType Container"), "{cmd}");
        assert!(cmd.ends_with("powershell.exe -NoLogo"), "{cmd}");
    }
}
