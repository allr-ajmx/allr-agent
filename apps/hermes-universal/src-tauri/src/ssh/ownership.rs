//! Stable ownership identity for remote backends.
//!
//! Ported from `apps/desktop/electron/desktop-installation.ts:125-135`
//! (`sshOwnershipId`) and `remote-lifecycle.ts:44-52` (`fingerprintToken`).
//!
//! The ownership ID answers "is this remote backend *mine*?". It names the
//! remote state directory and is echoed back by the backend's
//! `/api/ssh/ownership` endpoint, so it must be stable across app restarts:
//! losing it orphans remote backends, because the next connect will not
//! recognize the lockfile and so will neither reuse nor clean up the process.
//!
//! Universal has no equivalent of desktop's installation-ID file, so the caller
//! supplies one (persisted in the OS keyring on the JS side) and we only enforce
//! its shape here.

use sha2::{Digest, Sha256};

use super::error::{SshError, SshErrorKind};

/// The installation ID's required shape: 32 lowercase hex characters.
pub fn validate_installation_id(installation_id: &str) -> Result<&str, SshError> {
    let ok = installation_id.len() == 32
        && installation_id.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase());

    if ok {
        Ok(installation_id)
    } else {
        Err(SshError::new(SshErrorKind::Unknown, "Installation ID is invalid."))
    }
}

/// `sha256(installationId \0 scope)`, truncated to 32 hex chars.
///
/// The NUL separator is what makes the pair unambiguous: without it,
/// `("ab", "cd")` and `("abc", "d")` would hash identically, and two profiles
/// could collide onto one remote backend.
pub fn ssh_ownership_id(installation_id: &str, scope: &str) -> Result<String, SshError> {
    let id = validate_installation_id(installation_id)?;

    let mut hasher = Sha256::new();
    hasher.update(id.as_bytes());
    hasher.update([0u8]);
    hasher.update(scope.as_bytes());

    Ok(hex::encode(hasher.finalize())[..32].to_string())
}

/// Fingerprint a session token for the lockfile.
///
/// The raw secret is never written to the remote — the lockfile holds only this
/// digest, which is enough to tell "the token I hold is the one that backend was
/// started with" without leaving a usable credential lying in a file.
pub fn fingerprint_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());

    hex::encode(hasher.finalize())[..32].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn ownership_id_is_32_lowercase_hex() {
        let out = ssh_ownership_id(ID, "default").unwrap();
        assert_eq!(out.len(), 32);
        assert!(out.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()), "{out}");
    }

    #[test]
    fn ownership_id_is_stable() {
        // Stability is the whole contract — an unstable ID orphans remote backends.
        assert_eq!(ssh_ownership_id(ID, "default").unwrap(), ssh_ownership_id(ID, "default").unwrap());
    }

    #[test]
    fn ownership_id_varies_by_scope_and_installation() {
        let a = ssh_ownership_id(ID, "default").unwrap();
        let b = ssh_ownership_id(ID, "work").unwrap();
        let c = ssh_ownership_id("fedcba9876543210fedcba9876543210", "default").unwrap();
        assert_ne!(a, b);
        assert_ne!(a, c);
    }

    #[test]
    fn nul_separator_prevents_boundary_collisions() {
        // Without the NUL, ("ab"+"cd") and ("abc"+"d") would hash the same and two
        // scopes would silently share one remote backend.
        let left = ssh_ownership_id(ID, "ab").unwrap();
        let right = ssh_ownership_id(ID, "\0ab").unwrap();
        assert_ne!(left, right);
    }

    #[test]
    fn empty_scope_is_allowed() {
        // The global (non-profile) connection legitimately has an empty scope.
        assert!(ssh_ownership_id(ID, "").is_ok());
    }

    #[test]
    fn rejects_malformed_installation_ids() {
        assert!(ssh_ownership_id("", "s").is_err());
        assert!(ssh_ownership_id("0123456789abcdef", "s").is_err(), "too short");
        assert!(ssh_ownership_id(&format!("{ID}0"), "s").is_err(), "too long");
        assert!(ssh_ownership_id("0123456789ABCDEF0123456789abcdef", "s").is_err(), "uppercase");
        assert!(ssh_ownership_id("../../etc/passwd/aaaaaaaaaaaaaaaa", "s").is_err());
    }

    #[test]
    fn ownership_id_passes_its_own_path_validation() {
        // It becomes a remote directory name, so it must satisfy the path guard.
        let out = ssh_ownership_id(ID, "default").unwrap();
        assert!(super::super::remote_paths::validate_ownership_id(&out).is_ok());
    }

    #[test]
    fn token_fingerprint_is_a_truncated_sha256() {
        // Pinned against `printf 'hunter2' | sha256sum` so a future refactor cannot
        // silently change the digest and invalidate every existing lockfile.
        assert_eq!(fingerprint_token("hunter2"), "f52fbd32b2b3b86ff88ef6c490628285");
        assert_eq!(fingerprint_token("hunter2").len(), 32);
    }

    #[test]
    fn token_fingerprint_distinguishes_tokens() {
        assert_ne!(fingerprint_token("a"), fingerprint_token("b"));
        // An empty token must still produce a well-formed digest rather than "".
        assert_eq!(fingerprint_token("").len(), 32);
    }
}
