//! Host-key verification and trust-on-first-use.
//!
//! New work — the Electron desktop app got this free from the system `ssh`
//! client via `StrictHostKeyChecking=accept-new`. We speak SSH ourselves, so the
//! policy is ours to state:
//!
//!   - **A changed key is never accepted.** Not by any policy, not with a
//!     prompt. It is the one signal that distinguishes a reinstalled server from
//!     a machine-in-the-middle, and we cannot tell which, so we fail closed and
//!     say why. This mirrors desktop, which never used `StrictHostKeyChecking=no`.
//!   - An *unknown* host is a different question, and the only one a policy may
//!     answer: learn it (TOFU, desktop's `accept-new`), refuse it, or ask.
//!
//! On mobile there is no `~/.ssh/known_hosts`, so the store lives under the app
//! data directory instead. A missing file always reads as "not known" rather
//! than as an error — that is the normal state on a fresh install.

use std::path::{Path, PathBuf};

use russh::keys::{HashAlg, PublicKey};
use tokio::sync::{mpsc, oneshot};

use super::error::{SshError, SshErrorKind};

/// What the store says about a host key we were offered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostKeyVerdict {
    /// Recorded, and it matches.
    Known,
    /// Nothing recorded for this host.
    Unknown,
    /// Recorded, and it does **not** match. Always fatal.
    Changed { line: usize },
}

/// How to answer an *unknown* host. A changed key is not covered — see the
/// module docs.
pub enum HostKeyPolicy {
    /// Trust on first use: record the key and continue. What desktop did.
    AcceptNew,
    /// Refuse anything not already recorded.
    Strict,
    /// Ask, and record only on an explicit yes.
    Ask(mpsc::Sender<HostKeyPrompt>),
}

/// A request for the user to make the trust decision.
pub struct HostKeyPrompt {
    pub host: String,
    pub port: u16,
    /// The `SHA256:…` fingerprint to show. Never show the raw key — the
    /// fingerprint is what a user can actually compare against.
    pub fingerprint: String,
    pub respond: oneshot::Sender<bool>,
}

/// Render the fingerprint the way `ssh-keygen -l` does, so a user can compare it
/// against what the server's operator published.
pub fn fingerprint(key: &PublicKey) -> String {
    key.fingerprint(HashAlg::Sha256).to_string()
}

/// Where the known-hosts store lives.
///
/// Desktop's `~/.ssh/known_hosts` is preferred so we interoperate with the
/// user's own `ssh`: a host they already trust is not re-asked, and a key we
/// learn is visible to their other tooling. `app_data` is the mobile fallback,
/// where no `~/.ssh` exists.
pub fn store_path(home: Option<&Path>, app_data: Option<&Path>) -> Option<PathBuf> {
    if let Some(home) = home {
        return Some(home.join(".ssh").join("known_hosts"));
    }

    app_data.map(|d| d.join("known_hosts"))
}

/// Look a host key up. A missing store is `Unknown`, not an error.
///
/// This does the comparison itself rather than calling russh's
/// `check_known_hosts_path`, for two reasons — both of which would otherwise
/// produce a **false** machine-in-the-middle alarm, the single worst failure
/// this function can have:
///
///   1. `ssh_key::PublicKey` derives `PartialEq` over its *comment* as well as
///      its key data, so a recorded line carrying a trailing comment would not
///      compare equal to the same key offered by the server. Identity is
///      `key_data()`; the comment is a human label.
///   2. russh reports the first same-algorithm mismatch as a change even when a
///      later recorded line matches. A host may legitimately have several keys
///      of one type recorded, so a match anywhere must win.
pub fn check(host: &str, port: u16, key: &PublicKey, path: &Path) -> HostKeyVerdict {
    // A missing, unreadable or malformed store means nothing is recorded.
    // Reading it as `Known` would be unsafe; reading it as `Changed` would cry
    // wolf on every fresh install.
    let Ok(recorded) = russh::keys::known_hosts::known_host_keys_path(host, port, path) else {
        return HostKeyVerdict::Unknown;
    };

    let mut mismatch_line = None;

    for (line, entry) in recorded {
        if entry.algorithm() != key.algorithm() {
            continue;
        }

        if entry.key_data() == key.key_data() {
            return HostKeyVerdict::Known;
        }

        mismatch_line.get_or_insert(line);
    }

    match mismatch_line {
        Some(line) => HostKeyVerdict::Changed { line },
        None => HostKeyVerdict::Unknown,
    }
}

/// Record a host key. Best-effort by design: failing to persist trust is an
/// annoyance (we ask again next time), not a reason to refuse a connection the
/// user has already approved.
pub fn learn(host: &str, port: u16, key: &PublicKey, path: &Path) -> Result<(), SshError> {
    // Reached through the module: russh re-exports the `check_*` pair at
    // `russh::keys` but not the `learn_*` pair.
    russh::keys::known_hosts::learn_known_hosts_path(host, port, key, path)
        .map_err(|e| SshError::new(SshErrorKind::Unknown, format!("Could not record the host key: {e}")))
}

/// The message shown when a key has changed. Deliberately specific about the two
/// possible causes and about what to do, ported from `ssh-connection.ts:334`.
pub fn changed_key_message(host_label: &str, host: &str, line: usize) -> String {
    format!(
        "The host key for {host_label} has CHANGED since you last connected (known_hosts line {line}). \
         This could be a machine-in-the-middle attack, or the server may have been reinstalled. \
         The connection was refused. If you are certain the change is expected, remove the old key \
         with `ssh-keygen -R {host}` and reconnect."
    )
}

/// Decide whether to accept an offered key, applying `policy` to unknown hosts.
pub async fn decide(
    host: &str,
    port: u16,
    key: &PublicKey,
    path: &Path,
    policy: &HostKeyPolicy,
) -> Result<(), SshError> {
    match check(host, port, key, path) {
        HostKeyVerdict::Known => Ok(()),

        // No policy may override this. See the module docs.
        HostKeyVerdict::Changed { line } => {
            Err(SshError::new(SshErrorKind::HostKeyChanged, changed_key_message(host, host, line)))
        }

        HostKeyVerdict::Unknown => match policy {
            HostKeyPolicy::AcceptNew => {
                // Best-effort: a store we cannot write to must not block a connect.
                let _ = learn(host, port, key, path);
                Ok(())
            }

            HostKeyPolicy::Strict => Err(SshError::new(
                SshErrorKind::HostKeyChanged,
                format!("The host key for {host} is not known ({}).", fingerprint(key)),
            )),

            HostKeyPolicy::Ask(tx) => {
                let (respond, answer) = oneshot::channel();
                let prompt = HostKeyPrompt {
                    host: host.to_string(),
                    port,
                    fingerprint: fingerprint(key),
                    respond,
                };

                if tx.send(prompt).await.is_err() {
                    // Nobody is listening for prompts. Refusing is the only safe
                    // reading — silently accepting would defeat the policy.
                    return Err(SshError::new(
                        SshErrorKind::Cancelled,
                        "No answer was available for the host-key trust prompt.",
                    ));
                }

                match answer.await {
                    Ok(true) => {
                        let _ = learn(host, port, key, path);
                        Ok(())
                    }
                    Ok(false) => Err(SshError::new(
                        SshErrorKind::Cancelled,
                        format!("The host key for {host} was not trusted."),
                    )),
                    Err(_) => Err(SshError::new(
                        SshErrorKind::Cancelled,
                        "The host-key trust prompt was dismissed.",
                    )),
                }
            }
        },
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;

    /// A stable throwaway key pair's public halves. Not credentials — the private
    /// halves were never kept.
    const KEY_A: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOGXTILfYe9/k4y5hfEhEtghgFt9121WP+K8hBJssvoS a";
    const KEY_B: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPtLMxOJZXnO4rJ26bD4yapGzr/hYlcopvvnvm2b8htK b";

    fn key(openssh: &str) -> PublicKey {
        openssh.parse().expect("valid public key")
    }

    /// A scratch known_hosts path that cleans up after itself.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let mut path = std::env::temp_dir();
            path.push(format!("hermes-known-hosts-{name}-{}", std::process::id()));
            let _ = std::fs::remove_file(&path);
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }

        fn write(&self, contents: &str) {
            let mut f = std::fs::File::create(&self.0).unwrap();
            f.write_all(contents.as_bytes()).unwrap();
        }

        fn contents(&self) -> String {
            std::fs::read_to_string(&self.0).unwrap_or_default()
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    #[test]
    fn a_missing_store_reads_as_unknown() {
        // The normal state on a fresh install, and on every phone. It must not
        // surface as an error, or first-run would always fail.
        let missing = Path::new("/nonexistent/hermes/known_hosts");
        assert_eq!(check("box.example", 22, &key(KEY_A), missing), HostKeyVerdict::Unknown);
    }

    #[test]
    fn recognizes_a_recorded_key() {
        let scratch = Scratch::new("known");
        scratch.write(&format!("box.example {}\n", KEY_A));
        assert_eq!(check("box.example", 22, &key(KEY_A), scratch.path()), HostKeyVerdict::Known);
    }

    #[test]
    fn detects_a_changed_key() {
        let scratch = Scratch::new("changed");
        scratch.write(&format!("box.example {}\n", KEY_A));

        // Same host, same algorithm, different key — the MITM signal.
        assert!(
            matches!(check("box.example", 22, &key(KEY_B), scratch.path()), HostKeyVerdict::Changed { .. }),
            "a different key for a recorded host must be Changed, not Unknown"
        );
    }

    #[test]
    fn a_trailing_comment_is_not_a_key_change() {
        // ssh_key::PublicKey compares its comment as well as its key data, so
        // delegating to russh's checker would raise a machine-in-the-middle
        // alarm over a human label. Identity is the key data.
        let scratch = Scratch::new("comment");
        scratch.write(&format!("box.example {} someones-laptop\n", KEY_A));

        let offered: PublicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOGXTILfYe9/k4y5hfEhEtghgFt9121WP+K8hBJssvoS"
            .parse()
            .expect("a server key carries no comment");

        assert_eq!(check("box.example", 22, &offered, scratch.path()), HostKeyVerdict::Known);
    }

    #[test]
    fn a_match_on_any_line_wins_over_an_earlier_mismatch() {
        // A host may legitimately have several keys of one type recorded (a
        // rotation in progress, say). Stopping at the first mismatch would
        // report a change even though we do trust this key.
        let scratch = Scratch::new("multi");
        scratch.write(&format!("box.example {}\nbox.example {}\n", KEY_B, KEY_A));

        assert_eq!(check("box.example", 22, &key(KEY_A), scratch.path()), HostKeyVerdict::Known);
        assert_eq!(check("box.example", 22, &key(KEY_B), scratch.path()), HostKeyVerdict::Known);
    }

    #[test]
    fn an_unrecorded_host_is_unknown_even_when_the_store_has_others() {
        let scratch = Scratch::new("other");
        scratch.write(&format!("other.example {}\n", KEY_A));
        assert_eq!(check("box.example", 22, &key(KEY_A), scratch.path()), HostKeyVerdict::Unknown);
    }

    #[test]
    fn a_nonstandard_port_is_a_distinct_entry() {
        let scratch = Scratch::new("port");
        scratch.write(&format!("[box.example]:2222 {}\n", KEY_A));
        assert_eq!(check("box.example", 2222, &key(KEY_A), scratch.path()), HostKeyVerdict::Known);
        assert_eq!(check("box.example", 22, &key(KEY_A), scratch.path()), HostKeyVerdict::Unknown);
    }

    #[test]
    fn learn_then_check_round_trips() {
        let scratch = Scratch::new("learn");
        assert_eq!(check("box.example", 22, &key(KEY_A), scratch.path()), HostKeyVerdict::Unknown);

        learn("box.example", 22, &key(KEY_A), scratch.path()).unwrap();

        assert_eq!(check("box.example", 22, &key(KEY_A), scratch.path()), HostKeyVerdict::Known);
        assert!(scratch.contents().contains("box.example"), "{}", scratch.contents());
    }

    #[tokio::test]
    async fn accept_new_learns_an_unknown_host() {
        let scratch = Scratch::new("tofu");
        decide("box.example", 22, &key(KEY_A), scratch.path(), &HostKeyPolicy::AcceptNew).await.unwrap();

        // Learned, so a second connect is silent.
        assert_eq!(check("box.example", 22, &key(KEY_A), scratch.path()), HostKeyVerdict::Known);
    }

    #[tokio::test]
    async fn strict_refuses_an_unknown_host_without_learning() {
        let scratch = Scratch::new("strict");
        let err = decide("box.example", 22, &key(KEY_A), scratch.path(), &HostKeyPolicy::Strict)
            .await
            .expect_err("strict must refuse");

        assert_eq!(err.kind, SshErrorKind::HostKeyChanged);
        assert!(err.message.contains("SHA256:"), "the user needs a comparable fingerprint: {}", err.message);
        assert_eq!(check("box.example", 22, &key(KEY_A), scratch.path()), HostKeyVerdict::Unknown);
    }

    #[tokio::test]
    async fn no_policy_can_accept_a_changed_key() {
        // The core invariant. A changed key must be fatal under every policy,
        // including the one that exists to say yes.
        let scratch = Scratch::new("nooverride");
        scratch.write(&format!("box.example {}\n", KEY_A));

        let (tx, mut rx) = mpsc::channel::<HostKeyPrompt>(1);
        tokio::spawn(async move {
            // An eager "yes" that must never be consulted.
            while let Some(p) = rx.recv().await {
                let _ = p.respond.send(true);
            }
        });

        for policy in [HostKeyPolicy::AcceptNew, HostKeyPolicy::Strict, HostKeyPolicy::Ask(tx)] {
            let err = decide("box.example", 22, &key(KEY_B), scratch.path(), &policy)
                .await
                .expect_err("a changed key must always be refused");
            assert_eq!(err.kind, SshErrorKind::HostKeyChanged);
        }

        // ...and the original record is left intact, not overwritten.
        assert_eq!(check("box.example", 22, &key(KEY_A), scratch.path()), HostKeyVerdict::Known);
    }

    #[tokio::test]
    async fn ask_learns_on_yes_and_refuses_on_no() {
        let scratch = Scratch::new("askyes");
        let (tx, mut rx) = mpsc::channel::<HostKeyPrompt>(1);

        tokio::spawn(async move {
            let p = rx.recv().await.expect("a prompt");
            assert!(p.fingerprint.starts_with("SHA256:"), "{}", p.fingerprint);
            assert_eq!(p.host, "box.example");
            let _ = p.respond.send(true);
        });

        decide("box.example", 22, &key(KEY_A), scratch.path(), &HostKeyPolicy::Ask(tx)).await.unwrap();
        assert_eq!(check("box.example", 22, &key(KEY_A), scratch.path()), HostKeyVerdict::Known);

        let scratch = Scratch::new("askno");
        let (tx, mut rx) = mpsc::channel::<HostKeyPrompt>(1);
        tokio::spawn(async move {
            let p = rx.recv().await.expect("a prompt");
            let _ = p.respond.send(false);
        });

        let err = decide("box.example", 22, &key(KEY_A), scratch.path(), &HostKeyPolicy::Ask(tx))
            .await
            .expect_err("a no must refuse");
        assert_eq!(err.kind, SshErrorKind::Cancelled);
        assert_eq!(check("box.example", 22, &key(KEY_A), scratch.path()), HostKeyVerdict::Unknown, "a no must not learn");
    }

    #[tokio::test]
    async fn ask_refuses_when_nobody_is_listening() {
        // A dropped receiver must not silently degrade into "accept".
        let scratch = Scratch::new("nolistener");
        let (tx, rx) = mpsc::channel::<HostKeyPrompt>(1);
        drop(rx);

        let err = decide("box.example", 22, &key(KEY_A), scratch.path(), &HostKeyPolicy::Ask(tx))
            .await
            .expect_err("an unanswerable prompt must refuse");
        assert_eq!(err.kind, SshErrorKind::Cancelled);
    }

    #[tokio::test]
    async fn ask_refuses_when_the_prompt_is_dropped_unanswered() {
        let scratch = Scratch::new("dropped");
        let (tx, mut rx) = mpsc::channel::<HostKeyPrompt>(1);

        tokio::spawn(async move {
            // Receive and drop without answering — a dismissed dialog.
            let _ = rx.recv().await;
        });

        let err = decide("box.example", 22, &key(KEY_A), scratch.path(), &HostKeyPolicy::Ask(tx))
            .await
            .expect_err("a dismissed prompt must refuse");
        assert_eq!(err.kind, SshErrorKind::Cancelled);
    }

    #[test]
    fn fingerprints_render_like_ssh_keygen() {
        let fp = fingerprint(&key(KEY_A));
        assert!(fp.starts_with("SHA256:"), "{fp}");
        assert_ne!(fp, fingerprint(&key(KEY_B)));
    }

    #[test]
    fn store_prefers_the_users_own_ssh_directory() {
        // Interop matters: a host the user already trusts should not be re-asked,
        // and a key we learn should be visible to their other tooling.
        let home = PathBuf::from("/home/u");
        let app = PathBuf::from("/data/app");
        assert_eq!(store_path(Some(&home), Some(&app)).unwrap(), PathBuf::from("/home/u/.ssh/known_hosts"));

        // Mobile: no home, so the app data directory carries it.
        assert_eq!(store_path(None, Some(&app)).unwrap(), PathBuf::from("/data/app/known_hosts"));
        assert!(store_path(None, None).is_none());
    }

    #[test]
    fn changed_key_message_names_the_cause_and_the_fix() {
        let msg = changed_key_message("deploy@box", "box", 3);
        assert!(msg.contains("deploy@box"));
        assert!(msg.contains("ssh-keygen -R box"), "the user needs the exact remedy: {msg}");
        assert!(msg.contains("line 3"));
    }
}
