//! Credential storage, behind an app-owned boundary.
//!
//! Everything secret this app holds — gateway session tokens, the serialized
//! cookie jar, SSH private keys and their passphrases, login passwords, and the
//! OAuth token sets Rust manages itself — goes through here and nowhere else.
//!
//! The boundary is the point. Previously the webview drove the keyring plugin
//! directly, through commands whose account parameter was an arbitrary `String`,
//! granted to six window globs (`main`, `session-*`, `instance-*`, `tile-*`,
//! `sat-*`, `screen`). Any of those webviews could therefore read *any* entry —
//! including the `nativeAuth:<gateway>` bearer and refresh tokens that only
//! `oauth.rs` has business touching. Naming the readable set as a Rust enum, and
//! keeping the OAuth namespace off it entirely, is what closes that.
//!
//! Storage lives in `store`; this module owns *what may be named*.

pub mod error;
pub mod store;

use serde::{Deserialize, Serialize};

// `SecretsErrorKind` stays reachable as `error::SecretsErrorKind`; it rides out
// to the frontend on the serialized error rather than being named here.
pub use error::SecretsError;

/// Everything the webview may name.
///
/// The serde spelling IS the account name (`sshKey`, `installationId`, …), which
/// is what the frontend's own `SecretKey` union has always used — so this is a
/// tightening of who may ask, not a change of where anything is stored.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SecretKey {
    /// A gateway session token.
    Token,
    /// A gateway login password.
    Password,
    /// The serialized session cookie jar.
    Cookies,
    /// An SSH private key, as a PEM. The mobile route — neither Android nor iOS
    /// offers a file picker russh can read a key through.
    SshKey,
    /// Unlocks an encrypted SSH private key.
    SshPassphrase,
    /// An SSH login password.
    SshPassword,
    /// This install's stable id. An identity rather than a credential, but it
    /// belongs in the same store: losing it orphans every remote backend this
    /// install owns, because the next connect will not recognize their lockfile.
    InstallationId,
}

impl SecretKey {
    /// The account this key is stored under.
    pub fn account(self) -> &'static str {
        match self {
            Self::Token => "token",
            Self::Password => "password",
            Self::Cookies => "cookies",
            Self::SshKey => "sshKey",
            Self::SshPassphrase => "sshPassphrase",
            Self::SshPassword => "sshPassword",
            Self::InstallationId => "installationId",
        }
    }

    /// Whether "sign out" should take this with it.
    ///
    /// Everything except the installation id, which is an identity: dropping it
    /// strands whatever remote backends this install still owns, because nothing
    /// else ties their lockfiles to us.
    pub fn is_credential(self) -> bool {
        !matches!(self, Self::InstallationId)
    }

    /// Every key, for a full wipe.
    pub fn all() -> [SecretKey; 7] {
        [
            Self::Token,
            Self::Password,
            Self::Cookies,
            Self::SshKey,
            Self::SshPassphrase,
            Self::SshPassword,
            Self::InstallationId,
        ]
    }
}

/// An entry only Rust may name.
///
/// Deliberately not reachable from IPC: these hold live bearer and refresh
/// tokens, and no webview surface has a reason to read one. Kept in the same
/// service so the user still sees a single credential group they can revoke.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OwnedKey {
    /// One gateway's OAuth token set, scoped by its base URL so two gateways
    /// keep separate sessions.
    NativeAuth,
}

impl OwnedKey {
    fn account(self, scope: &str) -> String {
        match self {
            // Namespaced so it can never collide with a `SecretKey` account.
            Self::NativeAuth => format!("nativeAuth:{}", scope.trim_end_matches('/')),
        }
    }
}

// --------------------------------------------------------------------------
// The Rust API
// --------------------------------------------------------------------------

/// Read one of the webview-nameable secrets.
pub fn read(key: SecretKey) -> Result<Option<String>, SecretsError> {
    store::read(key.account())
}

/// Write one. An empty value deletes rather than storing a blank.
///
/// That equivalence is deliberate and long-standing: the settings form clears a
/// credential by emptying its row, and storing `""` would leave something behind
/// that reads back as a real, wrong credential.
pub fn write(key: SecretKey, value: &str) -> Result<(), SecretsError> {
    if value.is_empty() {
        remove(key)
    } else {
        store::write(key.account(), value)
    }
}

pub fn remove(key: SecretKey) -> Result<(), SecretsError> {
    store::remove(key.account())
}

pub fn read_owned(key: OwnedKey, scope: &str) -> Result<Option<String>, SecretsError> {
    store::read(&key.account(scope))
}

pub fn write_owned(key: OwnedKey, scope: &str, value: &str) -> Result<(), SecretsError> {
    store::write(&key.account(scope), value)
}

pub fn remove_owned(key: OwnedKey, scope: &str) -> Result<(), SecretsError> {
    store::remove(&key.account(scope))
}

/// Whether this machine can store credentials at all.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretsStatus {
    pub available: bool,
    /// Why not, when it is not — shown to the user once, because "your password
    /// was not saved" needs a reason attached to be actionable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

// --------------------------------------------------------------------------
// Commands
// --------------------------------------------------------------------------
//
// Every one of these hops to a blocking pool. Keyring calls are synchronous and
// can genuinely block — Linux goes over D-Bus to another process — and running
// that on an async worker stalls unrelated work behind someone's keychain.

async fn blocking<T, F>(work: F) -> Result<T, SecretsError>
where
    F: FnOnce() -> Result<T, SecretsError> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| SecretsError::store_failed(format!("the keyring task did not finish: {e}")))?
}

#[tauri::command]
pub async fn secrets_get(key: SecretKey) -> Result<Option<String>, SecretsError> {
    blocking(move || read(key)).await
}

#[tauri::command]
pub async fn secrets_set(key: SecretKey, value: String) -> Result<(), SecretsError> {
    blocking(move || write(key, &value)).await
}

#[tauri::command]
pub async fn secrets_delete(key: SecretKey) -> Result<(), SecretsError> {
    blocking(move || remove(key)).await
}

/// Forget every credential, keeping the installation identity.
///
/// One command rather than a delete per key, so a partial wipe cannot be
/// reported as a clean one: the first failure is returned, and the frontend can
/// say so instead of showing "signed out" over credentials that are still there.
#[tauri::command]
pub async fn secrets_clear() -> Result<(), SecretsError> {
    blocking(|| {
        let mut failure = None;

        for key in SecretKey::all() {
            if !key.is_credential() {
                continue;
            }

            // Keep going after a failure — stopping at the first would leave the
            // rest of the credentials behind as well as the one that refused.
            if let Err(err) = remove(key) {
                failure.get_or_insert(err);
            }
        }

        match failure {
            Some(err) => Err(err),
            None => Ok(()),
        }
    })
    .await
}

#[tauri::command]
pub async fn secrets_status() -> SecretsStatus {
    match blocking(|| Ok(store::ensure())).await.unwrap_or_else(Err) {
        Ok(()) => SecretsStatus {
            available: true,
            reason: None,
        },
        Err(err) => SecretsStatus {
            available: false,
            reason: Some(err.message),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accounts_match_what_is_already_stored() {
        // These strings ARE the on-disk account names, and they are what the
        // previous build wrote. Changing one does not migrate a credential, it
        // orphans it — the user is simply signed out with no explanation.
        assert_eq!(SecretKey::Token.account(), "token");
        assert_eq!(SecretKey::SshKey.account(), "sshKey");
        assert_eq!(SecretKey::SshPassphrase.account(), "sshPassphrase");
        assert_eq!(SecretKey::SshPassword.account(), "sshPassword");
        assert_eq!(SecretKey::InstallationId.account(), "installationId");
    }

    #[test]
    fn the_wire_spelling_matches_the_account() {
        // The frontend sends the serde spelling; if the two ever drift, a read
        // silently lands on a different entry.
        for key in SecretKey::all() {
            let wire = serde_json::to_string(&key).unwrap();
            assert_eq!(wire, format!("\"{}\"", key.account()));
        }
    }

    #[test]
    fn the_installation_id_survives_a_sign_out() {
        // It is an identity, not a credential. Dropping it orphans every remote
        // backend this install owns: the next connect will not recognize their
        // lockfiles, so it neither reuses nor cleans them up.
        assert!(!SecretKey::InstallationId.is_credential());
        assert!(SecretKey::Token.is_credential());
        assert!(SecretKey::SshKey.is_credential());
    }

    #[test]
    fn owned_entries_cannot_collide_with_a_named_key() {
        let account = OwnedKey::NativeAuth.account("https://gw.example.com/");
        assert_eq!(account, "nativeAuth:https://gw.example.com");

        for key in SecretKey::all() {
            assert_ne!(account, key.account());
        }
    }

    #[test]
    fn a_round_trip_reads_back_what_was_written() {
        write(SecretKey::SshPassphrase, "hunter2").unwrap();
        assert_eq!(
            read(SecretKey::SshPassphrase).unwrap().as_deref(),
            Some("hunter2")
        );

        // Emptying a form row clears the credential rather than storing a blank
        // that would read back as a real, wrong one.
        write(SecretKey::SshPassphrase, "").unwrap();
        assert_eq!(read(SecretKey::SshPassphrase).unwrap(), None);
    }

    #[test]
    fn a_missing_entry_reads_as_none_rather_than_an_error() {
        remove(SecretKey::Cookies).unwrap();
        assert_eq!(read(SecretKey::Cookies).unwrap(), None);
        // Deleting something already absent is not a failure either.
        remove(SecretKey::Cookies).unwrap();
    }

    #[test]
    fn owned_entries_round_trip_per_scope() {
        write_owned(OwnedKey::NativeAuth, "https://a.example", "token-a").unwrap();
        write_owned(OwnedKey::NativeAuth, "https://b.example", "token-b").unwrap();

        // Two gateways keep separate sessions; one signing out must not take the
        // other with it.
        assert_eq!(
            read_owned(OwnedKey::NativeAuth, "https://a.example")
                .unwrap()
                .as_deref(),
            Some("token-a")
        );

        remove_owned(OwnedKey::NativeAuth, "https://a.example").unwrap();
        assert_eq!(
            read_owned(OwnedKey::NativeAuth, "https://b.example")
                .unwrap()
                .as_deref(),
            Some("token-b")
        );
    }
}
