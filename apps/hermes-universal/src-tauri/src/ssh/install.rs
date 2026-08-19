//! Installing Allr on a remote host over SSH.
//!
//! `locate_hermes` can already tell you the remote has no Allr; until now that
//! was the end of the road — a `HermesNotFound` error telling the user to go and
//! install it themselves on a machine they are already authenticated to. This
//! module does it for them.
//!
//! It is a *transport* over the same install protocol the local flow drives, not
//! a second installer: `local_install::runner` builds the arguments and parses
//! the frames, `local_install::script` decides which repo, and
//! `local_install::events` is the wire format. The only thing that differs is
//! that each stage runs through `SshSession::exec_with_timeout` instead of a
//! child process.
//!
//! Three constraints govern everything here, all of them learned from
//! `scripts/install.sh` rather than invented:
//!
//! 1. **Never request a PTY.** `--non-interactive` in that script means "take the
//!    DEFAULT", not "answer no" (`install.sh:362`), and several defaults are
//!    *yes* — including installing and starting a **systemd gateway service**
//!    (`:2490`, `:2494`) and an apt `sudo` call that is missing `-n` (`:1536`).
//!    Those sites are all gated on an openable `/dev/tty`, and an SSH exec
//!    channel has none. A PTY here would silently install a service on someone
//!    else's machine. Driving `--stage` also skips `setup`/`gateway` outright,
//!    which is the second, independent guard.
//!
//! 2. **`git` must already be there.** Everything else bootstraps into user space
//!    — `uv` (`install_uv:549`), Python 3.11 (`check_python:642`, "no sudo
//!    needed!") and Node (`install_node:862`). `check_git` instead ends in a hard
//!    `exit 1` (`:786`), and on macOS with no git and no brew it fires
//!    `xcode-select --install` — a GUI dialog — then polls for 900 seconds. So we
//!    probe first and refuse, rather than hanging a quarter of an hour.
//!
//! 3. **Stages need their own timeouts.** `SshSession::exec` defaults to 20s,
//!    which every stage would blow through. Worse, the script's own `python-deps`
//!    stage (`uv sync`, `:1581`) has *no* timeout wrapper at all, so our ceiling
//!    is the only thing standing between a stalled index fetch and a hang.

use std::time::Duration;

use tauri::{AppHandle, Emitter};

use super::error::{SshError, SshErrorKind};
use super::remote_paths::shq;
use super::session::SshSession;
use crate::local_install::events::{InstallEvent, LogStream, StageInfo, StageState};
use crate::local_install::runner::{self, REPOSITORY_STAGE};
use crate::local_install::script::Repo;

/// Stages that pull the world down. `node-deps` is npm twice at 600s each plus a
/// Playwright Chromium download that can retry once; `python-deps` is the
/// unbounded `uv sync`. Sized from the script's own caps, not guessed.
const LONG_STAGE_TIMEOUT: Duration = Duration::from_secs(25 * 60);
/// Everything else: venv creation, PATH shims, config templates.
const SHORT_STAGE_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// A shallow clone of the agent repo.
const CLONE_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// Probes that should answer immediately or not at all.
const PROBE_TIMEOUT: Duration = Duration::from_secs(30);

/// How long a given stage may run.
pub fn stage_timeout(stage: &str) -> Duration {
    match stage {
        "node-deps" | "python-deps" | "desktop" => LONG_STAGE_TIMEOUT,
        _ => SHORT_STAGE_TIMEOUT,
    }
}

/// Stages we drive ourselves rather than delegating to the script.
///
/// Only `repository`: its clone URL is hardcoded to upstream with no override
/// flag (`install.sh:46-47`), so honouring the user's repo choice means doing the
/// clone here. Everything else is the script's job.
pub fn is_self_driven(stage: &str) -> bool {
    stage == REPOSITORY_STAGE
}

/// The command that runs one stage on the remote.
///
/// `bash` explicitly rather than `sh`: the script uses bash-isms throughout, and
/// a Debian remote whose `/bin/sh` is dash would fail in ways that look like
/// install errors.
pub fn stage_command(script: &str, stage: &str, root: &str, home: &str) -> String {
    let args = runner::stage_args(stage, root, home);

    format!(
        "bash {} {}",
        shq(script),
        args.iter().map(|a| shq(a)).collect::<Vec<_>>().join(" ")
    )
}

pub fn manifest_command(script: &str, root: &str, home: &str) -> String {
    let args = runner::manifest_args(root, home);

    format!(
        "bash {} {}",
        shq(script),
        args.iter().map(|a| shq(a)).collect::<Vec<_>>().join(" ")
    )
}

/// Shallow-clone the chosen repo on the remote.
///
/// `--depth 1` and an explicit branch, matching what the script's own stage
/// would do. HTTPS only — an SSH clone from the remote could prompt for a host
/// key or a hardware token, and there is nowhere to surface that.
pub fn clone_command(repo: Repo, branch: &str, root: &str) -> String {
    format!(
        "git clone --depth 1 --branch {} {} {}",
        shq(branch),
        shq(&repo.clone_url()),
        shq(root)
    )
}

/// Refuse to clone over an existing non-empty directory.
///
/// The script's own `repository` stage would move a broken checkout aside; we do
/// not reimplement that, and silently deleting a tree on someone else's machine
/// is not an acceptable substitute. Prints `busy` when the path exists and has
/// anything in it.
pub fn clone_guard_command(root: &str) -> String {
    format!(
        "if [ -d {root} ] && [ -n \"$(ls -A {root} 2>/dev/null)\" ]; then echo busy; else echo free; fi",
        root = shq(root)
    )
}

fn not_found(message: impl Into<String>) -> SshError {
    SshError::new(SshErrorKind::HermesNotFound, message)
}

fn failed(message: impl Into<String>) -> SshError {
    SshError::new(SshErrorKind::Unknown, message)
}

fn emit(app: &AppHandle, install_id: &str, event: InstallEvent) {
    // A dropped event must never abort an install in progress on someone's
    // machine — the webview may simply have navigated away.
    let _ = app.emit(&InstallEvent::channel(install_id), event);
}

/// Forward a stage's captured output as log lines.
///
/// Sent only once the stage ends, because `exec` buffers: there is no incremental
/// delivery to forward. stderr is tagged, not treated as failure — uv, pip, git
/// and npm all write ordinary progress there.
fn emit_output(
    app: &AppHandle,
    install_id: &str,
    stage: Option<&str>,
    text: &str,
    stream: LogStream,
) {
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }

        emit(
            app,
            install_id,
            InstallEvent::Log {
                stage: stage.map(str::to_string),
                line: line.to_string(),
                stream,
            },
        );
    }
}

/// Install Allr on the connected host. Returns the resolved `hermes` path.
pub async fn install_remote(
    session: &SshSession,
    app: &AppHandle,
    install_id: &str,
    repo: Repo,
    branch: &str,
) -> Result<String, SshError> {
    // 1. Preflight. See the module note: git is the one prerequisite that cannot
    //    bootstrap itself, and its failure mode on macOS is a 15-minute stall.
    let git = session
        .exec_with_timeout("sh -lc 'command -v git'", None, PROBE_TIMEOUT)
        .await?;

    if !git.succeeded() || git.stdout.trim().is_empty() {
        return Err(not_found(
            "`git` is not installed on that host, and the Allr installer cannot install it \
             itself. Install git there (for example `apt install git` or `xcode-select \
             --install`), then try again.",
        ));
    }

    let home = super::posix_lifecycle::probe_hermes_home(session).await?;
    let root = format!("{}/allr-agent", home.trim_end_matches('/'));

    // 2. Ship the chosen repo's own installer up, rather than curl-ing it on the
    //    remote: the fork's script is then used verbatim, and one remote network
    //    dependency disappears from the failure surface.
    emit_output(
        app,
        install_id,
        None,
        &format!("Uploading the installer for {}…", repo.slug()),
        LogStream::Stdout,
    );

    let hermes_home = crate::plugins::hermes_home()
        .ok_or_else(|| failed("could not determine the local ALLR_HOME"))?;
    let local_script = crate::local_install::script::resolve(&hermes_home, repo, branch, false)
        .await
        .map_err(failed)?;
    let body =
        std::fs::read(&local_script).map_err(|e| failed(format!("reading the installer: {e}")))?;

    let remote_script = format!("{home}/bootstrap-cache/install.sh");
    let upload = format!(
        "mkdir -p {dir} && cat > {path}",
        dir = shq(&format!("{home}/bootstrap-cache")),
        path = shq(&remote_script)
    );

    session
        .exec_with_timeout(&upload, Some(&body), PROBE_TIMEOUT)
        .await?
        .require_success("uploading the installer")?;

    // 3. The manifest is both the stage list and the UI's ladder.
    let manifest_out = session
        .exec_with_timeout(
            &manifest_command(&remote_script, &root, &home),
            None,
            PROBE_TIMEOUT,
        )
        .await?;

    let manifest = runner::parse_manifest(&manifest_out.stdout)
        .ok_or_else(|| failed("the remote installer did not report a stage list"))?;

    let stages: Vec<StageInfo> = manifest.stages.clone();

    emit(
        app,
        install_id,
        InstallEvent::Manifest {
            stages: stages.clone(),
            protocol_version: manifest.protocol_version,
        },
    );

    // 4. Walk the ladder in the script's own order.
    for stage in &stages {
        let started = std::time::Instant::now();

        emit(
            app,
            install_id,
            InstallEvent::Stage {
                name: stage.name.clone(),
                state: StageState::Running,
                duration_ms: None,
                reason: None,
            },
        );

        let outcome = if is_self_driven(&stage.name) {
            clone_repo(session, app, install_id, repo, branch, &root).await
        } else {
            run_stage(
                session,
                app,
                install_id,
                &remote_script,
                &stage.name,
                &root,
                &home,
            )
            .await
        };

        let duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);

        match outcome {
            Ok(skipped) => emit(
                app,
                install_id,
                InstallEvent::Stage {
                    name: stage.name.clone(),
                    state: if skipped {
                        StageState::Skipped
                    } else {
                        StageState::Succeeded
                    },
                    duration_ms: Some(duration_ms),
                    reason: None,
                },
            ),
            Err(error) => {
                emit(
                    app,
                    install_id,
                    InstallEvent::Stage {
                        name: stage.name.clone(),
                        state: StageState::Failed,
                        duration_ms: Some(duration_ms),
                        reason: Some(error.message.clone()),
                    },
                );
                emit(
                    app,
                    install_id,
                    InstallEvent::Failed {
                        stage: Some(stage.name.clone()),
                        error: error.message.clone(),
                    },
                );

                return Err(error);
            }
        }
    }

    // 5. Confirm by the same route a later connect will take, rather than
    //    trusting that the install "must" have worked. The shims land in
    //    ~/.local/bin, which `locate_hermes` covers via its login shell and its
    //    fallback list — the rc-file PATH edits the script makes are NOT enough
    //    on their own (a non-interactive bash never reaches them).
    let hermes_path = super::posix_lifecycle::locate_hermes(session, None).await?;

    emit(
        app,
        install_id,
        InstallEvent::Complete {
            install_root: root,
            marker: None,
        },
    );

    Ok(hermes_path)
}

/// Run one delegated stage. `Ok(true)` means the script reported it skipped.
async fn run_stage(
    session: &SshSession,
    app: &AppHandle,
    install_id: &str,
    script: &str,
    stage: &str,
    root: &str,
    home: &str,
) -> Result<bool, SshError> {
    let out = session
        .exec_with_timeout(
            &stage_command(script, stage, root, home),
            None,
            stage_timeout(stage),
        )
        .await?;

    emit_output(app, install_id, Some(stage), &out.stdout, LogStream::Stdout);
    emit_output(app, install_id, Some(stage), &out.stderr, LogStream::Stderr);

    // `classify` treats a missing result frame as failure, which is right: the
    // script emits one on every path it controls, so its absence means the run
    // died in a way it could not report.
    let frame = runner::classify(out.exit_status.map(|s| s as i32), &out.stdout).map_err(failed)?;

    if frame.ok {
        Ok(frame.skipped)
    } else {
        Err(failed(frame.reason.unwrap_or_else(|| {
            format!("the {stage} step failed on the remote host")
        })))
    }
}

/// The `repository` stage, done our way so the repo choice is honoured.
async fn clone_repo(
    session: &SshSession,
    app: &AppHandle,
    install_id: &str,
    repo: Repo,
    branch: &str,
    root: &str,
) -> Result<bool, SshError> {
    let guard = session
        .exec_with_timeout(&clone_guard_command(root), None, PROBE_TIMEOUT)
        .await?;

    if guard.stdout.contains("busy") {
        return Err(failed(format!(
            "{root} already exists on that host and is not empty. Move or remove it there, \
             then try again."
        )));
    }

    let out = session
        .exec_with_timeout(&clone_command(repo, branch, root), None, CLONE_TIMEOUT)
        .await?;

    // git reports clone progress on stderr by design.
    emit_output(
        app,
        install_id,
        Some(REPOSITORY_STAGE),
        &out.stderr,
        LogStream::Stderr,
    );

    if out.succeeded() {
        Ok(false)
    } else {
        Err(failed(format!(
            "could not clone {} on that host. Check the log for details.",
            repo.slug()
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn long_stages_get_the_long_ceiling() {
        // A 20s default (SshSession::exec) would fail all of these, and
        // python-deps has no timeout of its own inside the script.
        assert_eq!(stage_timeout("node-deps"), LONG_STAGE_TIMEOUT);
        assert_eq!(stage_timeout("python-deps"), LONG_STAGE_TIMEOUT);
        assert_eq!(stage_timeout("venv"), SHORT_STAGE_TIMEOUT);
        assert_eq!(stage_timeout("config"), SHORT_STAGE_TIMEOUT);
        assert!(SHORT_STAGE_TIMEOUT > Duration::from_secs(20));
    }

    #[test]
    fn only_the_repository_stage_is_self_driven() {
        assert!(is_self_driven("repository"));

        for stage in [
            "prerequisites",
            "venv",
            "python-deps",
            "node-deps",
            "path",
            "complete",
        ] {
            assert!(!is_self_driven(stage), "{stage} belongs to the script");
        }
    }

    #[test]
    fn a_stage_command_carries_the_non_interactive_json_contract() {
        let cmd = stage_command(
            "/tmp/i.sh",
            "venv",
            "/home/u/.allr/allr-agent",
            "/home/u/.allr",
        );

        assert!(
            cmd.starts_with("bash "),
            "bash, not sh — the script uses bash-isms: {cmd}"
        );
        assert!(cmd.contains("'--non-interactive'"));
        assert!(cmd.contains("'--json'"));
        assert!(cmd.contains("'--stage' 'venv'"));
        assert!(cmd.contains("'/home/u/.allr/allr-agent'"));
        assert!(cmd.contains("'/home/u/.allr'"));
    }

    #[test]
    fn a_stage_command_never_asks_for_a_tty() {
        // The whole no-sudo, no-gateway-service story rests on there being no
        // TTY. Nothing in the command may request one.
        let cmd = stage_command("/tmp/i.sh", "prerequisites", "/r", "/h");

        assert!(!cmd.contains("-t"), "{cmd}");
        assert!(!cmd.contains("ssh "), "{cmd}");
    }

    #[test]
    fn every_interpolated_value_is_quoted() {
        // A path with a space or a quote must not split into extra words.
        let cmd = stage_command(
            "/tmp/my installer.sh",
            "venv",
            "/home/o'brien/root",
            "/home/o'brien",
        );

        assert!(cmd.contains("'/tmp/my installer.sh'"));
        assert!(cmd.contains(r"'/home/o'\''brien/root'"));
    }

    #[test]
    fn the_clone_targets_the_chosen_fork_over_https() {
        let cmd = clone_command(Repo::Fork, "main", "/home/u/.allr/allr-agent");

        assert!(cmd.contains("jaxmatrix/mjx-hermes-agent"), "{cmd}");
        assert!(cmd.contains("--depth 1"));
        assert!(cmd.contains("'main'"));
        // Never SSH: a remote-side host-key or hardware-token prompt has nowhere
        // to surface.
        assert!(cmd.contains("https://"), "{cmd}");
        assert!(!cmd.contains("git@"), "{cmd}");

        let upstream = clone_command(Repo::Upstream, "main", "/r");

        assert!(upstream.contains("NousResearch/hermes-agent"), "{upstream}");
    }

    #[test]
    fn a_hostile_branch_name_stays_one_shell_word() {
        // Asserting on the escaped TEXT proves nothing — `; rm -rf ~` appears in
        // the output either way, harmlessly inside the quotes or catastrophically
        // outside them. So ask a real shell to word-split it and check the
        // argument arrives verbatim, with nothing executed.
        let hostile = "main'; rm -rf ~; echo '";
        let cmd = clone_command(Repo::Upstream, hostile, "/r");
        let branch_word = shq(hostile);

        assert!(cmd.contains(&branch_word), "{cmd}");

        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg(format!("printf '%s' {branch_word}"))
            .output()
            .expect("run sh");

        assert!(out.status.success());
        assert_eq!(String::from_utf8_lossy(&out.stdout), hostile);
    }

    #[test]
    fn a_hostile_path_stays_one_shell_word() {
        let hostile = "/tmp/a b'; touch /tmp/pwned; '";
        let cmd = stage_command("/tmp/i.sh", "venv", hostile, "/h");

        assert!(cmd.contains(&shq(hostile)), "{cmd}");

        // `set -- <quoted>` then `$#` — exactly one argument means no splitting.
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg(format!("set -- {}; printf '%s' \"$#\"", shq(hostile)))
            .output()
            .expect("run sh");

        assert_eq!(String::from_utf8_lossy(&out.stdout), "1");
    }

    #[test]
    fn the_clone_guard_reports_busy_only_for_a_non_empty_directory() {
        let cmd = clone_guard_command("/home/u/.allr/allr-agent");

        assert!(
            cmd.contains("ls -A"),
            "emptiness, not mere existence: {cmd}"
        );
        assert!(cmd.contains("busy") && cmd.contains("free"));
        assert!(cmd.contains("'/home/u/.allr/allr-agent'"));
        // It must never delete anything on someone else's machine.
        assert!(!cmd.contains("rm "), "{cmd}");
    }

    #[test]
    fn the_manifest_command_pins_the_same_paths_as_the_stages() {
        // The manifest call resolves the install layout too; if it disagreed
        // with the stage calls the install would land somewhere else.
        let manifest = manifest_command("/tmp/i.sh", "/r", "/h");
        let stage = stage_command("/tmp/i.sh", "venv", "/r", "/h");

        for needle in ["'/r'", "'/h'"] {
            assert!(manifest.contains(needle), "{manifest}");
            assert!(stage.contains(needle), "{stage}");
        }
    }
}
