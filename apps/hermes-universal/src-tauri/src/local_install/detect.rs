//! "Is Hermes installed on this machine, and where?"
//!
//! `local_backend.rs` answers this with one line — `HERMES_BIN` or the bare string
//! `"hermes"` handed to the OS PATH — and only discovers the answer by failing to
//! spawn, 45-90s into a connect attempt. That is the gap this module closes.
//!
//! It is an ORDERED, VALIDATED LADDER, per `apps/desktop/AGENTS.md`: precedence is
//! written down once, and a candidate is trusted only after it is probed.
//! Existence is not proof — a `hermes` file that cannot report `--version` is not
//! an install, and a bootstrap marker beside an unusable tree is not either.
//!
//! The rung that matters most is the login shell. A GUI app launched from Finder
//! or the Dock inherits a login-less PATH with no `~/.local/bin` and no venv bin —
//! which is precisely where Hermes installs. `ssh/posix_lifecycle.rs:315`
//! documents the identical trap for `ssh host cmd`; the fix is the same, and the
//! failure it prevents is invisible from a terminal-launched dev build.

use std::path::{Path, PathBuf};

use serde::Serialize;

/// How the install we found was reached.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum InstallKind {
    /// An install this app manages, at `<hermes_home>/hermes-agent`.
    Managed,
    /// Some other Hermes the user already had — on PATH or at a known location.
    Path,
    /// Nothing usable. A NORMAL state, never an error: it is the whole reason
    /// the install screen exists.
    None,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalInstall {
    pub kind: InstallKind,
    /// The checkout root, for a managed install.
    pub root: Option<String>,
    /// The executable we would actually run.
    pub command: Option<String>,
    /// First line of `--version`, best effort.
    pub version: Option<String>,
    /// Whether a VALID `.hermes-bootstrap-complete` was found. Provenance only —
    /// see `usable_root`.
    pub has_marker: bool,
}

impl LocalInstall {
    pub fn none() -> Self {
        Self {
            kind: InstallKind::None,
            root: None,
            command: None,
            version: None,
            has_marker: false,
        }
    }
}

pub const MARKER_FILE: &str = ".hermes-bootstrap-complete";
pub const MARKER_SCHEMA_VERSION: u64 = 1;

/// Does this JSON satisfy the shared bootstrap-marker contract?
///
/// The schema is written by four places that must stay in lockstep —
/// `scripts/install.sh` (`write_bootstrap_marker`), `scripts/install.ps1`
/// (`Write-BootstrapMarker`), Electron's `main.ts` (`writeBootstrapMarker`), and
/// this crate's installer. The validator mirrors Electron's
/// `hasValidBootstrapMarker`: schema version 1, and a `pinnedCommit` long enough
/// to be a real short SHA.
pub fn marker_is_valid(value: &serde_json::Value) -> bool {
    let version_ok = value
        .get("schemaVersion")
        .and_then(serde_json::Value::as_u64)
        == Some(MARKER_SCHEMA_VERSION);

    let commit_ok = value
        .get("pinnedCommit")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|c| c.len() >= 7);

    version_ok && commit_ok
}

/// Read and validate the marker at `root`. Any failure — absent, unreadable,
/// corrupt, wrong schema — is simply "no valid marker", never an error: the
/// marker is provenance, and a tree that works without one still works.
pub fn read_marker(root: &Path) -> Option<serde_json::Value> {
    let raw = std::fs::read_to_string(root.join(MARKER_FILE)).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;

    marker_is_valid(&value).then_some(value)
}

/// Does `root` look like a Hermes checkout we could actually run?
///
/// Mirrors Electron's `isHermesSourceRoot` + venv check. Deliberately structural
/// rather than executing anything: this runs on every visit to the Local step, and
/// the authoritative "does it work" probe is the `--version` call on the resolved
/// command a moment later.
pub fn usable_root(root: &Path) -> bool {
    root.join("hermes_cli").join("main.py").is_file() && venv_hermes(root).is_some()
}

/// The `hermes` executable inside a checkout's venv, if present.
pub fn venv_hermes(root: &Path) -> Option<PathBuf> {
    let candidate = if cfg!(target_os = "windows") {
        root.join("venv").join("Scripts").join("hermes.exe")
    } else {
        root.join("venv").join("bin").join("hermes")
    };

    candidate.is_file().then_some(candidate)
}

/// Well-known locations to try after PATH, mirroring
/// `ssh/posix_lifecycle.rs`'s `FALLBACK_HERMES_PATHS` — the same list, for the
/// same reason, just resolved locally instead of over a channel.
pub fn fallback_candidates(home: Option<&Path>, hermes_home: Option<&Path>) -> Vec<PathBuf> {
    let mut out = Vec::new();

    if let Some(hermes_home) = hermes_home {
        let root = hermes_home.join("hermes-agent");

        if let Some(bin) = venv_hermes(&root) {
            out.push(bin);
        }
    }

    if let Some(home) = home {
        if cfg!(target_os = "windows") {
            out.push(
                home.join("AppData")
                    .join("Local")
                    .join("bin")
                    .join("hermes.exe"),
            );
        } else {
            out.push(home.join(".local").join("bin").join("hermes"));
        }
    }

    if !cfg!(target_os = "windows") {
        out.push(PathBuf::from("/usr/local/bin/hermes"));
        out.push(PathBuf::from("/opt/homebrew/bin/hermes"));
    }

    out
}

/// Trim `--version` output to one line. The CLI prints a single line today, but a
/// warning banner ahead of it would otherwise end up rendered as the version.
pub fn first_line(output: &str) -> Option<String> {
    output
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
}

#[cfg(desktop)]
pub use imp::detect;

#[cfg(desktop)]
mod imp {
    use std::path::{Path, PathBuf};
    use std::process::Stdio;

    use tokio::process::Command;

    use super::{
        fallback_candidates, first_line, read_marker, usable_root, venv_hermes, InstallKind,
        LocalInstall,
    };

    /// Probing must not hang the Local step. A wedged binary (a Windows Store
    /// python stub, an NFS mount that went away) would otherwise park the UI on a
    /// spinner with no recovery.
    const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

    /// Run `<cmd> --version`, returning its first line when it exits 0.
    ///
    /// This is the validation step the ladder is built around: it is what makes
    /// "there is a file called hermes here" into "there is a working Hermes here".
    async fn probe_version(cmd: &Path) -> Option<String> {
        let mut command = Command::new(cmd);

        command
            .arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            // CREATE_NO_WINDOW — no console flash from a GUI process.
            command.creation_flags(0x0800_0000);
        }

        let output = tokio::time::timeout(PROBE_TIMEOUT, command.output())
            .await
            .ok()?
            .ok()?;

        if !output.status.success() {
            return None;
        }

        // Some builds print the version to stderr; accept either.
        let stdout = String::from_utf8_lossy(&output.stdout);

        first_line(&stdout).or_else(|| first_line(&String::from_utf8_lossy(&output.stderr)))
    }

    /// Resolve `hermes` the way the user's own shell would.
    ///
    /// `command -v` inside `sh -lc` runs a LOGIN shell, so it sees the PATH the
    /// user's profile builds — including `~/.local/bin` and any venv shims. The
    /// process PATH we inherit from Finder does not. On Windows there is no login
    /// shell to consult and PATH is already machine-wide, so this is POSIX-only.
    #[cfg(not(target_os = "windows"))]
    async fn login_shell_hermes() -> Option<PathBuf> {
        let mut command = Command::new("sh");

        command
            .arg("-lc")
            .arg("command -v hermes")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());

        let output = tokio::time::timeout(PROBE_TIMEOUT, command.output())
            .await
            .ok()?
            .ok()?;

        if !output.status.success() {
            return None;
        }

        first_line(&String::from_utf8_lossy(&output.stdout)).map(PathBuf::from)
    }

    #[cfg(target_os = "windows")]
    async fn login_shell_hermes() -> Option<PathBuf> {
        None
    }

    fn home_dir() -> Option<PathBuf> {
        std::env::var(if cfg!(target_os = "windows") {
            "USERPROFILE"
        } else {
            "HOME"
        })
        .ok()
        .map(PathBuf::from)
    }

    /// Walk the ladder. Never returns `Err` for "not installed" — that is
    /// `InstallKind::None`, a state the UI is built to handle.
    pub async fn detect() -> LocalInstall {
        let hermes_home = crate::plugins::hermes_home();

        // Rung 1: HERMES_BIN. Honoured strictly, because it is exactly what
        // local_backend.rs will spawn — reporting anything else here would show
        // the user an install the connect path is not going to use.
        if let Some(explicit) = std::env::var("HERMES_BIN")
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
        {
            let path = PathBuf::from(&explicit);
            let version = probe_version(&path).await;

            return LocalInstall {
                kind: InstallKind::Path,
                root: None,
                command: Some(explicit),
                version,
                has_marker: false,
            };
        }

        // Rung 2: the managed checkout. Marker is provenance; usability decides.
        if let Some(root) = hermes_home.as_ref().map(|h| h.join("hermes-agent")) {
            let marker = read_marker(&root);

            if usable_root(&root) {
                if let Some(bin) = venv_hermes(&root) {
                    let version = probe_version(&bin).await;

                    // A venv hermes that cannot answer --version is a broken
                    // install, not a usable one; fall through and keep looking.
                    if version.is_some() {
                        return LocalInstall {
                            kind: InstallKind::Managed,
                            root: Some(root.to_string_lossy().to_string()),
                            command: Some(bin.to_string_lossy().to_string()),
                            version,
                            has_marker: marker.is_some(),
                        };
                    }
                }
            }
        }

        // Rung 3: what the user's login shell would run.
        if let Some(path) = login_shell_hermes().await {
            if let Some(version) = probe_version(&path).await {
                return LocalInstall {
                    kind: InstallKind::Path,
                    root: None,
                    command: Some(path.to_string_lossy().to_string()),
                    version: Some(version),
                    has_marker: false,
                };
            }
        }

        // Rung 4: well-known locations.
        for candidate in fallback_candidates(home_dir().as_deref(), hermes_home.as_deref()) {
            if !candidate.is_file() {
                continue;
            }

            if let Some(version) = probe_version(&candidate).await {
                return LocalInstall {
                    kind: InstallKind::Path,
                    root: None,
                    command: Some(candidate.to_string_lossy().to_string()),
                    version: Some(version),
                    has_marker: false,
                };
            }
        }

        LocalInstall::none()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn marker(schema: serde_json::Value, commit: serde_json::Value) -> serde_json::Value {
        serde_json::json!({ "schemaVersion": schema, "pinnedCommit": commit })
    }

    #[test]
    fn accepts_a_well_formed_marker() {
        assert!(marker_is_valid(&marker(
            serde_json::json!(1),
            serde_json::json!("abc1234")
        )));
    }

    #[test]
    fn rejects_a_short_commit() {
        // 7 chars is the shortest real abbreviated SHA; 6 is a typo or a stub.
        assert!(!marker_is_valid(&marker(
            serde_json::json!(1),
            serde_json::json!("abc123")
        )));
    }

    #[test]
    fn rejects_a_future_or_missing_schema_version() {
        assert!(!marker_is_valid(&marker(
            serde_json::json!(2),
            serde_json::json!("abc1234")
        )));
        assert!(!marker_is_valid(&serde_json::json!({
            "pinnedCommit": "abc1234"
        })));
    }

    #[test]
    fn rejects_a_non_object_or_empty_marker() {
        assert!(!marker_is_valid(&serde_json::json!([1, 2, 3])));
        assert!(!marker_is_valid(&serde_json::json!({})));
    }

    #[test]
    fn reads_no_marker_from_a_missing_or_corrupt_file() {
        let dir = std::env::temp_dir().join("hermes-detect-marker");

        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("mkdir");

        assert!(read_marker(&dir).is_none(), "absent file");

        std::fs::write(dir.join(MARKER_FILE), "{not json").expect("seed");
        assert!(read_marker(&dir).is_none(), "corrupt file");

        std::fs::write(
            dir.join(MARKER_FILE),
            r#"{"schemaVersion":1,"pinnedCommit":"abc1234"}"#,
        )
        .expect("seed");
        assert!(read_marker(&dir).is_some(), "valid file");
    }

    #[test]
    fn a_root_without_the_cli_entrypoint_is_not_usable() {
        let dir = std::env::temp_dir().join("hermes-detect-root");

        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("mkdir");

        // An empty directory, and a marker beside it, are both insufficient —
        // this is the "marker present but tree unusable" case.
        std::fs::write(
            dir.join(MARKER_FILE),
            r#"{"schemaVersion":1,"pinnedCommit":"abc1234"}"#,
        )
        .expect("seed");

        assert!(!usable_root(&dir));
        assert!(read_marker(&dir).is_some());
    }

    #[test]
    fn fallbacks_lead_with_the_managed_venv() {
        let home = PathBuf::from("/home/u");
        let hermes_home = std::env::temp_dir().join("hermes-detect-fallback");
        let root = hermes_home.join("hermes-agent");
        let bin_dir = if cfg!(target_os = "windows") {
            root.join("venv").join("Scripts")
        } else {
            root.join("venv").join("bin")
        };

        let _ = std::fs::remove_dir_all(&hermes_home);
        std::fs::create_dir_all(&bin_dir).expect("mkdir");
        std::fs::write(
            bin_dir.join(if cfg!(target_os = "windows") {
                "hermes.exe"
            } else {
                "hermes"
            }),
            "",
        )
        .expect("seed");

        let candidates = fallback_candidates(Some(&home), Some(&hermes_home));

        assert!(
            candidates[0].starts_with(&hermes_home),
            "managed venv should be tried before anything user-global: {candidates:?}"
        );
    }

    #[test]
    fn fallbacks_tolerate_unknown_home_dirs() {
        // Neither path is knowable in a sandbox; the ladder must still produce a
        // list rather than panicking on an unwrap.
        let candidates = fallback_candidates(None, None);

        assert_eq!(candidates.is_empty(), cfg!(target_os = "windows"));
    }

    #[test]
    fn version_output_is_reduced_to_one_meaningful_line() {
        assert_eq!(
            first_line("\n\n  hermes 1.2.3  \n"),
            Some("hermes 1.2.3".into())
        );
        assert_eq!(first_line("   \n  "), None);
        assert_eq!(first_line(""), None);
    }
}
