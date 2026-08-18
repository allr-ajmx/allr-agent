//! Wire types for the local-install flow.
//!
//! Two protocols meet here and must not be confused:
//!
//! 1. The **install-script contract** — `Manifest` and `StageResultPayload` are
//!    parsed out of `scripts/install.{sh,ps1}` stdout. Their field names and
//!    semantics are owned by those scripts (`install.sh:315` `emit_manifest`,
//!    `install.sh:336` `emit_stage_json`, documented in `install.ps1:3957-3997`).
//!    Change them only in lockstep with the scripts.
//! 2. The **app's own event stream** — `InstallEvent`, emitted to the webview.
//!
//! Both mirror `apps/bootstrap-installer/src-tauri/src/events.rs`, which already
//! drives this same script protocol from Rust in Tauri. Kept structurally
//! identical so the two can be read side by side.

use serde::{Deserialize, Serialize};

/// One stage as reported by `--manifest`.
///
/// `title` is display copy supplied by the script, which is why the UI renders it
/// verbatim and does not translate stage names: the stage list is owned by the
/// installer, and a locale table here would silently drift out of date the moment
/// the script gained a stage.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct StageInfo {
    pub name: String,
    pub title: String,
    #[serde(default)]
    pub category: String,
    /// `setup` and `gateway`. These are still INVOKED — the script's own
    /// `--non-interactive` handler answers `skipped: true`. Filtering them
    /// client-side would fork the decision away from its single source of truth.
    #[serde(alias = "needsUserInput", default, rename = "needs_user_input")]
    pub needs_user_input: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Manifest {
    pub stages: Vec<StageInfo>,
    #[serde(alias = "protocolVersion", default, rename = "protocol_version")]
    pub protocol_version: Option<u32>,
}

/// The result frame a `--stage <name> --json` run prints last.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct StageResultPayload {
    pub stage: String,
    pub ok: bool,
    #[serde(default)]
    pub skipped: bool,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StageState {
    Running,
    Succeeded,
    Skipped,
    Failed,
}

/// Which pipe a log line came from.
///
/// Reported as metadata rather than folded into one stream because uv, pip, git
/// and npm all write ordinary progress to stderr by design. The UI styles stderr
/// subtly; treating it as failure would paint a healthy install red.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LogStream {
    Stdout,
    Stderr,
}

/// Events emitted on `hermes-install://{install_id}/event`.
///
/// One channel, `type`-tagged — the house convention for streamed work
/// (`ssh/progress.rs`, `pty.rs`): the JS caller mints the id and subscribes
/// BEFORE invoking, so nothing can be missed between spawn and first listen.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "lowercase", tag = "type")]
pub enum InstallEvent {
    /// Once, up front: the full stage list, so the UI can render the whole
    /// ladder as pending rather than growing it one row at a time.
    Manifest {
        stages: Vec<StageInfo>,
        #[serde(rename = "protocolVersion")]
        protocol_version: Option<u32>,
    },
    Stage {
        name: String,
        state: StageState,
        #[serde(rename = "durationMs", skip_serializing_if = "Option::is_none")]
        duration_ms: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    Log {
        #[serde(skip_serializing_if = "Option::is_none")]
        stage: Option<String>,
        line: String,
        stream: LogStream,
    },
    Complete {
        #[serde(rename = "installRoot")]
        install_root: String,
        marker: Option<serde_json::Value>,
    },
    Failed {
        #[serde(skip_serializing_if = "Option::is_none")]
        stage: Option<String>,
        error: String,
    },
}

impl InstallEvent {
    pub fn channel(install_id: &str) -> String {
        format!("hermes-install://{install_id}/event")
    }
}
