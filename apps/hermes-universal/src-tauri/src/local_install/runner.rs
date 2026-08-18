//! Driving `scripts/install.{sh,ps1}` stage by stage.
//!
//! The scripts already speak a versioned protocol, and this module is a client of
//! it rather than a new installer:
//!
//!   --manifest                              -> {"protocol_version":1,"stages":[…]}
//!   --stage <name> --non-interactive --json -> {"ok":…,"stage":…,"skipped":…}
//!
//! `install.sh:3227` names "the Rust/Electron parser" as the intended consumer,
//! and runs each stage body in a subshell so a helper's `exit 1` still emits a
//! result frame. Electron's `bootstrap-runner.ts` and the bootstrap-installer's
//! `bootstrap.rs` are the two existing clients; this is the third, and it is
//! deliberately shaped like them.
//!
//! ONE DEVIATION, and it is the interesting part. We skip the script's
//! `repository` stage and clone the chosen repo ourselves, because
//! `REPO_URL_HTTPS` is hardcoded to upstream in both scripts
//! (`install.sh:46-47`, `install.ps1:376-377`) with no override flag, and we were
//! asked not to modify them. What that costs is real and worth naming: the
//! script's `repository` stage also carries an SSH -> HTTPS -> ZIP fallback chain,
//! a move-aside for a broken checkout, and a commit-pin rollback guard. Our clone
//! is a plain shallow HTTPS clone, and it REFUSES rather than touching a
//! non-empty destination — reimplementing move-aside silently would be worse than
//! not having it.

use super::events::{Manifest, StageResultPayload};

/// Stages we drive ourselves instead of delegating.
pub const REPOSITORY_STAGE: &str = "repository";

/// Scan stdout from the END for the last line that parses as the stage-result
/// frame. The scripts print banners, progress and warnings first; only the final
/// JSON object is the contract. Mirrors `parseStageResult`.
pub fn parse_stage_result(stdout: &str) -> Option<StageResultPayload> {
    for line in stdout.lines().rev() {
        let trimmed = line.trim();

        if trimmed.is_empty() {
            continue;
        }

        if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
            let shaped = value
                .get("ok")
                .and_then(serde_json::Value::as_bool)
                .is_some()
                && value
                    .get("stage")
                    .and_then(serde_json::Value::as_str)
                    .is_some();

            if shaped {
                if let Ok(parsed) = serde_json::from_value::<StageResultPayload>(value) {
                    return Some(parsed);
                }
            }
        }
    }

    None
}

/// Same, for `--manifest`: the last line carrying a `stages` array.
pub fn parse_manifest(stdout: &str) -> Option<Manifest> {
    for line in stdout.lines().rev() {
        let trimmed = line.trim();

        if trimmed.is_empty() {
            continue;
        }

        if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
            if value
                .get("stages")
                .and_then(serde_json::Value::as_array)
                .is_some()
            {
                if let Ok(parsed) = serde_json::from_value::<Manifest>(value) {
                    return Some(parsed);
                }
            }
        }
    }

    None
}

/// Arguments shared by every invocation.
///
/// `--dir` / `--hermes-home` are passed explicitly rather than relying on the
/// script's own defaults so the install lands exactly where detection looks —
/// the two must not be able to drift. Mirrors `buildPosixPinArgs`.
pub fn common_args(install_root: &str, hermes_home: &str) -> Vec<String> {
    if cfg!(target_os = "windows") {
        vec![
            "-InstallDir".into(),
            install_root.into(),
            "-HermesHome".into(),
            hermes_home.into(),
        ]
    } else {
        vec![
            "--dir".into(),
            install_root.into(),
            "--hermes-home".into(),
            hermes_home.into(),
        ]
    }
}

pub fn manifest_args(install_root: &str, hermes_home: &str) -> Vec<String> {
    let mut args = vec![if cfg!(target_os = "windows") {
        "-Manifest".to_string()
    } else {
        "--manifest".to_string()
    }];

    args.extend(common_args(install_root, hermes_home));
    args
}

pub fn stage_args(stage: &str, install_root: &str, hermes_home: &str) -> Vec<String> {
    let mut args = if cfg!(target_os = "windows") {
        vec![
            "-Stage".to_string(),
            stage.to_string(),
            "-NonInteractive".to_string(),
            "-Json".to_string(),
        ]
    } else {
        vec![
            "--stage".to_string(),
            stage.to_string(),
            "--non-interactive".to_string(),
            "--json".to_string(),
        ]
    };

    args.extend(common_args(install_root, hermes_home));
    args
}

/// Turn a finished stage run into the outcome the UI shows.
///
/// A missing result frame is a FAILURE, not a success: the script emits one on
/// every path it controls, so its absence means the process died in a way it
/// could not report, and treating that as success would march the install on to
/// the next stage over a broken tree.
pub fn classify(exit_code: Option<i32>, stdout: &str) -> Result<StageResultPayload, String> {
    match parse_stage_result(stdout) {
        Some(result) => Ok(result),
        None => Err(match exit_code {
            Some(code) => {
                format!("the installer exited with code {code} without reporting a result")
            }
            None => "the installer was terminated before reporting a result".to_string(),
        }),
    }
}

#[cfg(desktop)]
pub use imp::{clone_repo, run_script};

#[cfg(desktop)]
mod imp {
    use std::path::Path;
    use std::process::Stdio;

    use tokio::io::{AsyncBufReadExt, BufReader};
    use tokio::process::Command;

    use super::super::events::LogStream;

    pub struct ScriptOutcome {
        pub stdout: String,
        pub exit_code: Option<i32>,
        pub killed: bool,
    }

    /// Absolute path to Windows PowerShell.
    ///
    /// Resolved absolutely BEFORE falling back to PATH: a trimmed or
    /// non-expanding PATH otherwise ENOENTs, which surfaces as an install stuck
    /// at "0 of 0 steps" rather than an error. `bootstrap-runner.ts` and
    /// `powershell.rs` both hit this.
    #[cfg(target_os = "windows")]
    fn powershell_exe() -> std::path::PathBuf {
        std::env::var("SystemRoot")
            .ok()
            .map(|root| {
                std::path::PathBuf::from(root)
                    .join("System32")
                    .join("WindowsPowerShell")
                    .join("v1.0")
                    .join("powershell.exe")
            })
            .filter(|p| p.is_file())
            .unwrap_or_else(|| std::path::PathBuf::from("powershell.exe"))
    }

    #[cfg(target_os = "windows")]
    fn build_command(script: &Path, args: &[String]) -> Command {
        let mut command = Command::new(powershell_exe());

        command
            .arg("-NoProfile")
            .arg("-ExecutionPolicy")
            .arg("Bypass")
            .arg("-File")
            .arg(script);
        command.args(args);
        command
    }

    #[cfg(not(target_os = "windows"))]
    fn build_command(script: &Path, args: &[String]) -> Command {
        let mut command = Command::new("bash");

        command.arg(script);
        command.args(args);
        command
    }

    /// Run the install script, streaming every line to `on_line` as it arrives.
    ///
    /// Both pipes are read concurrently and tagged. stderr is NOT an error
    /// channel here — uv, pip, git and npm all write ordinary progress to it, so
    /// folding it into failure would paint a healthy install red.
    pub async fn run_script<F>(
        script: &Path,
        args: &[String],
        hermes_home: &str,
        cancel: &tokio_util::sync::CancellationToken,
        mut on_line: F,
    ) -> Result<ScriptOutcome, String>
    where
        F: FnMut(&str, LogStream),
    {
        let mut command = build_command(script, args);

        command
            .env("HERMES_HOME", hermes_home)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            // CREATE_NO_WINDOW — no console flash out of a GUI process.
            command.creation_flags(0x0800_0000);
        }

        let mut child = command
            .spawn()
            .map_err(|e| format!("could not run the installer ({}): {e}", script.display()))?;

        let stdout = child
            .stdout
            .take()
            .ok_or("installer stdout was not piped")?;
        let stderr = child
            .stderr
            .take()
            .ok_or("installer stderr was not piped")?;

        let mut stdout_lines = BufReader::new(stdout).lines();
        let mut stderr_lines = BufReader::new(stderr).lines();

        let mut collected = String::new();
        let mut stdout_done = false;
        let mut stderr_done = false;
        let mut killed = false;

        while !(stdout_done && stderr_done) {
            tokio::select! {
                line = stdout_lines.next_line(), if !stdout_done => match line {
                    Ok(Some(line)) => {
                        on_line(&line, LogStream::Stdout);
                        collected.push_str(&line);
                        collected.push('\n');
                    }
                    _ => stdout_done = true,
                },
                line = stderr_lines.next_line(), if !stderr_done => match line {
                    Ok(Some(line)) => {
                        on_line(&line, LogStream::Stderr);
                    }
                    _ => stderr_done = true,
                },
                () = cancel.cancelled() => {
                    killed = true;
                    let _ = child.start_kill();
                    break;
                }
            }
        }

        let status = child
            .wait()
            .await
            .map_err(|e| format!("could not wait for the installer: {e}"))?;

        Ok(ScriptOutcome {
            stdout: collected,
            exit_code: status.code(),
            killed,
        })
    }

    /// Shallow-clone `url`@`branch` into `destination`.
    ///
    /// Refuses a destination that already has anything in it. The install
    /// script's own stage would move a broken checkout aside; we do not
    /// reimplement that, and quietly deleting a tree the user may have work in
    /// is not an acceptable substitute for it.
    pub async fn clone_repo<F>(
        url: &str,
        branch: &str,
        destination: &Path,
        cancel: &tokio_util::sync::CancellationToken,
        mut on_line: F,
    ) -> Result<(), String>
    where
        F: FnMut(&str, LogStream),
    {
        if destination.exists() {
            let empty = std::fs::read_dir(destination)
                .map(|mut entries| entries.next().is_none())
                .unwrap_or(false);

            if !empty {
                return Err(format!(
                    "{} already exists and is not empty. Move or remove it, then install again.",
                    destination.display()
                ));
            }
        }

        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
        }

        let mut command = Command::new("git");

        command
            .arg("clone")
            .arg("--depth")
            .arg("1")
            .arg("--branch")
            .arg(branch)
            .arg(url)
            .arg(destination)
            // git writes clone progress to stderr; ask for it explicitly so the
            // UI has something to show during a slow clone.
            .arg("--progress")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }

        let mut child = command
            .spawn()
            .map_err(|e| format!("could not run git: {e}. Is git installed?"))?;

        let stdout = child.stdout.take().ok_or("git stdout was not piped")?;
        let stderr = child.stderr.take().ok_or("git stderr was not piped")?;

        let mut stdout_lines = BufReader::new(stdout).lines();
        let mut stderr_lines = BufReader::new(stderr).lines();

        let mut stdout_done = false;
        let mut stderr_done = false;

        while !(stdout_done && stderr_done) {
            tokio::select! {
                line = stdout_lines.next_line(), if !stdout_done => match line {
                    Ok(Some(line)) => on_line(&line, LogStream::Stdout),
                    _ => stdout_done = true,
                },
                line = stderr_lines.next_line(), if !stderr_done => match line {
                    Ok(Some(line)) => on_line(&line, LogStream::Stderr),
                    _ => stderr_done = true,
                },
                () = cancel.cancelled() => {
                    let _ = child.start_kill();
                    return Err("the install was cancelled".to_string());
                }
            }
        }

        let status = child
            .wait()
            .await
            .map_err(|e| format!("could not wait for git: {e}"))?;

        if status.success() {
            Ok(())
        } else {
            Err(format!(
                "git clone failed ({}). Check the log for details.",
                status
                    .code()
                    .map_or_else(|| "terminated".to_string(), |c| format!("exit code {c}"))
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stage_result_is_taken_from_the_last_frame_after_banners() {
        let stdout =
            "Hermes installer\n  fetching…\n{\"ok\":true,\"stage\":\"venv\",\"skipped\":false}\n";
        let parsed = parse_stage_result(stdout).expect("frame");

        assert_eq!(parsed.stage, "venv");
        assert!(parsed.ok);
        assert!(!parsed.skipped);
    }

    #[test]
    fn a_later_frame_wins_over_an_earlier_one() {
        // Scanning forward would latch the first frame and report the wrong
        // outcome for the stage.
        let stdout =
            "{\"ok\":true,\"stage\":\"a\"}\n{\"ok\":false,\"stage\":\"b\",\"reason\":\"boom\"}";
        let parsed = parse_stage_result(stdout).expect("frame");

        assert_eq!(parsed.stage, "b");
        assert!(!parsed.ok);
        assert_eq!(parsed.reason.as_deref(), Some("boom"));
    }

    #[test]
    fn a_skipped_stage_is_reported_as_skipped_not_failed() {
        // setup/gateway take this path under --non-interactive.
        let parsed =
            parse_stage_result(r#"{"ok":true,"stage":"setup","skipped":true}"#).expect("frame");

        assert!(parsed.ok);
        assert!(parsed.skipped);
    }

    #[test]
    fn json_that_is_not_a_stage_frame_is_ignored() {
        assert!(parse_stage_result(r#"{"hello":"world"}"#).is_none());
        assert!(parse_stage_result("not json at all").is_none());
        assert!(parse_stage_result("").is_none());
    }

    #[test]
    fn manifest_is_parsed_with_its_stage_metadata() {
        let stdout = "banner\n{\"protocol_version\":1,\"stages\":[{\"name\":\"venv\",\"title\":\"Create venv\",\"category\":\"runtime\",\"needs_user_input\":false},{\"name\":\"setup\",\"title\":\"Configure\",\"category\":\"configuration\",\"needs_user_input\":true}]}";
        let manifest = parse_manifest(stdout).expect("manifest");

        assert_eq!(manifest.protocol_version, Some(1));
        assert_eq!(manifest.stages.len(), 2);
        assert_eq!(manifest.stages[0].title, "Create venv");
        assert!(manifest.stages[1].needs_user_input);
    }

    #[test]
    fn a_manifest_without_stages_is_not_a_manifest() {
        assert!(parse_manifest(r#"{"protocol_version":1}"#).is_none());
        assert!(parse_manifest("").is_none());
    }

    #[test]
    fn a_missing_result_frame_is_a_failure_not_a_pass() {
        // The script emits a frame on every path it controls, so no frame means
        // it died in a way it could not report. Marching on would build the rest
        // of the install on top of a broken stage.
        let err = classify(Some(3), "some output but no frame").expect_err("should fail");

        assert!(err.contains('3'), "surfaces the exit code: {err}");

        let killed = classify(None, "").expect_err("should fail");

        assert!(killed.contains("terminated"), "{killed}");
    }

    #[test]
    fn a_present_frame_is_returned_even_on_a_nonzero_exit() {
        // The frame is the contract; the exit code is a fallback for its absence.
        let parsed = classify(
            Some(1),
            r#"{"ok":false,"stage":"venv","reason":"no python"}"#,
        )
        .expect("frame wins");

        assert_eq!(parsed.reason.as_deref(), Some("no python"));
    }

    #[test]
    fn stage_args_carry_the_non_interactive_json_contract_and_the_paths() {
        let args = stage_args("venv", "/root", "/home");
        let joined = args.join(" ");

        assert!(joined.contains("venv"));
        assert!(joined.contains("/root") && joined.contains("/home"));

        if cfg!(target_os = "windows") {
            assert!(joined.contains("-NonInteractive") && joined.contains("-Json"));
        } else {
            assert!(joined.contains("--non-interactive") && joined.contains("--json"));
        }
    }

    #[test]
    fn manifest_args_also_pin_the_paths() {
        // The manifest call resolves the install layout too, so it must agree
        // with the stage calls about where the install lives.
        let joined = manifest_args("/root", "/home").join(" ");

        assert!(joined.contains("/root") && joined.contains("/home"));
    }
}
