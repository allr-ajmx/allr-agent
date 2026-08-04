//! Asking the user something mid-connect.
//!
//! New work: the Electron desktop app ran `ssh` with `BatchMode=yes` and so
//! could never prompt. Because we speak SSH ourselves, a passphrase-protected
//! key or a password-only server is now answerable rather than a dead end.
//!
//! This turns a connect from request/response into a conversation, which is why
//! the abstraction exists: the interactive path (the settings configurator) can
//! answer, while a boot restore — which runs before any UI is mounted — must not
//! hang waiting for an answer nobody can give. `NoPrompter` is that second case,
//! and it declines immediately rather than blocking.

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use serde::Serialize;
use tokio::sync::{mpsc, oneshot};

use super::error::{SshError, SshErrorKind};

/// How long a prompt may go unanswered before the attempt gives up.
///
/// Without a cap, a UI that never renders the dialog (a backgrounded app, a
/// dropped event listener) would wedge the session and its lock forever.
pub const PROMPT_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PromptKind {
    Passphrase,
    Password,
    KeyboardInteractive,
}

impl PromptKind {
    /// Whether the answer may be echoed as it is typed. Always false today, but
    /// keyboard-interactive can legitimately ask non-secret questions, so the
    /// UI is told rather than assuming.
    pub fn is_secret(self) -> bool {
        true
    }
}

/// A question awaiting an answer.
pub struct PromptRequest {
    pub kind: PromptKind,
    pub label: String,
    pub respond: oneshot::Sender<String>,
}

/// Something that can answer a question during a connect.
pub trait Prompter: Send + Sync {
    fn prompt<'a>(
        &'a self,
        kind: PromptKind,
        label: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<String, SshError>> + Send + 'a>>;
}

/// Declines everything, immediately.
///
/// The correct prompter for any non-interactive context. Blocking there would
/// hang the boot restore behind a dialog that is never going to appear.
pub struct NoPrompter;

impl Prompter for NoPrompter {
    fn prompt<'a>(
        &'a self,
        _kind: PromptKind,
        _label: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<String, SshError>> + Send + 'a>> {
        Box::pin(async {
            Err(SshError::new(
                SshErrorKind::AuthFailed,
                "This connection needs a passphrase or password. Reconnect from Settings to enter it.",
            ))
        })
    }
}

/// Forwards questions to the UI over a channel and waits for the answer.
pub struct ChannelPrompter {
    tx: mpsc::Sender<PromptRequest>,
    timeout: Duration,
}

impl ChannelPrompter {
    pub fn new(tx: mpsc::Sender<PromptRequest>) -> Self {
        Self { tx, timeout: PROMPT_TIMEOUT }
    }

    pub fn with_timeout(tx: mpsc::Sender<PromptRequest>, timeout: Duration) -> Self {
        Self { tx, timeout }
    }
}

impl Prompter for ChannelPrompter {
    fn prompt<'a>(
        &'a self,
        kind: PromptKind,
        label: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<String, SshError>> + Send + 'a>> {
        Box::pin(async move {
            let (respond, answer) = oneshot::channel();
            let request = PromptRequest { kind, label: label.to_string(), respond };

            if self.tx.send(request).await.is_err() {
                return Err(SshError::new(SshErrorKind::Cancelled, "No prompt listener is attached."));
            }

            match tokio::time::timeout(self.timeout, answer).await {
                Ok(Ok(value)) => Ok(value),
                // The dialog was dismissed.
                Ok(Err(_)) => Err(SshError::new(SshErrorKind::Cancelled, "The prompt was dismissed.")),
                // Nobody ever rendered it. Give up rather than hold the session open.
                Err(_) => Err(SshError::new(SshErrorKind::Timeout, "Timed out waiting for an answer.")),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn no_prompter_declines_without_blocking() {
        // The boot-restore contract: fail fast rather than wait on a UI that is
        // not mounted. If this ever blocks, app startup hangs.
        let err = tokio::time::timeout(
            Duration::from_millis(50),
            NoPrompter.prompt(PromptKind::Passphrase, "Passphrase"),
        )
        .await
        .expect("must not block")
        .expect_err("must decline");

        assert_eq!(err.kind, SshErrorKind::AuthFailed);
        assert!(err.message.contains("Settings"), "the copy must say how to recover: {}", err.message);
    }

    #[tokio::test]
    async fn channel_prompter_round_trips_an_answer() {
        let (tx, mut rx) = mpsc::channel::<PromptRequest>(1);

        tokio::spawn(async move {
            let req = rx.recv().await.expect("a request");
            assert_eq!(req.kind, PromptKind::Passphrase);
            assert_eq!(req.label, "Passphrase for /keys/id");
            let _ = req.respond.send("hunter2".to_string());
        });

        let answer = ChannelPrompter::new(tx).prompt(PromptKind::Passphrase, "Passphrase for /keys/id").await.unwrap();
        assert_eq!(answer, "hunter2");
    }

    #[tokio::test]
    async fn a_dismissed_prompt_is_cancelled_not_a_timeout() {
        let (tx, mut rx) = mpsc::channel::<PromptRequest>(1);

        tokio::spawn(async move {
            // Received and dropped without answering.
            let _ = rx.recv().await;
        });

        let err = ChannelPrompter::new(tx).prompt(PromptKind::Password, "Password").await.unwrap_err();
        assert_eq!(err.kind, SshErrorKind::Cancelled);
    }

    #[tokio::test]
    async fn an_unanswered_prompt_times_out_rather_than_wedging() {
        // A UI that never renders the dialog must not hold the session (and its
        // remote lock) open indefinitely.
        let (tx, _rx) = mpsc::channel::<PromptRequest>(1);
        let prompter = ChannelPrompter::with_timeout(tx, Duration::from_millis(30));

        let err = prompter.prompt(PromptKind::Password, "Password").await.unwrap_err();
        assert_eq!(err.kind, SshErrorKind::Timeout);
    }

    #[tokio::test]
    async fn a_missing_listener_is_cancelled_immediately() {
        let (tx, rx) = mpsc::channel::<PromptRequest>(1);
        drop(rx);

        let err = ChannelPrompter::new(tx).prompt(PromptKind::Password, "Password").await.unwrap_err();
        assert_eq!(err.kind, SshErrorKind::Cancelled);
    }
}
