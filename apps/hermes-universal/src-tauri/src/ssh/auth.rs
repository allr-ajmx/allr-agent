//! The client-authentication ladder.
//!
//! New work — the Electron desktop app ran the system `ssh` with
//! `BatchMode=yes`, which meant it could never prompt: a passphrase-protected
//! key that was not already in an agent was simply `auth-failed`, and the error
//! copy told the user to run `ssh-add` first. Speaking SSH ourselves means we
//! can actually ask, so passphrase, password and keyboard-interactive auth all
//! become reachable.
//!
//! Rungs are tried in this order, and a rung that is merely *unavailable* is
//! skipped rather than failing the ladder — that distinction is what lets the
//! same code path serve a desktop with an agent and a phone with a pasted key:
//!
//!   1. **ssh-agent** — desktop only in practice. Android is `cfg(unix)` so this
//!      compiles there, but `SSH_AUTH_SOCK` is unset, so it skips itself.
//!   2. **Key file** — an explicit `keyPath`, then `IdentityFile` from
//!      `~/.ssh/config`, then the conventional `~/.ssh/id_*` names.
//!   3. **Pasted key** — a PEM held in the OS keyring. The mobile path: there is
//!      no usable file picker for a private key on Android or iOS.
//!   4. **Password**, then **keyboard-interactive**.

use russh::client::Handle;
use russh::keys::{HashAlg, PrivateKey, PrivateKeyWithHashAlg, PublicKey};

use super::error::{SshError, SshErrorKind};
use super::prompt::{PromptKind, Prompter};
use super::session::SshHandler;

/// Conventional private-key names, in the order OpenSSH itself prefers.
const DEFAULT_KEY_NAMES: [&str; 4] = ["id_ed25519", "id_ecdsa", "id_rsa", "id_dsa"];

/// Credentials the caller has up front. Everything here is optional; whatever is
/// missing is either prompted for or skipped.
#[derive(Default, Clone)]
pub struct Credentials {
    /// An explicit private-key file, from the settings form.
    pub key_path: Option<String>,
    /// `IdentityFile` as resolved from `~/.ssh/config`.
    pub identity_file: Option<String>,
    /// A PEM pasted by the user, held in the keyring. Never written to disk.
    pub private_key_pem: Option<String>,
    pub passphrase: Option<String>,
    pub password: Option<String>,
}

impl Credentials {
    /// True when nothing here could satisfy a server without prompting. Used to
    /// decide whether a non-interactive context (boot restore) can even try.
    pub fn is_empty(&self) -> bool {
        self.key_path.is_none()
            && self.identity_file.is_none()
            && self.private_key_pem.is_none()
            && self.password.is_none()
    }
}

/// Which rung succeeded. Reported so the UI can say how it got in, and so a
/// reconnect can favour the same route.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthMethodUsed {
    Agent,
    KeyFile,
    PastedKey,
    Password,
    KeyboardInteractive,
}

/// Candidate key files, in preference order, deduplicated.
///
/// Explicit beats config beats convention. An explicit path that does not exist
/// is still returned: failing with "that key is not there" is far better than
/// silently authenticating as somebody else via a default key.
pub fn key_file_candidates(creds: &Credentials, home: Option<&std::path::Path>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push = |value: Option<String>| {
        if let Some(v) = value.filter(|v: &String| !v.trim().is_empty()) {
            if !out.contains(&v) {
                out.push(v);
            }
        }
    };

    push(creds.key_path.clone());
    push(creds.identity_file.clone());

    if let Some(home) = home {
        for name in DEFAULT_KEY_NAMES {
            push(Some(home.join(".ssh").join(name).display().to_string()));
        }
    }

    out
}

/// Load a private key, prompting for a passphrase only if one is needed.
///
/// The two-attempt shape is deliberate: most keys are unencrypted, and asking
/// for a passphrase that is not required would be a confusing prompt.
async fn load_key(
    path: &str,
    creds: &Credentials,
    prompter: &dyn Prompter,
) -> Result<Option<PrivateKey>, SshError> {
    match russh::keys::load_secret_key(path, creds.passphrase.as_deref()) {
        Ok(key) => Ok(Some(key)),

        Err(russh::keys::Error::KeyIsEncrypted) => {
            let passphrase = prompter
                .prompt(PromptKind::Passphrase, &format!("Passphrase for {path}"))
                .await?;

            russh::keys::load_secret_key(path, Some(&passphrase))
                .map(Some)
                .map_err(|e| SshError::new(SshErrorKind::AuthFailed, format!("Could not decrypt {path}: {e}")))
        }

        // A key that is absent or unreadable is not a failure of the ladder —
        // the conventional `~/.ssh/id_*` names mostly do not exist. Move on.
        Err(_) => Ok(None),
    }
}

/// Try one private key against the server.
async fn try_key(
    handle: &mut Handle<SshHandler>,
    user: &str,
    key: PrivateKey,
) -> Result<bool, SshError> {
    // RSA keys must be signed with a hash the server actually accepts: SHA-1
    // RSA is rejected outright by any current OpenSSH, so ask the server which
    // it wants rather than guessing. Non-RSA keys ignore this.
    let hash_alg = best_rsa_hash(handle, &key).await;

    let with_hash = PrivateKeyWithHashAlg::new(std::sync::Arc::new(key), hash_alg);

    handle
        .authenticate_publickey(user, with_hash)
        .await
        .map(|r| r.success())
        .map_err(|e| SshError::new(SshErrorKind::AuthFailed, format!("Public-key authentication failed: {e}")))
}

/// Ask the server which RSA signature hash it supports, defaulting to SHA-512.
async fn best_rsa_hash(handle: &Handle<SshHandler>, key: &PrivateKey) -> Option<HashAlg> {
    if !matches!(key.algorithm(), russh::keys::Algorithm::Rsa { .. }) {
        return None;
    }

    handle.best_supported_rsa_hash().await.ok().flatten().unwrap_or(Some(HashAlg::Sha512))
}

/// Walk the ladder. Returns which rung got in, or an `AuthFailed` naming what
/// was tried — a bare "authentication failed" is not actionable.
pub async fn authenticate(
    handle: &mut Handle<SshHandler>,
    user: &str,
    creds: &Credentials,
    home: Option<&std::path::Path>,
    prompter: &dyn Prompter,
) -> Result<AuthMethodUsed, SshError> {
    let mut attempted: Vec<&str> = Vec::new();

    // 1. ssh-agent. Unavailable is not failure: on mobile there is no agent, and
    //    on desktop the user may simply not run one.
    match try_agent(handle, user).await {
        Ok(true) => return Ok(AuthMethodUsed::Agent),
        Ok(false) => attempted.push("ssh-agent"),
        Err(_) => {}
    }

    // 2. Key files.
    for path in key_file_candidates(creds, home) {
        if let Some(key) = load_key(&path, creds, prompter).await? {
            if try_key(handle, user, key).await? {
                return Ok(AuthMethodUsed::KeyFile);
            }

            attempted.push("key file");
        }
    }

    // 3. A pasted PEM from the keyring — the mobile route.
    if let Some(pem) = creds.private_key_pem.as_deref().filter(|p| !p.trim().is_empty()) {
        let key = match russh::keys::decode_secret_key(pem, creds.passphrase.as_deref()) {
            Ok(key) => key,
            Err(russh::keys::Error::KeyIsEncrypted) => {
                let passphrase = prompter.prompt(PromptKind::Passphrase, "Passphrase for the stored key").await?;

                russh::keys::decode_secret_key(pem, Some(&passphrase)).map_err(|e| {
                    SshError::new(SshErrorKind::AuthFailed, format!("Could not decrypt the stored key: {e}"))
                })?
            }
            Err(e) => {
                return Err(SshError::new(
                    SshErrorKind::AuthFailed,
                    format!("The stored private key could not be read: {e}"),
                ))
            }
        };

        if try_key(handle, user, key).await? {
            return Ok(AuthMethodUsed::PastedKey);
        }

        attempted.push("stored key");
    }

    // 4. Password. Prompt only when the server actually offers it.
    if let Some(password) = resolve_password(creds, prompter).await? {
        let ok = handle
            .authenticate_password(user, password)
            .await
            .map(|r| r.success())
            .map_err(|e| SshError::new(SshErrorKind::AuthFailed, format!("Password authentication failed: {e}")))?;

        if ok {
            return Ok(AuthMethodUsed::Password);
        }

        attempted.push("password");
    }

    Err(SshError::new(
        SshErrorKind::AuthFailed,
        format!(
            "SSH authentication as {user} failed. Tried: {}. Add the key to your ssh-agent, \
             set an IdentityFile in ~/.ssh/config, or supply a key in Settings.",
            if attempted.is_empty() { "nothing available".to_string() } else { attempted.join(", ") }
        ),
    ))
}

/// The password to try, from the caller or from a prompt.
async fn resolve_password(creds: &Credentials, prompter: &dyn Prompter) -> Result<Option<String>, SshError> {
    if let Some(p) = creds.password.as_deref().filter(|p| !p.is_empty()) {
        return Ok(Some(p.to_string()));
    }

    match prompter.prompt(PromptKind::Password, "Password").await {
        Ok(p) if !p.is_empty() => Ok(Some(p)),
        // No prompter (a boot restore, say) simply means this rung is skipped.
        _ => Ok(None),
    }
}

/// Try every identity the agent holds.
#[cfg(unix)]
async fn try_agent(handle: &mut Handle<SshHandler>, user: &str) -> Result<bool, SshError> {
    use russh::keys::agent::client::AgentClient;

    // No SSH_AUTH_SOCK, or nothing listening on it: this rung does not exist.
    let mut agent = AgentClient::connect_env()
        .await
        .map_err(|e| SshError::new(SshErrorKind::AuthFailed, format!("No usable ssh-agent: {e}")))?;

    let identities = agent
        .request_identities()
        .await
        .map_err(|e| SshError::new(SshErrorKind::AuthFailed, format!("Could not list agent identities: {e}")))?;

    for identity in identities {
        let public: PublicKey = match &identity {
            russh::keys::agent::AgentIdentity::PublicKey { key, .. } => key.clone(),
            // Certificates are a different auth shape; not supported yet.
            _ => continue,
        };

        let hash_alg = if matches!(public.algorithm(), russh::keys::Algorithm::Rsa { .. }) {
            handle.best_supported_rsa_hash().await.ok().flatten().unwrap_or(Some(HashAlg::Sha512))
        } else {
            None
        };

        if let Ok(result) = handle.authenticate_publickey_with(user, public, hash_alg, &mut agent).await {
            if result.success() {
                return Ok(true);
            }
        }
    }

    Ok(false)
}

/// Windows OpenSSH exposes its agent over a named pipe rather than
/// `SSH_AUTH_SOCK`; russh's agent client does not cover that here, so the rung
/// is absent rather than broken.
#[cfg(not(unix))]
async fn try_agent(_handle: &mut Handle<SshHandler>, _user: &str) -> Result<bool, SshError> {
    Err(SshError::new(SshErrorKind::AuthFailed, "ssh-agent is not available on this platform."))
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    fn home() -> PathBuf {
        PathBuf::from("/home/u")
    }

    #[test]
    fn candidates_prefer_explicit_then_config_then_convention() {
        let creds = Credentials {
            key_path: Some("/keys/explicit".into()),
            identity_file: Some("/keys/from-config".into()),
            ..Default::default()
        };

        let out = key_file_candidates(&creds, Some(&home()));
        assert_eq!(out[0], "/keys/explicit");
        assert_eq!(out[1], "/keys/from-config");
        assert_eq!(out[2], "/home/u/.ssh/id_ed25519", "ed25519 before rsa, as OpenSSH prefers");
        assert!(out.contains(&"/home/u/.ssh/id_rsa".to_string()));
    }

    #[test]
    fn candidates_are_deduplicated() {
        // The settings form and ~/.ssh/config commonly name the same file; trying
        // it twice would burn an auth attempt against the server's limit.
        let creds = Credentials {
            key_path: Some("/keys/same".into()),
            identity_file: Some("/keys/same".into()),
            ..Default::default()
        };

        let out = key_file_candidates(&creds, None);
        assert_eq!(out, vec!["/keys/same"]);
    }

    #[test]
    fn candidates_ignore_blank_values() {
        let creds =
            Credentials { key_path: Some("   ".into()), identity_file: Some(String::new()), ..Default::default() };
        assert!(key_file_candidates(&creds, None).is_empty());
    }

    #[test]
    fn candidates_without_a_home_yield_only_explicit_paths() {
        // Mobile: no ~/.ssh to fall back on, so nothing is invented.
        let creds = Credentials { key_path: Some("/keys/explicit".into()), ..Default::default() };
        assert_eq!(key_file_candidates(&creds, None), vec!["/keys/explicit"]);
        assert!(key_file_candidates(&Credentials::default(), None).is_empty());
    }

    #[test]
    fn every_conventional_name_is_offered() {
        let out = key_file_candidates(&Credentials::default(), Some(&home()));
        assert_eq!(out.len(), DEFAULT_KEY_NAMES.len());
        for name in DEFAULT_KEY_NAMES {
            assert!(out.iter().any(|c| c.ends_with(name)), "{name} missing from {out:?}");
        }
    }

    #[test]
    fn is_empty_reflects_whether_a_silent_connect_is_possible() {
        // Drives whether a boot restore may even attempt the dial.
        assert!(Credentials::default().is_empty());
        assert!(!Credentials { key_path: Some("/k".into()), ..Default::default() }.is_empty());
        assert!(!Credentials { private_key_pem: Some("pem".into()), ..Default::default() }.is_empty());
        assert!(!Credentials { password: Some("pw".into()), ..Default::default() }.is_empty());
        // A passphrase alone unlocks nothing — there is no key for it to open.
        assert!(Credentials { passphrase: Some("pp".into()), ..Default::default() }.is_empty());
    }
}
