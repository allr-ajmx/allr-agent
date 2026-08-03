//! Connect-progress reporting.
//!
//! New work. The Electron desktop app emitted nothing during a connect, and got
//! away with it: on a laptop the whole sequence is quick and the window is
//! already full of UI. Ours can take 45–90 seconds on a first connect — platform
//! probe, `hermes` discovery, capability check, token upload, spawn, then
//! waiting for the backend to bind — and a phone showing a motionless spinner
//! for that long is indistinguishable from a hang.
//!
//! Events follow `transport.rs`'s `ws://{id}/…` convention, including its
//! contract: the caller generates the id and subscribes **before** invoking, so
//! no step is missed.

use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Where a connect has got to. Ordered as the lifecycle runs them, so the UI can
/// render a determinate progress bar rather than a spinner.
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SshStep {
    /// Opening the TCP connection and verifying the host key.
    Connecting,
    Authenticating,
    ProbingPlatform,
    LocatingHermes,
    /// Reading the lockfile to see whether a backend of ours is already running.
    CheckingExisting,
    UploadingToken,
    Spawning,
    /// Waiting for the remote backend to announce its port.
    WaitingReady,
    Forwarding,
    /// Proving, over the tunnel, that the backend really is ours.
    Verifying,
}

impl SshStep {
    /// 0.0–1.0, for a determinate progress indicator. Approximate by nature:
    /// `WaitingReady` dominates a cold start and `CheckingExisting` may end the
    /// sequence early on a reuse.
    pub fn fraction(self) -> f32 {
        match self {
            Self::Connecting => 0.05,
            Self::Authenticating => 0.15,
            Self::ProbingPlatform => 0.25,
            Self::LocatingHermes => 0.35,
            Self::CheckingExisting => 0.45,
            Self::UploadingToken => 0.55,
            Self::Spawning => 0.65,
            Self::WaitingReady => 0.80,
            Self::Forwarding => 0.90,
            Self::Verifying => 0.95,
        }
    }
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SshProgress {
    pub step: SshStep,
    pub fraction: f32,
    /// Free text for the step, e.g. the resolved `hermes` path. Already
    /// redacted by the caller when it could carry a secret.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// Emits progress for one connect attempt.
///
/// Cloneable and cheap so the lifecycle can hand it down without threading an
/// `AppHandle` through every function.
#[derive(Clone)]
pub struct ProgressReporter {
    app: Option<AppHandle>,
    attempt_id: String,
}

impl ProgressReporter {
    pub fn new(app: AppHandle, attempt_id: impl Into<String>) -> Self {
        Self { app: Some(app), attempt_id: attempt_id.into() }
    }

    /// A reporter that drops everything — for tests and for any path with no UI
    /// attached.
    pub fn silent() -> Self {
        Self { app: None, attempt_id: String::new() }
    }

    pub fn event_name(&self) -> String {
        format!("ssh://{}/progress", self.attempt_id)
    }

    pub fn step(&self, step: SshStep) {
        self.emit(step, None);
    }

    pub fn step_with(&self, step: SshStep, detail: impl Into<String>) {
        self.emit(step, Some(detail.into()));
    }

    fn emit(&self, step: SshStep, detail: Option<String>) {
        let Some(app) = &self.app else {
            return;
        };

        let payload = SshProgress {
            step,
            fraction: step.fraction(),
            // Progress text is user-visible and log-adjacent; a step detail that
            // happened to carry a token would leak it into both.
            detail: detail.map(|d| super::error::redact_secrets(&d)),
        };

        // Best-effort: a dropped progress event must never fail a connect.
        let _ = app.emit(&self.event_name(), payload);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fractions_increase_monotonically_in_lifecycle_order() {
        // The UI renders these as a progress bar; a bar that goes backwards
        // reads as a retry that did not happen.
        let steps = [
            SshStep::Connecting,
            SshStep::Authenticating,
            SshStep::ProbingPlatform,
            SshStep::LocatingHermes,
            SshStep::CheckingExisting,
            SshStep::UploadingToken,
            SshStep::Spawning,
            SshStep::WaitingReady,
            SshStep::Forwarding,
            SshStep::Verifying,
        ];

        for pair in steps.windows(2) {
            assert!(
                pair[0].fraction() < pair[1].fraction(),
                "{:?} must precede {:?}",
                pair[0],
                pair[1]
            );
        }

        assert!(steps[0].fraction() > 0.0);
        assert!(steps[steps.len() - 1].fraction() < 1.0, "completion is the caller's to signal");
    }

    #[test]
    fn steps_serialize_as_kebab_case() {
        assert_eq!(serde_json::to_string(&SshStep::WaitingReady).unwrap(), "\"waiting-ready\"");
        assert_eq!(serde_json::to_string(&SshStep::ProbingPlatform).unwrap(), "\"probing-platform\"");
    }

    #[test]
    fn the_event_name_follows_the_transport_convention() {
        // Same shape as transport.rs's ws://{id}/… events, so the JS side can
        // reuse its subscribe-before-invoke helper.
        let reporter = ProgressReporter { app: None, attempt_id: "abc-123".into() };
        assert_eq!(reporter.event_name(), "ssh://abc-123/progress");
    }

    #[test]
    fn a_silent_reporter_never_panics() {
        // Used by every test and by any path with no window attached.
        let reporter = ProgressReporter::silent();
        reporter.step(SshStep::Connecting);
        reporter.step_with(SshStep::Spawning, "hermes at /usr/local/bin/hermes");
    }

    #[test]
    fn detail_is_redacted() {
        // Progress text reaches the UI and the log; a step detail carrying a
        // token would leak it into both.
        let progress = SshProgress {
            step: SshStep::Spawning,
            fraction: SshStep::Spawning.fraction(),
            detail: Some(super::super::error::redact_secrets("spawn with token=hunter2")),
        };

        assert_eq!(progress.detail.as_deref(), Some("spawn with token=<redacted>"));
    }
}
