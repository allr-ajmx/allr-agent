//! What can go wrong reaching the OS credential store.

use serde::Serialize;

/// Why an operation on the credential store failed.
///
/// Kept typed rather than stringly so the frontend can tell "this machine has no
/// credential store" — which means we deliberately do not persist anything, and
/// the user must be told once — from "the store is there and refused", which is
/// a transient thing to retry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SecretsErrorKind {
    /// No usable OS credential store on this platform or in this session: a
    /// Linux box with no Secret Service running, an unsupported target.
    Unavailable,
    /// The store exists and refused the operation.
    StoreFailed,
    /// The credential is there, but this device has not been unlocked (or the
    /// user declined). Distinct from a store failure on purpose: the SSH
    /// surfaces render it as "unlock to connect", never as an auth failure —
    /// telling someone their key is wrong when they simply dismissed a Face ID
    /// prompt sends them looking in entirely the wrong place.
    Locked,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretsError {
    pub kind: SecretsErrorKind,
    pub message: String,
}

impl SecretsError {
    pub fn new(kind: SecretsErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::new(SecretsErrorKind::Unavailable, message)
    }

    pub fn store_failed(message: impl Into<String>) -> Self {
        Self::new(SecretsErrorKind::StoreFailed, message)
    }

    pub fn locked(message: impl Into<String>) -> Self {
        Self::new(SecretsErrorKind::Locked, message)
    }
}

impl std::fmt::Display for SecretsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for SecretsError {}
