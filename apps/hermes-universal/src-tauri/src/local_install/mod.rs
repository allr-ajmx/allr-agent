//! Finding, and if necessary installing, a local Hermes.
//!
//! The Local gateway step used to be a single "Save & reconnect" button over
//! `local_backend.rs`, whose entire idea of where Hermes lives is `HERMES_BIN` or
//! bare `"hermes"` on the inherited PATH — discovered only by failing to spawn,
//! 45-90s into a connect. This module gives that step something to say:
//!
//!   detect -> found (show it) | missing (offer a repo) -> install -> setup
//!
//! Split the way `ssh/` is:
//!   * `detect`  — the ordered, validated ladder that answers "is it installed?"
//!   * `script`  — obtaining the install script for a chosen repo
//!   * `runner`  — the stage protocol, spawning, and parsing
//!   * `events`  — the wire types
//!
//! Everything here is desktop-only, like `local_backend.rs`: a phone cannot spawn
//! a backend, so `LOCAL_MODE_SUPPORTED` hides the whole surface there. The mobile
//! arms below keep the commands callable and answer `unsupported_platform`.

pub mod detect;
pub mod events;
pub mod runner;
pub mod script;

#[cfg_attr(desktop, allow(unused_imports))]
pub use detect::LocalInstall;
#[cfg_attr(desktop, allow(unused_imports))]
pub use script::Repo;

/// Branch installed when the caller does not name one.
pub const DEFAULT_BRANCH: &str = "main";

#[cfg(desktop)]
pub use imp::{local_install_cancel, local_install_detect, local_install_start, InstallState};

#[cfg(desktop)]
mod imp {
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::Mutex;

    use tauri::{AppHandle, Emitter, Manager};
    use tokio_util::sync::CancellationToken;

    use super::detect::{LocalInstall, MARKER_FILE, MARKER_SCHEMA_VERSION};
    use super::events::{InstallEvent, LogStream, StageInfo, StageState};
    use super::runner::{self, REPOSITORY_STAGE};
    use super::script::{self, Repo};
    use super::DEFAULT_BRANCH;

    /// Live installs, so `local_install_cancel` can reach one.
    #[derive(Default)]
    pub struct InstallState(pub Mutex<HashMap<String, CancellationToken>>);

    fn emit(app: &AppHandle, install_id: &str, event: InstallEvent) {
        // A dropped event must never abort an install — the webview may simply
        // have navigated away.
        let _ = app.emit(&InstallEvent::channel(install_id), event);
    }

    fn hermes_home() -> Result<PathBuf, String> {
        crate::plugins::hermes_home()
            .ok_or_else(|| "could not determine HERMES_HOME on this system".to_string())
    }

    /// Drop an install from the registry.
    ///
    /// `let ... else` rather than `if let`: an `if let` scrutinee temporary lives
    /// to the end of the whole statement, which outlives the `State` guard it
    /// borrows from and does not compile.
    fn forget(app: &AppHandle, install_id: &str) {
        let state = app.state::<InstallState>();
        let Ok(mut live) = state.0.lock() else {
            return;
        };

        live.remove(install_id);
    }

    #[tauri::command]
    pub async fn local_install_detect() -> Result<LocalInstall, String> {
        Ok(super::detect::detect().await)
    }

    #[tauri::command]
    pub async fn local_install_cancel(
        state: tauri::State<'_, InstallState>,
        install_id: String,
    ) -> Result<(), String> {
        let token = state
            .0
            .lock()
            .map_err(|_| "install registry was poisoned".to_string())?
            .get(&install_id)
            .cloned();

        if let Some(token) = token {
            token.cancel();
        }

        Ok(())
    }

    /// Run the whole install for `repo`.
    ///
    /// The caller mints `install_id` and subscribes to
    /// `hermes-install://{id}/event` BEFORE invoking — the house convention
    /// (`ssh/progress.rs`, `pty.rs`), and what stops the manifest being emitted
    /// into a void before the first listener attaches.
    #[tauri::command]
    pub async fn local_install_start(
        app: AppHandle,
        install_id: String,
        repo: Repo,
        branch: Option<String>,
    ) -> Result<(), String> {
        let branch = branch
            .map(|b| b.trim().to_string())
            .filter(|b| !b.is_empty())
            .unwrap_or_else(|| DEFAULT_BRANCH.to_string());

        let token = CancellationToken::new();

        {
            let state = app.state::<InstallState>();
            let mut live = state
                .0
                .lock()
                .map_err(|_| "install registry was poisoned".to_string())?;

            live.insert(install_id.clone(), token.clone());
        }

        let outcome = run(&app, &install_id, repo, &branch, &token).await;

        forget(&app, &install_id);

        if let Err(error) = &outcome {
            emit(
                &app,
                &install_id,
                InstallEvent::Failed {
                    stage: None,
                    error: error.clone(),
                },
            );
        }

        outcome
    }

    async fn run(
        app: &AppHandle,
        install_id: &str,
        repo: Repo,
        branch: &str,
        token: &CancellationToken,
    ) -> Result<(), String> {
        let home = hermes_home()?;
        let home_str = home.to_string_lossy().to_string();
        let install_root = home.join("hermes-agent");
        let root_str = install_root.to_string_lossy().to_string();

        let log = |stage: Option<&str>, line: &str, stream: LogStream| {
            emit(
                app,
                install_id,
                InstallEvent::Log {
                    stage: stage.map(str::to_string),
                    line: line.to_string(),
                    stream,
                },
            );
        };

        // 1. The install script, from the SAME repo we are about to clone.
        log(
            None,
            &format!("Fetching the installer for {}…", repo.slug()),
            LogStream::Stdout,
        );

        let script_path = script::resolve(&home, repo, branch, cfg!(debug_assertions)).await?;

        // 2. Its manifest, which is also the UI's stage list.
        let manifest_run = runner::run_script(
            &script_path,
            &runner::manifest_args(&root_str, &home_str),
            &home_str,
            token,
            |line, stream| log(None, line, stream),
        )
        .await?;

        if manifest_run.killed {
            return Err("the install was cancelled".to_string());
        }

        let manifest = runner::parse_manifest(&manifest_run.stdout)
            .ok_or("the installer did not report a stage list")?;

        // The clone is ours, but it stays in the list under the script's own
        // stage name so the UI shows one uninterrupted ladder.
        let stages: Vec<StageInfo> = manifest.stages.clone();

        emit(
            app,
            install_id,
            InstallEvent::Manifest {
                stages: stages.clone(),
                protocol_version: manifest.protocol_version,
            },
        );

        // 3. Each stage in the manifest's own order.
        for stage in &stages {
            if token.is_cancelled() {
                return Err("the install was cancelled".to_string());
            }

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

            let result = if stage.name == REPOSITORY_STAGE {
                // Ours, because the script's clone URL is hardcoded upstream.
                runner::clone_repo(
                    &repo.clone_url(),
                    branch,
                    &install_root,
                    token,
                    |line, stream| log(Some(REPOSITORY_STAGE), line, stream),
                )
                .await
                .map(|()| (false, None))
            } else {
                let run = runner::run_script(
                    &script_path,
                    &runner::stage_args(&stage.name, &root_str, &home_str),
                    &home_str,
                    token,
                    |line, stream| log(Some(&stage.name), line, stream),
                )
                .await?;

                if run.killed {
                    return Err("the install was cancelled".to_string());
                }

                runner::classify(run.exit_code, &run.stdout).and_then(|frame| {
                    if frame.ok {
                        Ok((frame.skipped, frame.reason))
                    } else {
                        Err(frame
                            .reason
                            .unwrap_or_else(|| format!("the {} step failed", stage.name)))
                    }
                })
            };

            let duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);

            match result {
                Ok((skipped, reason)) => emit(
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
                        reason,
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
                            reason: Some(error.clone()),
                        },
                    );
                    emit(
                        app,
                        install_id,
                        InstallEvent::Failed {
                            stage: Some(stage.name.clone()),
                            error: error.clone(),
                        },
                    );

                    return Err(error);
                }
            }
        }

        // 4. The marker. The script's own `complete` stage writes one too, but it
        //    cannot know we cloned a fork, so we rewrite it with the ref we
        //    actually installed. Schema is shared with install.sh, install.ps1
        //    and Electron's main.ts — all four must stay in lockstep.
        let marker = write_marker(&install_root, branch).ok();

        emit(
            app,
            install_id,
            InstallEvent::Complete {
                install_root: root_str,
                marker,
            },
        );

        Ok(())
    }

    /// `git rev-parse HEAD` in the fresh checkout, for the marker's provenance.
    fn head_commit(root: &std::path::Path) -> Option<String> {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(root)
            .arg("rev-parse")
            .arg("HEAD")
            .output()
            .ok()?;

        output
            .status
            .success()
            .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
            .filter(|c| c.len() >= 7)
    }

    fn write_marker(root: &std::path::Path, branch: &str) -> Result<serde_json::Value, String> {
        let commit =
            head_commit(root).ok_or_else(|| "could not read the installed commit".to_string())?;

        let completed_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or_default();

        let marker = serde_json::json!({
            "schemaVersion": MARKER_SCHEMA_VERSION,
            "pinnedCommit": commit,
            "pinnedBranch": branch,
            "completedAtUnix": completed_at,
        });

        let body = serde_json::to_string(&marker).map_err(|e| e.to_string())?;
        let destination = root.join(MARKER_FILE);
        let temporary = destination.with_extension("tmp");

        std::fs::write(&temporary, body).map_err(|e| format!("could not write the marker: {e}"))?;
        std::fs::rename(&temporary, &destination)
            .map_err(|e| format!("could not finalize the marker: {e}"))?;

        Ok(marker)
    }
}

// ── Mobile stubs ────────────────────────────────────────────────────────────
// Local mode is desktop-only (`LOCAL_MODE_SUPPORTED = !IS_MOBILE`), so nothing
// should reach these. They exist so the command table is identical on every
// target, matching how `local_backend.rs` handles the same split.

/// The mobile half of the state, so `lib.rs` can `.manage()` it unconditionally.
///
/// Its absence is what broke the iOS and Android builds: the commands below were
/// stubbed for mobile but the state they are registered alongside was not, so
/// `local_install::InstallState` resolved to nothing outside `cfg(desktop)`.
/// `local_backend.rs` carries the same empty-struct twin for the same reason.
#[cfg(mobile)]
#[derive(Default)]
pub struct InstallState;

#[cfg(mobile)]
#[tauri::command]
pub async fn local_install_detect() -> Result<LocalInstall, String> {
    Ok(LocalInstall::none())
}

#[cfg(mobile)]
#[tauri::command]
pub async fn local_install_start(
    _install_id: String,
    _repo: Repo,
    _branch: Option<String>,
) -> Result<(), String> {
    Err("unsupported_platform".to_string())
}

#[cfg(mobile)]
#[tauri::command]
pub async fn local_install_cancel(_install_id: String) -> Result<(), String> {
    Err("unsupported_platform".to_string())
}
