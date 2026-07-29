//! Quoting and path helpers for strings that reach a remote POSIX shell.
//!
//! Ported from `apps/desktop/electron/remote-lifecycle.ts:35-120` (`shq`,
//! `validateRemotePath`, `expandRemotePath`, and the lock/log path builders).
//!
//! Everything the desktop interpolates into a remote command goes through `shq`.
//! That is the security boundary for the whole SSH lifecycle, so the rules here
//! are ported literally rather than re-derived.

use super::error::{SshError, SshErrorKind};

/// Where per-install SSH state lives on the remote. A literal `~` — it is
/// expanded by the remote shell, not by us.
pub const REMOTE_LOCK_DIR: &str = "~/.hermes/desktop-ssh";

/// Bumped when the desktop↔dashboard reuse contract changes in a way that makes
/// an old running dashboard unsafe to reattach to. A mismatch forces a clean
/// respawn rather than a reuse.
pub const LOCKFILE_SCHEMA_VERSION: u32 = 2;
pub const PROTOCOL_VERSION: u32 = 1;

fn err(message: String) -> SshError {
    SshError::new(SshErrorKind::Unknown, message)
}

/// Single-quote a value for a POSIX shell.
///
/// `'` is closed, escaped, and reopened (`'\''`) — the standard trick, and the
/// only correct one, since a single-quoted shell string has no escape sequences
/// of its own.
pub fn shq(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('\'');

    for ch in value.chars() {
        if ch == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(ch);
        }
    }

    out.push('\'');
    out
}

/// A remote path must be absolute or `~`-rooted, and must not contain NUL,
/// newline or carriage return.
///
/// The relative-path rejection is not stylistic: a bare `hermes` would be
/// resolved against whatever the remote shell's cwd happens to be, which is not
/// something we control or can reason about.
pub fn validate_remote_path(path: &str) -> Result<(), SshError> {
    if path.is_empty() {
        return Err(err("Remote path must not be empty.".to_string()));
    }

    if path.contains(['\0', '\n', '\r']) {
        return Err(err("Unsafe remote path: contains NUL or newline.".to_string()));
    }

    if path == "~" || path.starts_with("~/") || path.starts_with('/') {
        return Ok(());
    }

    Err(err(format!("Remote path must be absolute or start with ~/: \"{path}\"")))
}

/// Quote a remote path, letting the remote shell expand a leading `~`.
///
/// `~` cannot simply be single-quoted — quoting suppresses tilde expansion — so
/// the home part becomes `"$HOME"` and only the remainder is quoted. The result
/// is one shell word in every case.
pub fn expand_remote_path(path: &str) -> Result<String, SshError> {
    validate_remote_path(path)?;

    if path == "~" {
        return Ok("\"$HOME\"".to_string());
    }

    if let Some(rest) = path.strip_prefix('~') {
        // rest starts with '/', so the concatenation is `"$HOME"'/...'`.
        return Ok(format!("\"$HOME\"{}", shq(rest)));
    }

    Ok(shq(path))
}

/// Ownership IDs are the directory name for per-install remote state, so the
/// shape is enforced before it ever reaches a path.
pub fn validate_ownership_id(ownership_id: &str) -> Result<&str, SshError> {
    let ok = ownership_id.len() == 32 && ownership_id.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase());

    if ok {
        Ok(ownership_id)
    } else {
        Err(err("SSH ownership ID is invalid.".to_string()))
    }
}

pub fn validate_spawn_nonce(spawn_nonce: &str) -> Result<&str, SshError> {
    let ok = spawn_nonce.len() == 16 && spawn_nonce.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase());

    if ok {
        Ok(spawn_nonce)
    } else {
        Err(err("SSH spawn nonce is invalid.".to_string()))
    }
}

pub fn ownership_directory(ownership_id: &str) -> Result<String, SshError> {
    Ok(format!("{REMOTE_LOCK_DIR}/{}", validate_ownership_id(ownership_id)?))
}

pub fn lockfile_path(ownership_id: &str) -> Result<String, SshError> {
    Ok(format!("{}/backend.lock.json", ownership_directory(ownership_id)?))
}

pub fn spawn_log_path(ownership_id: &str, spawn_nonce: &str) -> Result<String, SshError> {
    Ok(format!("{}/{}.log", ownership_directory(ownership_id)?, validate_spawn_nonce(spawn_nonce)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    const OWNER: &str = "0123456789abcdef0123456789abcdef";
    const NONCE: &str = "0123456789abcdef";

    #[test]
    fn shq_wraps_plain_values() {
        assert_eq!(shq("hermes"), "'hermes'");
        assert_eq!(shq(""), "''");
    }

    #[test]
    fn shq_escapes_embedded_single_quotes() {
        // The canonical case: close, escape, reopen.
        assert_eq!(shq("it's"), r#"'it'\''s'"#);
        assert_eq!(shq("'"), r#"''\'''"#);
    }

    #[test]
    fn shq_neutralizes_shell_metacharacters() {
        // These must survive as literal text, not as shell syntax.
        for hostile in ["; rm -rf /", "$(whoami)", "`id`", "a && b", "x | y", "$HOME"] {
            let quoted = shq(hostile);
            assert!(quoted.starts_with('\'') && quoted.ends_with('\''));
            assert_eq!(&quoted[1..quoted.len() - 1], hostile, "no quote to escape in {hostile}");
        }
    }

    #[test]
    fn validate_remote_path_accepts_absolute_and_tilde() {
        for good in ["/usr/local/bin/hermes", "~", "~/.local/bin/hermes", "~/x"] {
            assert!(validate_remote_path(good).is_ok(), "{good} should be accepted");
        }
    }

    #[test]
    fn validate_remote_path_rejects_relative_and_control_chars() {
        for bad in ["", "hermes", "./hermes", "../hermes", "bin/hermes"] {
            assert!(validate_remote_path(bad).is_err(), "{bad} should be rejected");
        }
        for bad in ["/usr/bin/her\nmes", "/usr/bin/her\0mes", "/usr/bin/her\rmes", "~/a\nb"] {
            assert!(validate_remote_path(bad).is_err(), "{bad:?} should be rejected");
        }
    }

    #[test]
    fn expand_remote_path_handles_the_three_shapes() {
        assert_eq!(expand_remote_path("~").unwrap(), "\"$HOME\"");
        assert_eq!(expand_remote_path("~/.local/bin/hermes").unwrap(), "\"$HOME\"'/.local/bin/hermes'");
        assert_eq!(expand_remote_path("/usr/local/bin/hermes").unwrap(), "'/usr/local/bin/hermes'");
    }

    #[test]
    fn expand_remote_path_quotes_hostile_paths() {
        // A tilde path still gets everything after ~ single-quoted.
        assert_eq!(expand_remote_path("~/a b/$(id)").unwrap(), "\"$HOME\"'/a b/$(id)'");
        assert_eq!(expand_remote_path("/tmp/a b").unwrap(), "'/tmp/a b'");
    }

    #[test]
    fn expand_remote_path_rejects_what_validate_rejects() {
        assert!(expand_remote_path("hermes").is_err());
        assert!(expand_remote_path("").is_err());
    }

    #[test]
    fn ownership_id_shape_is_enforced() {
        assert!(validate_ownership_id(OWNER).is_ok());
        assert!(validate_ownership_id("").is_err());
        assert!(validate_ownership_id("0123456789abcdef").is_err(), "too short");
        assert!(validate_ownership_id(&format!("{OWNER}0")).is_err(), "too long");
        assert!(validate_ownership_id("0123456789abcdef0123456789abcdeg").is_err(), "non-hex");
        assert!(validate_ownership_id("0123456789ABCDEF0123456789abcdef").is_err(), "uppercase");
        // The reason the shape is enforced at all: it becomes a path segment.
        assert!(validate_ownership_id("../../etc").is_err());
    }

    #[test]
    fn spawn_nonce_shape_is_enforced() {
        assert!(validate_spawn_nonce(NONCE).is_ok());
        assert!(validate_spawn_nonce("0123456789abcde").is_err());
        assert!(validate_spawn_nonce("0123456789abcdefa").is_err());
        assert!(validate_spawn_nonce("../x").is_err());
    }

    #[test]
    fn remote_paths_are_built_under_the_lock_dir() {
        assert_eq!(ownership_directory(OWNER).unwrap(), format!("~/.hermes/desktop-ssh/{OWNER}"));
        assert_eq!(
            lockfile_path(OWNER).unwrap(),
            format!("~/.hermes/desktop-ssh/{OWNER}/backend.lock.json")
        );
        assert_eq!(
            spawn_log_path(OWNER, NONCE).unwrap(),
            format!("~/.hermes/desktop-ssh/{OWNER}/{NONCE}.log")
        );
    }

    #[test]
    fn path_builders_reject_bad_identifiers() {
        assert!(lockfile_path("../../etc/passwd").is_err());
        assert!(spawn_log_path(OWNER, "../x").is_err());
    }
}
